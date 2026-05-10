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

const SYSTEM_PROMPT = `You are an elite equity analyst and portfolio manager. Your job is to:
1. Build deep fundamental theses on stocks based on financial data, industry dynamics, and competitive positioning.
2. Generate precise price targets across 1M/3M/6M/12M time horizons.
3. Define bear / base / bull scenarios with probabilities.
4. Identify kill conditions — specific events or data points that would invalidate the thesis.
5. Assess catalysts and risks with intellectual honesty.
6. Produce actionable buy/hold/sell signals with conviction scores.

Your analysis must be data-driven, concise, and contrarian where warranted. Never produce generic boilerplate.
Always ground targets in fundamentals (FCF yield, EV/EBITDA, PEG, etc.).
When data is limited, say so explicitly and adjust conviction accordingly.`;

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
    f ? `Company: ${f.name} | Sector: ${f.sector ?? 'N/A'} | Industry: ${f.industry ?? 'N/A'}` : '',
    f?.description ? `Description: ${f.description.slice(0, 400)}` : '',
    snap ? `Current price: $${snap.price} | Market cap: $${snap.marketCap ? (snap.marketCap / 1e9).toFixed(2) + 'B' : 'N/A'}` : 'Price: unavailable',
    recentPrices ? `Recent prices (last 10 days): ${recentPrices}` : '',
    latestIncome
      ? `Latest income (${latestIncome.period}): Revenue $${(latestIncome.revenue / 1e9).toFixed(2)}B, Net income $${(latestIncome.netIncome / 1e9).toFixed(2)}B, EBITDA $${latestIncome.ebitda ? (latestIncome.ebitda / 1e9).toFixed(2) + 'B' : 'N/A'}`
      : '',
    latestBalance
      ? `Balance sheet (${latestBalance.period}): Cash $${(latestBalance.cash / 1e9).toFixed(2)}B, Debt $${(latestBalance.debt / 1e9).toFixed(2)}B, Equity $${(latestBalance.totalEquity / 1e9).toFixed(2)}B`
      : '',
    latestCash
      ? `Cash flow (${latestCash.period}): OCF $${(latestCash.operatingCashFlow / 1e9).toFixed(2)}B, FCF $${(latestCash.freeCashFlow / 1e9).toFixed(2)}B, CapEx $${(latestCash.capitalExpenditures / 1e9).toFixed(2)}B`
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
              content: `Analyze the following stock and produce a complete research context:\n\n${context}\n\nProvide your full analysis including thesis, price targets, scenarios, kill conditions, catalysts, and signal.`,
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
            `${h.ticker} (${h.shares} shares @ $${h.avgCostBasis} avg cost, target weight: ${h.targetWeightPct}%)`,
            r ? `  Signal: ${r.signal} | Conviction: ${r.conviction}/10 | 12M target: $${r.priceTargets['12M']}` : '  Research: unavailable',
          ].join('\n');
        })
        .join('\n');

      const watchlistSummary = watchlist
        .map((w) => {
          const r = researchMap[w.ticker];
          return [
            `${w.ticker} (interest: ${w.interest})`,
            r ? `  Signal: ${r.signal} | Conviction: ${r.conviction}/10 | 12M target: $${r.priceTargets['12M']}` : '  Research: unavailable',
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
                `Run a daily portfolio scan. Date: ${new Date().toISOString().slice(0, 10)}`,
                '',
                '## Holdings',
                holdingsSummary || 'No holdings.',
                '',
                '## Watchlist',
                watchlistSummary || 'No watchlist entries.',
                '',
                'Based on the latest research contexts above, produce a daily scan with: a 2-3 sentence market summary, specific action signals for each position, top conviction picks, and current risk flags.',
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
    ? `${SYSTEM_PROMPT}\n\nPre-loaded thesis for ${ticker}:\n${cached.thesis}\nCurrent signal: ${cached.signal} (conviction: ${cached.conviction}/10)\n12M target: $${cached.priceTargets['12M']}`
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
          content: `Ticker: ${ticker}\n\nMarket data:\n${context}\n\nCatalyst / prompt: ${prompt}\n\nProvide a concise analysis (3-5 sentences) and a JSON action signal at the end in this exact format:\n{"action":"buy|add|hold|reduce|sell|watch","urgency":"high|medium|low","rationale":"...","suggestedSizeChangePct":0}`,
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
      rationale: 'Unable to parse signal',
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
