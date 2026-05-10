/**
 * Research Service — AI-powered stock analysis
 *
 * Uses claude-opus-4-7 with adaptive thinking + prompt caching.
 * Runs continuous research on all holdings so context is pre-loaded;
 * fires on-demand subagent analysis for new tickers.
 *
 * Outputs structured JSON via output_config.format.
 */

import Anthropic from '@anthropic-ai/sdk';
import { cache, TTL } from '../cache/cache.service';
import { logger } from '../logger';
import { financialDatasetsService } from './financialDatasets.service';
import type {
  ResearchContext,
  ScanResult,
  BuySellSignal,
  PortfolioHolding,
  WatchlistEntry,
} from '../../../shared/types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-opus-4-7';

// ---------------------------------------------------------------------------
// System prompt — stable across requests, cached via prompt caching
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Tu es un analyste actions et gérant de portefeuille de premier plan. Ton rôle est de :
1. Construire des thèses fondamentales approfondies sur les actions à partir des données financières, de la dynamique sectorielle et du positionnement concurrentiel.
2. Générer des objectifs de cours précis sur les horizons 1M/3M/6M/12M.
3. Définir des scénarios baissier / central / haussier avec leurs probabilités respectives.
4. Identifier les conditions d'invalidation (kill conditions) — événements ou données spécifiques qui invalideraient la thèse et justifieraient une vente.
5. Évaluer les catalyseurs et les risques avec honnêteté intellectuelle.
6. Produire des signaux buy/hold/sell actionnables avec des scores de conviction.

Ton analyse doit être rigoureuse, concise et à contre-courant si nécessaire. Ne jamais produire de poncifs génériques.
Ancre toujours les objectifs dans les fondamentaux (rendement FCF, VE/EBITDA, PEG, etc.).
Quand les données sont insuffisantes, dis-le explicitement et ajuste ta conviction en conséquence.
Réponds toujours en français.`;

// ---------------------------------------------------------------------------
// JSON schemas for structured output
// ---------------------------------------------------------------------------

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    companyName: { type: 'string' },
    thesis: { type: 'string' },
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', enum: ['bear', 'base', 'bull'] },
          price: { type: 'number' },
          probability: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['label', 'price', 'probability', 'rationale'],
      },
    },
    priceTargets: {
      type: 'object',
      properties: {
        '1M': { type: 'number' },
        '3M': { type: 'number' },
        '6M': { type: 'number' },
        '12M': { type: 'number' },
      },
      required: ['1M', '3M', '6M', '12M'],
    },
    killConditions: { type: 'array', items: { type: 'string' } },
    catalysts: { type: 'array', items: { type: 'string' } },
    newsSummary: { type: 'string' },
    conviction: { type: 'number', minimum: 1, maximum: 10 },
    signal: { type: 'string', enum: ['buy', 'hold', 'reduce', 'sell'] },
  },
  required: ['companyName', 'thesis', 'scenarios', 'priceTargets', 'killConditions', 'catalysts', 'newsSummary', 'conviction', 'signal'],
} as const;

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ticker: { type: 'string' },
          action: { type: 'string', enum: ['buy', 'add', 'hold', 'reduce', 'sell', 'watch'] },
          urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale: { type: 'string' },
          suggestedSizeChangePct: { type: 'number' },
        },
        required: ['ticker', 'action', 'urgency', 'rationale'],
      },
    },
    topConvictions: { type: 'array', items: { type: 'string' } },
    riskFlags: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'signals', 'topConvictions', 'riskFlags'],
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildTickerContext(ticker: string): Promise<string> {
  const [snapshot, history, financials, facts] = await Promise.allSettled([
    financialDatasetsService.getPriceSnapshot(ticker),
    financialDatasetsService.getPriceHistory(ticker, 90),
    financialDatasetsService.getFinancials(ticker),
    financialDatasetsService.getCompanyFacts(ticker),
  ]);

  const snap = snapshot.status === 'fulfilled' ? snapshot.value : null;
  const hist = history.status === 'fulfilled' ? history.value : [];
  const fin = financials.status === 'fulfilled' ? financials.value : null;
  const f = facts.status === 'fulfilled' ? facts.value : null;

  const recentPrices = hist.slice(-10).map((p) => `${p.date}: $${p.close}`).join(', ');
  const latestIncome = fin?.incomeStatements?.[0];
  const latestBalance = fin?.balanceSheets?.[0];
  const latestCash = fin?.cashFlows?.[0];

  return [
    `TICKER: ${ticker}`,
    f ? `Société : ${f.name} | Secteur : ${f.sector ?? 'N/A'} | Industrie : ${f.industry ?? 'N/A'}` : '',
    f?.description ? `Description : ${f.description.slice(0, 400)}` : '',
    snap ? `Cours actuel : $${snap.price} | Capitalisation : $${snap.marketCap ? (snap.marketCap / 1e9).toFixed(2) + 'Md' : 'N/A'}` : 'Cours : indisponible',
    recentPrices ? `Cours récents (10 derniers jours) : ${recentPrices}` : '',
    latestIncome
      ? `Derniers résultats (${latestIncome.period}) : CA $${(latestIncome.revenue / 1e9).toFixed(2)}Md, Résultat net $${(latestIncome.netIncome / 1e9).toFixed(2)}Md, EBITDA $${latestIncome.ebitda ? (latestIncome.ebitda / 1e9).toFixed(2) + 'Md' : 'N/A'}`
      : '',
    latestBalance
      ? `Bilan (${latestBalance.period}) : Trésorerie $${(latestBalance.cash / 1e9).toFixed(2)}Md, Dette $${(latestBalance.debt / 1e9).toFixed(2)}Md, Capitaux propres $${(latestBalance.totalEquity / 1e9).toFixed(2)}Md`
      : '',
    latestCash
      ? `Flux de trésorerie (${latestCash.period}) : FCO $${(latestCash.operatingCashFlow / 1e9).toFixed(2)}Md, FCF $${(latestCash.freeCashFlow / 1e9).toFixed(2)}Md, CapEx $${(latestCash.capitalExpenditures / 1e9).toFixed(2)}Md`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Core: generate research for a single ticker
// ---------------------------------------------------------------------------

export async function generateResearch(ticker: string): Promise<ResearchContext | null> {
  const key = `research:${ticker}`;
  return cache.getOrSet(
    key,
    async () => {
      logger.info(`Generating research for ${ticker}`);
      const context = await buildTickerContext(ticker);

      try {
        const stream = await client.messages.stream({
          model: MODEL,
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          output_config: {
            format: {
              type: 'json_schema',
              name: 'ResearchContext',
              schema: RESEARCH_SCHEMA,
            },
          },
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: `Analyse l'action suivante et produis un contexte de recherche complet :\n\n${context}\n\nFournis ton analyse complète incluant la thèse, les objectifs de cours, les scénarios, les conditions d'invalidation, les catalyseurs et le signal.`,
            },
          ],
        });

        const response = await stream.finalMessage();
        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          logger.warn(`No text block in research response for ${ticker}`);
          return null;
        }

        const parsed = JSON.parse(textBlock.text) as Omit<ResearchContext, 'ticker' | 'computedAt'>;
        return {
          ticker: ticker.toUpperCase(),
          ...parsed,
          computedAt: Date.now(),
        } satisfies ResearchContext;
      } catch (err) {
        logger.error({ err, ticker }, 'generateResearch failed');
        return null;
      }
    },
    TTL.RESEARCH,
  );
}

// ---------------------------------------------------------------------------
// Daily scan across all holdings + watchlist
// ---------------------------------------------------------------------------

export async function runDailyScan(
  holdings: PortfolioHolding[],
  watchlist: WatchlistEntry[],
): Promise<ScanResult | null> {
  const key = `research:scan:daily`;
  return cache.getOrSet(
    key,
    async () => {
      logger.info(`Running daily portfolio scan (${holdings.length} holdings, ${watchlist.length} watchlist)`);

      // Pre-load research for all holdings in parallel
      const allTickers = [
        ...holdings.map((h) => h.ticker),
        ...watchlist.map((w) => w.ticker),
      ];
      const researchResults = await Promise.allSettled(
        allTickers.map((t) => generateResearch(t)),
      );

      const researchMap: Record<string, ResearchContext> = {};
      allTickers.forEach((t, i) => {
        const r = researchResults[i];
        if (r.status === 'fulfilled' && r.value) researchMap[t] = r.value;
      });

      // Build summary context for the scan
      const holdingsSummary = holdings
        .map((h) => {
          const r = researchMap[h.ticker];
          return [
            `${h.ticker} (${h.shares} actions @ $${h.avgCostBasis} PRU, pondération cible : ${h.targetWeightPct}%)`,
            r ? `  Signal : ${r.signal} | Conviction : ${r.conviction}/10 | Objectif 12M : $${r.priceTargets['12M']}` : '  Recherche : indisponible',
          ].join('\n');
        })
        .join('\n');

      const watchlistSummary = watchlist
        .map((w) => {
          const r = researchMap[w.ticker];
          return [
            `${w.ticker} (intérêt : ${w.interest})`,
            r ? `  Signal : ${r.signal} | Conviction : ${r.conviction}/10 | Objectif 12M : $${r.priceTargets['12M']}` : '  Recherche : indisponible',
          ].join('\n');
        })
        .join('\n');

      try {
        const stream = await client.messages.stream({
          model: MODEL,
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          output_config: {
            format: {
              type: 'json_schema',
              name: 'ScanResult',
              schema: SCAN_SCHEMA,
            },
          },
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: [
                `Lance le scan quotidien du portefeuille. Date : ${new Date().toISOString().slice(0, 10)}`,
                '',
                '## Positions',
                holdingsSummary || 'Aucune position.',
                '',
                '## Watchlist',
                watchlistSummary || 'Aucune entrée en watchlist.',
                '',
                'Sur la base des contextes de recherche ci-dessus, produis un scan quotidien avec : un résumé de marché en 2-3 phrases, des signaux d\'action spécifiques pour chaque position, les convictions les plus fortes, et les alertes de risque actuelles.',
              ].join('\n'),
            },
          ],
        });

        const response = await stream.finalMessage();
        const textBlock = response.content.find((b) => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') return null;

        const parsed = JSON.parse(textBlock.text) as Omit<ScanResult, 'date' | 'computedAt'>;

        // Stamp each signal
        const signals: BuySellSignal[] = (parsed.signals ?? []).map((s) => ({
          ...s,
          computedAt: Date.now(),
        }));

        return {
          date: new Date().toISOString().slice(0, 10),
          ...parsed,
          signals,
          computedAt: Date.now(),
        } satisfies ScanResult;
      } catch (err) {
        logger.error({ err }, 'runDailyScan failed');
        return null;
      }
    },
    TTL.PORTFOLIO_SCAN,
  );
}

// ---------------------------------------------------------------------------
// On-demand analysis: fired when a tweet / news item warrants a fresh look
// ---------------------------------------------------------------------------

export async function analyzeOnDemand(
  ticker: string,
  prompt: string,
): Promise<{ analysis: string; signal: BuySellSignal } | null> {
  logger.info(`On-demand analysis for ${ticker}: "${prompt.slice(0, 80)}"`);

  // Load pre-existing research context if available (fast path)
  const cached = cache.get<ResearchContext>(`research:${ticker}`);
  const context = await buildTickerContext(ticker);

  const systemWithThesis = cached
    ? `${SYSTEM_PROMPT}\n\nThèse pré-chargée pour ${ticker} :\n${cached.thesis}\nSignal actuel : ${cached.signal} (conviction : ${cached.conviction}/10)\nObjectif 12M : $${cached.priceTargets['12M']}`
    : SYSTEM_PROMPT;

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system: [
        {
          type: 'text',
          text: systemWithThesis,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Ticker : ${ticker}\n\nDonnées de marché :\n${context}\n\nCatalyseur / question : ${prompt}\n\nFournis une analyse concise (3-5 phrases) puis un signal JSON à la fin dans ce format exact :\n{"action":"buy|add|hold|reduce|sell|watch","urgency":"high|medium|low","rationale":"...","suggestedSizeChangePct":0}`,
        },
      ],
    });

    const response = await stream.finalMessage();
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return null;

    const text = textBlock.text;

    // Extract JSON signal from end of response
    const jsonMatch = text.match(/\{[^{}]*"action"[^{}]*\}/s);
    let signal: BuySellSignal = {
      ticker: ticker.toUpperCase(),
      action: 'hold',
      urgency: 'low',
      rationale: 'Signal non analysable',
      computedAt: Date.now(),
    };
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as Partial<BuySellSignal>;
        signal = {
          ticker: ticker.toUpperCase(),
          action: parsed.action ?? 'hold',
          urgency: parsed.urgency ?? 'low',
          rationale: parsed.rationale ?? '',
          suggestedSizeChangePct: parsed.suggestedSizeChangePct,
          computedAt: Date.now(),
        };
      } catch {
        /* use default */
      }
    }

    const analysis = text.replace(/\{[^{}]*"action"[^{}]*\}/s, '').trim();
    return { analysis, signal };
  } catch (err) {
    logger.error({ err, ticker }, 'analyzeOnDemand failed');
    return null;
  }
}

export const researchService = {
  generateResearch,
  runDailyScan,
  analyzeOnDemand,
};
