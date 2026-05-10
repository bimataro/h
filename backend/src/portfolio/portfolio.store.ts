/**
 * Portfolio Store
 *
 * Persists portfolio state to backend/data/portfolio.json.
 * All mutations are synchronous writes to keep things simple.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import type { Portfolio, PortfolioHolding, WatchlistEntry } from '../../../shared/types';

const DATA_PATH = path.resolve(__dirname, '../../data/portfolio.json');

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function load(): Portfolio {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw) as Portfolio;
  } catch {
    return { holdings: [], watchlist: [], updatedAt: Date.now() };
  }
}

function save(portfolio: Portfolio): void {
  try {
    fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(portfolio, null, 2), 'utf-8');
  } catch (err) {
    logger.error({ err }, 'Failed to save portfolio');
  }
}

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

export function getPortfolio(): Portfolio {
  return load();
}

export function getHoldings(): PortfolioHolding[] {
  return load().holdings;
}

export function getHolding(ticker: string): PortfolioHolding | undefined {
  return load().holdings.find((h) => h.ticker === ticker.toUpperCase());
}

export function upsertHolding(holding: Omit<PortfolioHolding, 'updatedAt'>): PortfolioHolding {
  const portfolio = load();
  const idx = portfolio.holdings.findIndex((h) => h.ticker === holding.ticker.toUpperCase());
  const updated: PortfolioHolding = {
    ...holding,
    ticker: holding.ticker.toUpperCase(),
    updatedAt: Date.now(),
  };
  if (idx >= 0) {
    portfolio.holdings[idx] = updated;
  } else {
    portfolio.holdings.push(updated);
  }
  portfolio.updatedAt = Date.now();
  save(portfolio);
  logger.info(`Portfolio: upserted holding ${updated.ticker}`);
  return updated;
}

export function removeHolding(ticker: string): boolean {
  const portfolio = load();
  const before = portfolio.holdings.length;
  portfolio.holdings = portfolio.holdings.filter((h) => h.ticker !== ticker.toUpperCase());
  if (portfolio.holdings.length < before) {
    portfolio.updatedAt = Date.now();
    save(portfolio);
    logger.info(`Portfolio: removed holding ${ticker.toUpperCase()}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------

export function getWatchlist(): WatchlistEntry[] {
  return load().watchlist;
}

export function addToWatchlist(entry: Omit<WatchlistEntry, 'addedAt'>): WatchlistEntry {
  const portfolio = load();
  const ticker = entry.ticker.toUpperCase();
  const existing = portfolio.watchlist.findIndex((w) => w.ticker === ticker);
  const item: WatchlistEntry = { ...entry, ticker, addedAt: Date.now() };
  if (existing >= 0) {
    portfolio.watchlist[existing] = item;
  } else {
    portfolio.watchlist.push(item);
  }
  portfolio.updatedAt = Date.now();
  save(portfolio);
  return item;
}

export function removeFromWatchlist(ticker: string): boolean {
  const portfolio = load();
  const before = portfolio.watchlist.length;
  portfolio.watchlist = portfolio.watchlist.filter((w) => w.ticker !== ticker.toUpperCase());
  if (portfolio.watchlist.length < before) {
    portfolio.updatedAt = Date.now();
    save(portfolio);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Weight computation
// ---------------------------------------------------------------------------

export function computeWeights(
  holdings: PortfolioHolding[],
  prices: Record<string, number>,
): PortfolioHolding[] {
  const totalValue = holdings.reduce((sum, h) => {
    const price = prices[h.ticker] ?? h.avgCostBasis;
    return sum + h.shares * price;
  }, 0);

  if (totalValue === 0) return holdings;

  return holdings.map((h) => {
    const price = prices[h.ticker] ?? h.avgCostBasis;
    return {
      ...h,
      currentWeightPct: ((h.shares * price) / totalValue) * 100,
    };
  });
}

export const portfolioStore = {
  getPortfolio,
  getHoldings,
  getHolding,
  upsertHolding,
  removeHolding,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  computeWeights,
};
