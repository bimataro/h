/**
 * Arbitrage Routes
 *
 * GET /arbitrage-opportunities
 *   — Returns cards with positive EV for grading arbitrage.
 *   — Computes EV/ROI using live prices from aggregator.
 *
 * POST /arbitrage-opportunities/calculate
 *   — Calculate EV/ROI for a specific card + grading company.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { GradingCompany, Language, ArbitrageOpportunity, GradedPrices } from '../../../shared/types';
import { listCards, getRawPrices, getGradedPrices } from '../services/aggregator.service';
import { calculateEV, buildOpportunity } from '../utils/ev-roi.calculator';
import { cache, TTL } from '../cache/cache.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../logger';

export const arbitrageRouter = Router();

// ---------------------------------------------------------------------------
// GET /arbitrage-opportunities
// ---------------------------------------------------------------------------
/**
 * @route   GET /arbitrage-opportunities
 * @query   setId?          filter to a specific set
 * @query   language?       card language (default EN)
 * @query   company?        grading company (default PSA)
 * @query   minRoi?         minimum ROI % (default 20)
 * @query   page?           page number (default 1)
 * @query   pageSize?       results per page (default 20, max 50)
 * @query   signal?         filter by signal: strong-buy | buy | neutral | avoid
 *
 * @returns Array of ArbitrageOpportunity sorted by ROI descending.
 *
 * NOTE: This endpoint is compute-intensive. Results are cached for 30 minutes.
 */
arbitrageRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = parseLanguage(req.query['language'] as string | undefined);
    const company = parseCompany(req.query['company'] as string | undefined);
    const setId = req.query['setId'] as string | undefined;
    const minRoi = parseFloat(req.query['minRoi'] as string || '20');
    const signal = req.query['signal'] as ArbitrageOpportunity['signal'] | undefined;
    const page = Math.max(1, parseInt(req.query['page'] as string || '1', 10));
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query['pageSize'] as string || '20', 10)));

    const cacheKey = `arbitrage:${setId}:${language}:${company}:${minRoi}:${signal}`;

    const allOpportunities = await cache.getOrSet(
      cacheKey,
      () => computeArbitrageOpportunities({ setId, language, company }),
      TTL.ARBITRAGE,
    );

    let filtered = allOpportunities
      .filter((o) => o.roi >= minRoi)
      .sort((a, b) => b.roi - a.roi);

    if (signal) {
      filtered = filtered.filter((o) => o.signal === signal);
    }

    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    res.json({
      data,
      page,
      pageSize,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / pageSize),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /arbitrage-opportunities/calculate
// ---------------------------------------------------------------------------
/**
 * @route   POST /arbitrage-opportunities/calculate
 * @body    {
 *   cardId: string,
 *   language?: Language,
 *   company?: GradingCompany,
 * }
 * @returns ArbitrageOpportunity with full grade breakdown.
 */
arbitrageRouter.post('/calculate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cardId, language: langRaw, company: companyRaw } = req.body as {
      cardId?: string;
      language?: string;
      company?: string;
    };

    if (!cardId) throw new AppError(400, 'MISSING_CARD_ID', 'cardId is required');

    const language = parseLanguage(langRaw);
    const company = parseCompany(companyRaw);

    const [rawPrices, gradedPrices] = await Promise.all([
      getRawPrices(cardId, language),
      getGradedPrices(cardId, language, [company]),
    ]);

    if (!rawPrices?.raw['NM']?.valueEUR) {
      throw new AppError(422, 'NO_RAW_PRICE', `No NM raw price available for card "${cardId}" (${language})`);
    }
    if (!gradedPrices?.grades.length) {
      throw new AppError(422, 'NO_GRADED_PRICES', `No graded prices available for card "${cardId}" (${language})`);
    }

    const { EUR: rawPriceEUR } = { EUR: rawPrices.raw['NM']!.valueEUR };
    const result = calculateEV({
      card: { id: cardId, number: '', name: cardId, language, setId: '', updatedAt: '' },
      rawPriceEUR,
      rawPriceSource: rawPrices.raw['NM']!.source,
      gradingCompany: company,
      gradedPrices: gradedPrices.grades,
    });

    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Computation helper
// ---------------------------------------------------------------------------

async function computeArbitrageOpportunities(params: {
  setId?: string;
  language: Language;
  company: GradingCompany;
}): Promise<ArbitrageOpportunity[]> {
  const { setId, language, company } = params;

  // Fetch all cards for the set (or a page if no set given)
  const { data: cards } = await listCards({
    setId,
    language,
    page: 1,
    pageSize: 100, // upper bound for computation batch
  });

  const opportunities: ArbitrageOpportunity[] = [];

  await Promise.all(
    cards.map(async (card) => {
      try {
        const [rawPrices, gradedPrices] = await Promise.all([
          getRawPrices(card.id, language),
          getGradedPrices(card.id, language, [company]),
        ]);

        const nmPriceEUR = rawPrices?.raw['NM']?.valueEUR;
        if (!nmPriceEUR || !gradedPrices?.grades.length) return;

        const input = {
          card,
          rawPriceEUR: nmPriceEUR,
          rawPriceSource: rawPrices!.raw['NM']!.source,
          gradingCompany: company,
          gradedPrices: gradedPrices.grades,
        };

        const result = calculateEV(input);
        opportunities.push(buildOpportunity(input, result));
      } catch (err) {
        logger.warn({ err, cardId: card.id }, 'Arbitrage: skipping card due to error');
      }
    }),
  );

  return opportunities;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLanguage(raw?: string): Language {
  const lang = raw?.toUpperCase() as Language | undefined;
  const valid: Language[] = ['EN', 'FR', 'JP', 'DE', 'ES', 'IT', 'PT', 'KO', 'ZH-TW', 'ZH-CN', 'NL', 'PL', 'RU'];
  return lang && valid.includes(lang) ? lang : 'EN';
}

function parseCompany(raw?: string): GradingCompany {
  const company = raw?.toUpperCase() as GradingCompany | undefined;
  const valid: GradingCompany[] = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE'];
  return company && valid.includes(company) ? company : 'PSA';
}
