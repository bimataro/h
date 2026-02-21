/**
 * Cards Routes
 *
 * GET /cards                  — list cards (filter by set, language, query)
 * GET /cards/:id              — get card metadata
 * GET /cards/:id/prices       — get raw (ungraded) prices
 * GET /cards/:id/graded-prices — get graded prices (PSA/BGS/CGC/SGC/ACE)
 *
 * :id format: `<setId>/<localId>:<LANGUAGE>` e.g. `sv1/001:FR`
 * URL-encode the forward slash: `sv1%2F001:FR` or pass raw (express handles it).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Language, GradingCompany } from '../../../shared/types';
import { getCard, listCards, getRawPrices, getGradedPrices } from '../services/aggregator.service';
import { AppError } from '../middleware/errorHandler';

export const cardsRouter = Router();

// ---------------------------------------------------------------------------
// GET /cards
// ---------------------------------------------------------------------------
/**
 * @route   GET /cards
 * @query   setId?       filter by set ID
 * @query   language?    card language (default EN)
 * @query   q?           name search query
 * @query   page?        page number (default 1)
 * @query   pageSize?    results per page (default 20, max 100)
 */
cardsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = parseLanguage(req.query['language'] as string | undefined);
    const page = Math.max(1, parseInt(req.query['page'] as string || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query['pageSize'] as string || '20', 10)));

    const result = await listCards({
      setId: req.query['setId'] as string | undefined,
      language,
      query: req.query['q'] as string | undefined,
      page,
      pageSize,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /cards/:id
// ---------------------------------------------------------------------------
/**
 * @route   GET /cards/:id
 * @param   id   Card composite ID (setId/localId:LANG or tcgio ID)
 */
cardsRouter.get('/:id(*)', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const card = await getCard(req.params['id']);
    if (!card) throw new AppError(404, 'CARD_NOT_FOUND', `Card "${req.params['id']}" not found`);
    res.json({ data: card });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /cards/:id/prices
// ---------------------------------------------------------------------------
/**
 * @route   GET /cards/:id/prices
 * @param   id         Card composite ID
 * @query   language?  override language (default: from card ID)
 */
cardsRouter.get('/:id(*)/prices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = parseLanguage(req.query['language'] as string | undefined);
    const prices = await getRawPrices(req.params['id'], language);
    if (!prices) throw new AppError(404, 'PRICES_NOT_FOUND', `No prices found for card "${req.params['id']}"`);
    res.json({ data: prices });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /cards/:id/graded-prices
// ---------------------------------------------------------------------------
/**
 * @route   GET /cards/:id/graded-prices
 * @param   id           Card composite ID
 * @query   language?    override language
 * @query   companies?   comma-separated list of grading companies (PSA,BGS,CGC)
 */
cardsRouter.get('/:id(*)/graded-prices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = parseLanguage(req.query['language'] as string | undefined);
    const companies = parseCompanies(req.query['companies'] as string | undefined);
    const prices = await getGradedPrices(req.params['id'], language, companies);
    if (!prices) throw new AppError(404, 'GRADED_PRICES_NOT_FOUND', `No graded prices found for "${req.params['id']}"`);
    res.json({ data: prices });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLanguage(raw?: string): Language {
  const lang = raw?.toUpperCase() as Language | undefined;
  const valid: Language[] = ['EN', 'FR', 'JP', 'DE', 'ES', 'IT', 'PT', 'KO', 'ZH-TW', 'ZH-CN', 'NL', 'PL', 'RU'];
  return lang && valid.includes(lang) ? lang : 'EN';
}

function parseCompanies(raw?: string): GradingCompany[] | undefined {
  if (!raw) return undefined;
  const valid: GradingCompany[] = ['PSA', 'BGS', 'CGC', 'SGC', 'ACE'];
  return raw
    .split(',')
    .map((c) => c.trim().toUpperCase() as GradingCompany)
    .filter((c) => valid.includes(c));
}
