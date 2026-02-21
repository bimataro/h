/**
 * Cardmarket CSV Export service
 *
 * Cardmarket publishes daily price guide CSVs for all categories.
 * These are publicly accessible without authentication and contain:
 *  - NM / EX / GD / LP / PO prices per card
 *  - Trend prices and 30-day averages
 *
 * Strategy:
 *  - Download once per day via cron job
 *  - Parse and index by card name + set
 *  - Serve cached data to price queries
 *
 * Note: We do NOT scrape Cardmarket HTML pages (Cloudflare + ToS).
 * These are OFFICIAL public CSV exports explicitly provided by Cardmarket.
 *
 * Cardmarket CSV URL pattern (Pokemon category):
 *   https://www.cardmarket.com/en/Pokemon/Exportrange?idCategory=3&format=csv
 *
 * Per ToS, usage must be non-commercial or have an explicit commercial license.
 */

import axios from 'axios';
import { parse as csvParse } from 'csv-parse/sync';
import { CardPrices, Language } from '../../../shared/types';
import { cache, TTL } from '../cache/cache.service';
import { currencyService } from './currency.service';
import { logger } from '../logger';
import { withRetry } from '../utils/retry';

// ---------------------------------------------------------------------------
// Raw CSV row shape
// ---------------------------------------------------------------------------
interface CMCSVRow {
  idProduct: string;
  Name: string;
  Expansion: string;
  Number?: string;
  Rarity?: string;
  /** Sell price NM */
  'Sell Price'?: string;
  'Low Price'?: string;
  'Trend Price'?: string;
  'Avg1'?: string;
  'Avg7'?: string;
  'Avg30'?: string;
}

// Internal index structure
interface CMCardEntry {
  name: string;
  expansion: string;
  number?: string;
  sellPriceEUR?: number;
  lowPriceEUR?: number;
  trendPriceEUR?: number;
  avg1?: number;
  avg7?: number;
  avg30?: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class CardmarketCSVService {
  /** In-memory index: `${name}:${expansion}` → entry */
  private index: Map<string, CMCardEntry> = new Map();
  private lastDownload = 0;

  /**
   * Download and parse the Cardmarket CSV price guide.
   * Called by the daily cron job.
   */
  async downloadAndIndex(): Promise<{ indexed: number }> {
    const url =
      process.env.CARDMARKET_CSV_URL ||
      'https://www.cardmarket.com/en/Pokemon/Exportrange?idCategory=3&format=csv';

    logger.info('Cardmarket CSV: starting download');

    try {
      const { data: raw } = await withRetry(
        () =>
          axios.get<string>(url, {
            responseType: 'text',
            timeout: 60_000,
            headers: {
              'Accept-Encoding': 'gzip',
              'User-Agent': 'PokemonTCGArbitrageApp/1.0 (price-guide-download)',
            },
          }),
        { maxAttempts: 3, baseDelayMs: 2_000 },
      );

      const rows: CMCSVRow[] = csvParse(raw, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ';',
        trim: true,
      });

      this.index.clear();
      let indexed = 0;

      for (const row of rows) {
        const entry: CMCardEntry = {
          name: row.Name?.trim() ?? '',
          expansion: row.Expansion?.trim() ?? '',
          number: row.Number?.trim(),
          sellPriceEUR: this.parsePrice(row['Sell Price']),
          lowPriceEUR: this.parsePrice(row['Low Price']),
          trendPriceEUR: this.parsePrice(row['Trend Price']),
          avg1: this.parsePrice(row['Avg1']),
          avg7: this.parsePrice(row['Avg7']),
          avg30: this.parsePrice(row['Avg30']),
        };

        if (!entry.name) continue;

        const key = this.buildKey(entry.name, entry.expansion, entry.number);
        this.index.set(key, entry);
        indexed++;
      }

      this.lastDownload = Date.now();
      cache.set('cm-csv:lastDownload', this.lastDownload, TTL.CARDMARKET_CSV);
      logger.info(`Cardmarket CSV: indexed ${indexed} entries`);
      return { indexed };
    } catch (err) {
      logger.error({ err }, 'Cardmarket CSV: download failed');
      throw err;
    }
  }

  /**
   * Look up a card's Cardmarket prices by name + expansion.
   * Returns null if no data available (CSV not yet downloaded or card not found).
   */
  async getCardPrices(
    name: string,
    expansion: string,
    number: string | undefined,
    language: Language,
  ): Promise<CardPrices | null> {
    if (this.index.size === 0) return null;

    const key = this.buildKey(name, expansion, number);
    const entry = this.index.get(key);
    if (!entry) return null;

    const nmPrice = entry.trendPriceEUR ?? entry.sellPriceEUR;
    if (!nmPrice) return null;

    const now = Date.now();
    const { EUR, USD } = await currencyService.toEurAndUsd(nmPrice, 'EUR');

    const cardId = `cm:${name}:${expansion}:${language}`;
    const prices: CardPrices = {
      cardId,
      language,
      raw: {
        NM: {
          value: nmPrice,
          currency: 'EUR',
          valueEUR: EUR,
          valueUSD: USD,
          fetchedAt: now,
          source: 'cardmarket-csv',
        },
      },
      trends: {
        cardmarket: {
          value: nmPrice,
          currency: 'EUR',
          delta1d: entry.avg1 !== undefined ? nmPrice - entry.avg1 : undefined,
          delta7d: entry.avg7 !== undefined ? nmPrice - entry.avg7 : undefined,
          delta30d: entry.avg30 !== undefined ? nmPrice - entry.avg30 : undefined,
        },
      },
      updatedAt: now,
    };

    // LP price if available
    if (entry.lowPriceEUR) {
      const lp = await currencyService.toEurAndUsd(entry.lowPriceEUR, 'EUR');
      prices.raw['LP'] = {
        value: entry.lowPriceEUR,
        currency: 'EUR',
        valueEUR: lp.EUR,
        valueUSD: lp.USD,
        fetchedAt: now,
        source: 'cardmarket-csv',
      };
    }

    return prices;
  }

  /** Whether we have CSV data loaded. */
  isReady(): boolean {
    return this.index.size > 0;
  }

  /** Last successful download timestamp (ms). */
  getLastDownload(): number {
    return this.lastDownload;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildKey(name: string, expansion: string, number?: string): string {
    const base = `${name.toLowerCase()}:${expansion.toLowerCase()}`;
    return number ? `${base}:${number}` : base;
  }

  private parsePrice(raw?: string): number | undefined {
    if (!raw || raw.trim() === '' || raw === 'N/A') return undefined;
    const n = parseFloat(raw.replace(',', '.'));
    return isNaN(n) ? undefined : n;
  }
}

export const cardmarketCSVService = new CardmarketCSVService();
