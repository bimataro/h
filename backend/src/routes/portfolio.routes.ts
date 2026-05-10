import { Router, Request, Response, NextFunction } from 'express';
import { portfolioStore } from '../portfolio/portfolio.store';
import { researchService } from '../portfolio/research.service';
import { financialDatasetsService } from '../portfolio/financialDatasets.service';
import { AppError } from '../middleware/errorHandler';
import type { PortfolioHolding, WatchlistEntry } from '../../../shared/types';

export const portfolioRouter = Router();

// ---------------------------------------------------------------------------
// GET /portfolio/summary — full portfolio with live prices + weights
// ---------------------------------------------------------------------------
portfolioRouter.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const holdings = portfolioStore.getHoldings();
    const watchlist = portfolioStore.getWatchlist();

    // Fetch live prices for all tickers
    const priceResults = await Promise.allSettled(
      holdings.map((h) => financialDatasetsService.getPriceSnapshot(h.ticker)),
    );

    const prices: Record<string, number> = {};
    holdings.forEach((h, i) => {
      const r = priceResults[i];
      if (r.status === 'fulfilled' && r.value) prices[h.ticker] = r.value.price;
    });

    const weightedHoldings = portfolioStore.computeWeights(holdings, prices);

    const totalValue = weightedHoldings.reduce((sum, h) => {
      return sum + h.shares * (prices[h.ticker] ?? h.avgCostBasis);
    }, 0);

    const totalCost = weightedHoldings.reduce((sum, h) => sum + h.shares * h.avgCostBasis, 0);
    const totalPnlPct = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;

    res.json({
      holdings: weightedHoldings,
      watchlist,
      totalValue,
      totalCost,
      totalPnlPct,
      updatedAt: Date.now(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /portfolio/holdings
// ---------------------------------------------------------------------------
portfolioRouter.get('/holdings', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ holdings: portfolioStore.getHoldings() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /portfolio/holdings — add or update a holding
// ---------------------------------------------------------------------------
portfolioRouter.post('/holdings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Partial<PortfolioHolding>;
    if (!body.ticker || body.shares == null || body.avgCostBasis == null) {
      throw new AppError(400, 'INVALID_BODY', 'ticker, shares, and avgCostBasis are required');
    }

    // Fetch company name if not provided
    let companyName = body.companyName ?? body.ticker;
    if (!body.companyName) {
      const facts = await financialDatasetsService.getCompanyFacts(body.ticker);
      if (facts) companyName = facts.name;
    }

    const holding = portfolioStore.upsertHolding({
      ticker: body.ticker,
      companyName,
      shares: Number(body.shares),
      avgCostBasis: Number(body.avgCostBasis),
      targetWeightPct: Number(body.targetWeightPct ?? 0),
      currency: 'USD',
      addedAt: body.addedAt ?? Date.now(),
      notes: body.notes,
      tags: body.tags,
    });

    res.status(201).json({ holding });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /portfolio/holdings/:ticker — update a holding
// ---------------------------------------------------------------------------
portfolioRouter.put('/holdings/:ticker', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticker } = req.params;
    const existing = portfolioStore.getHolding(ticker);
    if (!existing) throw new AppError(404, 'NOT_FOUND', `No holding for ${ticker.toUpperCase()}`);

    const body = req.body as Partial<PortfolioHolding>;
    const holding = portfolioStore.upsertHolding({
      ...existing,
      ...body,
      ticker: ticker.toUpperCase(),
    });

    res.json({ holding });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /portfolio/holdings/:ticker
// ---------------------------------------------------------------------------
portfolioRouter.delete('/holdings/:ticker', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticker } = req.params;
    const removed = portfolioStore.removeHolding(ticker);
    if (!removed) throw new AppError(404, 'NOT_FOUND', `No holding for ${ticker.toUpperCase()}`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /portfolio/watchlist
// ---------------------------------------------------------------------------
portfolioRouter.get('/watchlist', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ watchlist: portfolioStore.getWatchlist() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /portfolio/watchlist
// ---------------------------------------------------------------------------
portfolioRouter.post('/watchlist', (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as Partial<WatchlistEntry>;
    if (!body.ticker) throw new AppError(400, 'INVALID_BODY', 'ticker is required');
    const entry = portfolioStore.addToWatchlist({
      ticker: body.ticker,
      companyName: body.companyName ?? body.ticker,
      interest: body.interest ?? '',
    });
    res.status(201).json({ entry });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /portfolio/watchlist/:ticker
// ---------------------------------------------------------------------------
portfolioRouter.delete('/watchlist/:ticker', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticker } = req.params;
    const removed = portfolioStore.removeFromWatchlist(ticker);
    if (!removed) throw new AppError(404, 'NOT_FOUND', `${ticker.toUpperCase()} not in watchlist`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /portfolio/research/:ticker — get (or generate) research for a ticker
// ---------------------------------------------------------------------------
portfolioRouter.get('/research/:ticker', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticker } = req.params;
    const research = await researchService.generateResearch(ticker.toUpperCase());
    if (!research) throw new AppError(503, 'RESEARCH_FAILED', `Could not generate research for ${ticker.toUpperCase()}`);
    res.json({ research });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /portfolio/scan — daily scan across entire portfolio
// ---------------------------------------------------------------------------
portfolioRouter.get('/scan', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const holdings = portfolioStore.getHoldings();
    const watchlist = portfolioStore.getWatchlist();
    const scan = await researchService.runDailyScan(holdings, watchlist);
    if (!scan) throw new AppError(503, 'SCAN_FAILED', 'Daily scan could not be generated');
    res.json({ scan });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /portfolio/analyze — on-demand subagent analysis
// Body: { ticker: string, prompt: string }
// ---------------------------------------------------------------------------
portfolioRouter.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticker, prompt } = req.body as { ticker?: string; prompt?: string };
    if (!ticker || !prompt) {
      throw new AppError(400, 'INVALID_BODY', 'ticker and prompt are required');
    }
    const result = await researchService.analyzeOnDemand(ticker.toUpperCase(), prompt);
    if (!result) throw new AppError(503, 'ANALYSIS_FAILED', `On-demand analysis failed for ${ticker.toUpperCase()}`);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /portfolio/prices/:ticker — live price snapshot
// ---------------------------------------------------------------------------
portfolioRouter.get('/prices/:ticker', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ticker } = req.params;
    const snapshot = await financialDatasetsService.getPriceSnapshot(ticker.toUpperCase());
    if (!snapshot) throw new AppError(404, 'PRICE_NOT_FOUND', `No price data for ${ticker.toUpperCase()}`);
    res.json({ snapshot });
  } catch (err) {
    next(err);
  }
});
