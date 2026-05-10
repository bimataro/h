/**
 * Portfolio Sync Jobs
 *
 * Schedule:
 *   - Every hour      : Refresh stock price caches
 *   - Every 6 hours   : Refresh AI research contexts for all holdings
 *   - Daily at 07:00  : Run full portfolio scan
 */

import cron from 'node-cron';
import { cache } from '../cache/cache.service';
import { logger } from '../logger';
import { portfolioStore } from '../portfolio/portfolio.store';
import { researchService } from '../portfolio/research.service';
import { financialDatasetsService } from '../portfolio/financialDatasets.service';

function createJob(name: string, fn: () => Promise<void>) {
  let running = false;
  return async () => {
    if (running) {
      logger.warn(`[${name}] Already running — skipping this tick`);
      return;
    }
    running = true;
    const start = Date.now();
    logger.info(`[${name}] Starting`);
    try {
      await fn();
      logger.info(`[${name}] Completed in ${Date.now() - start}ms`);
    } catch (err) {
      logger.error({ err }, `[${name}] Failed after ${Date.now() - start}ms`);
    } finally {
      running = false;
    }
  };
}

// ---------------------------------------------------------------------------
// Job: hourly price refresh
// ---------------------------------------------------------------------------
const refreshStockPrices = createJob('RefreshStockPrices', async () => {
  const count = cache.deleteByPrefix('fd:snapshot:');
  cache.deleteByPrefix('fd:history:');
  logger.info(`RefreshStockPrices: evicted ${count} price cache entries`);

  // Pre-warm prices for all holdings
  const holdings = portfolioStore.getHoldings();
  if (holdings.length === 0) return;

  await Promise.allSettled(
    holdings.map((h) => financialDatasetsService.getPriceSnapshot(h.ticker)),
  );
  logger.info(`RefreshStockPrices: pre-warmed prices for ${holdings.length} holdings`);
});

// ---------------------------------------------------------------------------
// Job: 6-hourly research refresh
// ---------------------------------------------------------------------------
const refreshResearch = createJob('RefreshResearch', async () => {
  const count = cache.deleteByPrefix('research:');
  logger.info(`RefreshResearch: evicted ${count} research cache entries`);

  const holdings = portfolioStore.getHoldings();
  const watchlist = portfolioStore.getWatchlist();
  const tickers = [...new Set([...holdings.map((h) => h.ticker), ...watchlist.map((w) => w.ticker)])];

  if (tickers.length === 0) return;

  // Refresh research contexts sequentially to avoid hammering the Claude API
  let refreshed = 0;
  for (const ticker of tickers) {
    try {
      await researchService.generateResearch(ticker);
      refreshed++;
    } catch (err) {
      logger.warn({ err, ticker }, `RefreshResearch: failed for ${ticker}`);
    }
  }
  logger.info(`RefreshResearch: refreshed ${refreshed}/${tickers.length} tickers`);
});

// ---------------------------------------------------------------------------
// Job: daily scan
// ---------------------------------------------------------------------------
const runDailyScan = createJob('DailyPortfolioScan', async () => {
  cache.deleteByPrefix('research:scan:');

  const holdings = portfolioStore.getHoldings();
  const watchlist = portfolioStore.getWatchlist();

  if (holdings.length === 0 && watchlist.length === 0) {
    logger.info('DailyPortfolioScan: no holdings or watchlist — skipping');
    return;
  }

  const scan = await researchService.runDailyScan(holdings, watchlist);
  if (scan) {
    logger.info(`DailyPortfolioScan: ${scan.signals.length} signals generated`);
  } else {
    logger.warn('DailyPortfolioScan: scan returned null');
  }
});

// ---------------------------------------------------------------------------
// Start all portfolio jobs
// ---------------------------------------------------------------------------
export function startPortfolioJobs(): void {
  logger.info('Starting portfolio sync jobs...');

  // Every hour at minute 20
  cron.schedule('20 * * * *', refreshStockPrices);

  // Every 6 hours at minute 30
  cron.schedule('30 */6 * * *', refreshResearch);

  // Daily at 07:00 UTC
  cron.schedule('0 7 * * *', runDailyScan);

  logger.info('Portfolio sync jobs scheduled');
}
