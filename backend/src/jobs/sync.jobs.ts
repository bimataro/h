/**
 * Sync Jobs — cron-based data synchronisation
 *
 * Schedule:
 *   - Every hour    : Refresh raw prices (TCGdex)
 *   - Every 6 hours : Refresh graded prices (PokeTrace)
 *   - Daily         : Download Cardmarket CSV price guide
 *   - Weekly        : Refresh card metadata (pokemontcg.io)
 *   - Every 4 hours : Refresh currency exchange rates
 *
 * Each job is guarded with:
 *   - Error catching (job failure doesn't crash the process)
 *   - Simple lock flag to prevent concurrent runs
 *   - Logging of start / completion / failure
 */

import cron from 'node-cron';
import { pokemonTCGService } from '../services/pokemonTCG.service';
import { tcgdexService } from '../services/tcgdex.service';
import { pokeTraceService } from '../services/pokeTrace.service';
import { cardmarketCSVService } from '../services/cardmarketCSV.service';
import { currencyService } from '../services/currency.service';
import { cache } from '../cache/cache.service';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Job runner utility
// ---------------------------------------------------------------------------
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
// Job definitions
// ---------------------------------------------------------------------------

/**
 * Hourly: flush stale raw price cache entries so next request
 * triggers a fresh fetch from TCGdex.
 *
 * We don't pro-actively re-fetch all cards (too many requests),
 * instead we rely on request-time cache miss to trigger fresh fetches.
 * This job invalidates the prefix so stale data is evicted.
 */
const refreshRawPrices = createJob('RefreshRawPrices', async () => {
  const count = cache.deleteByPrefix('tcgdex:prices:');
  logger.info(`RefreshRawPrices: evicted ${count} TCGdex price cache entries`);

  // Also evict aggregated raw price cache
  const aggCount = cache.deleteByPrefix('agg:raw-prices:');
  logger.info(`RefreshRawPrices: evicted ${aggCount} aggregated raw price cache entries`);
});

/**
 * Every 6 hours: flush graded price caches (PokeTrace + PPT).
 */
const refreshGradedPrices = createJob('RefreshGradedPrices', async () => {
  const ptCount = cache.deleteByPrefix('poketrace:graded:');
  const pptCount = cache.deleteByPrefix('ppt:psa:');
  const aggCount = cache.deleteByPrefix('agg:graded-prices:');
  logger.info(`RefreshGradedPrices: evicted ${ptCount + pptCount + aggCount} graded price cache entries`);
});

/**
 * Daily: Download Cardmarket CSV price guide.
 */
const downloadCardmarketCSV = createJob('CardmarketCSVDownload', async () => {
  const { indexed } = await cardmarketCSVService.downloadAndIndex();
  logger.info(`CardmarketCSVDownload: indexed ${indexed} Cardmarket price entries`);
});

/**
 * Weekly: Refresh all sets + card metadata from pokemontcg.io.
 * Evicts set/card meta caches so next request fetches fresh data.
 */
const refreshCardMeta = createJob('RefreshCardMeta', async () => {
  // Evict all card meta caches
  cache.deleteByPrefix('tcgio:');
  cache.deleteByPrefix('tcgdex:cards:');
  cache.deleteByPrefix('tcgdex:sets:');
  cache.deleteByPrefix('agg:cards:');
  logger.info('RefreshCardMeta: card meta caches cleared — will refresh on next request');

  // Pre-warm set list (frequently accessed)
  try {
    const sets = await pokemonTCGService.getSets();
    logger.info(`RefreshCardMeta: pre-warmed ${sets.length} sets from pokemontcg.io`);
  } catch (err) {
    logger.warn({ err }, 'RefreshCardMeta: set pre-warm failed');
  }
});

/**
 * Every 4 hours: Refresh currency exchange rates.
 */
const refreshExchangeRates = createJob('RefreshExchangeRates', async () => {
  currencyService.invalidate();
  const rates = await currencyService.getRates();
  logger.info(`RefreshExchangeRates: EUR/USD=${rates.rates.USD}, EUR/JPY=${rates.rates.JPY}`);
});

/**
 * Every 30 minutes: Evict arbitrage computation cache so fresh EV/ROI
 * is computed on next request.
 */
const refreshArbitrage = createJob('RefreshArbitrage', async () => {
  const count = cache.deleteByPrefix('arbitrage:');
  logger.info(`RefreshArbitrage: evicted ${count} arbitrage cache entries`);
});

// ---------------------------------------------------------------------------
// Start all jobs
// ---------------------------------------------------------------------------
export function startSyncJobs(): void {
  logger.info('Starting sync jobs...');

  // Every hour at minute 5 (avoids thundering herd at :00)
  cron.schedule('5 * * * *', refreshRawPrices);

  // Every 6 hours
  cron.schedule('10 */6 * * *', refreshGradedPrices);

  // Daily at 03:00 UTC
  cron.schedule('0 3 * * *', downloadCardmarketCSV);

  // Every Sunday at 02:00 UTC
  cron.schedule('0 2 * * 0', refreshCardMeta);

  // Every 4 hours
  cron.schedule('15 */4 * * *', refreshExchangeRates);

  // Every 30 minutes
  cron.schedule('*/30 * * * *', refreshArbitrage);

  logger.info('Sync jobs scheduled');

  // Run initial jobs on startup
  void runInitialJobs();
}

async function runInitialJobs(): Promise<void> {
  logger.info('Running initial startup jobs...');

  // Download CSV on startup if not yet done (runs in background)
  try {
    await downloadCardmarketCSV();
  } catch {
    // Non-fatal — CSV will be retried on next daily job
  }

  // Warm exchange rates
  try {
    await refreshExchangeRates();
  } catch {
    // Uses fallback rates
  }
}
