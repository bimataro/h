import { logger } from '../logger';

// ---------------------------------------------------------------------------
// In-memory cache with per-entry TTL
// ---------------------------------------------------------------------------
// TTL presets (milliseconds) — exported for use in services
export const TTL = {
  /** TCGdex prices — refresh hourly */
  PRICES_RAW: 60 * 60 * 1_000,
  /** PokeTrace graded prices — refresh every 6 hours */
  PRICES_GRADED: 6 * 60 * 60 * 1_000,
  /** Cardmarket CSV — refreshed daily */
  CARDMARKET_CSV: 24 * 60 * 60 * 1_000,
  /** Pokemon TCG card meta — refreshed weekly */
  CARD_META: 7 * 24 * 60 * 60 * 1_000,
  /** Currency exchange rates — refreshed every 4 hours */
  EXCHANGE_RATES: 4 * 60 * 60 * 1_000,
  /** Arbitrage computations — refreshed every 30 min */
  ARBITRAGE: 30 * 60 * 1_000,
  /** Stock price snapshots — refresh hourly */
  STOCK_PRICES: 60 * 60 * 1_000,
  /** Financial statements — refresh daily */
  FINANCIALS: 24 * 60 * 60 * 1_000,
  /** AI research context per ticker — refresh every 6 hours */
  RESEARCH: 6 * 60 * 60 * 1_000,
  /** Daily portfolio scan results — refresh every 30 min */
  PORTFOLIO_SCAN: 30 * 60 * 1_000,
} as const;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class CacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private pruneInterval?: ReturnType<typeof setInterval>;

  constructor() {
    // Prune expired entries every 10 minutes
    this.pruneInterval = setInterval(() => this.prune(), 10 * 60 * 1_000);
    // Allow process to exit even if interval is active
    this.pruneInterval.unref?.();
  }

  /** Store value with TTL (ms). Returns the value for chaining. */
  set<T>(key: string, value: T, ttlMs: number): T {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  /** Retrieve value or undefined if expired / missing. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Check if key exists and is not expired. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Delete a key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Delete all keys matching a prefix. */
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get-or-set helper: returns cached value if present, otherwise calls
   * `fetcher`, caches its result, and returns it.
   */
  async getOrSet<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      logger.debug(`Cache hit: ${key}`);
      return cached;
    }
    logger.debug(`Cache miss: ${key}`);
    const value = await fetcher();
    this.set(key, value, ttlMs);
    return value;
  }

  /** Remove all expired entries. */
  private prune(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        pruned++;
      }
    }
    if (pruned > 0) logger.debug(`Cache pruned ${pruned} expired entries`);
  }

  /** Return cache statistics. */
  stats(): { size: number; keys: string[] } {
    this.prune();
    return { size: this.store.size, keys: [...this.store.keys()] };
  }

  destroy(): void {
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    this.store.clear();
  }
}

/** Singleton cache instance shared across all services. */
export const cache = new CacheService();
