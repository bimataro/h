/**
 * Sets Routes
 *
 * GET /sets        — list all sets
 * GET /sets/:id    — get set metadata + card count
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Language } from '../../../shared/types';
import { listSets } from '../services/aggregator.service';
import { AppError } from '../middleware/errorHandler';

export const setsRouter = Router();

// ---------------------------------------------------------------------------
// GET /sets
// ---------------------------------------------------------------------------
/**
 * @route   GET /sets
 * @query   language?   card language (default EN)
 */
setsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = parseLanguage(req.query['language'] as string | undefined);
    const sets = await listSets(language);
    res.json({
      data: sets,
      total: sets.length,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /sets/:id
// ---------------------------------------------------------------------------
/**
 * @route   GET /sets/:id
 */
setsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const language = parseLanguage(req.query['language'] as string | undefined);
    const sets = await listSets(language);
    const set = sets.find((s) => s.id === req.params['id']);
    if (!set) throw new AppError(404, 'SET_NOT_FOUND', `Set "${req.params['id']}" not found`);
    res.json({ data: set });
  } catch (err) {
    next(err);
  }
});

function parseLanguage(raw?: string): Language {
  const lang = raw?.toUpperCase() as Language | undefined;
  const valid: Language[] = ['EN', 'FR', 'JP', 'DE', 'ES', 'IT', 'PT', 'KO', 'ZH-TW', 'ZH-CN', 'NL', 'PL', 'RU'];
  return lang && valid.includes(lang) ? lang : 'EN';
}
