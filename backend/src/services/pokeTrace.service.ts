/**
 * PokeTrace API service — poketrace.com/developers
 *
 * Provides:
 *  - Graded prices: PSA / BGS / CGC / SGC / ACE (all grades)
 *  - Raw (ungraded) prices by condition (NM, LP, MP, HP, DMG)
 *  - 3 markets: TCGPlayer, eBay, Cardmarket
 *
 * Free tier (no key) with basic rate limiting.
 * Refresh cadence: every 6 hours for graded prices.
 *
 * Note: PokeTrace aggregates sales data — eBay prices included here
 * are provided BY PokeTrace (not scraped by us), so ToS compliant.
 *
 * Docs: https://www.poketrace.com/developers
 */

import axios, { AxiosInstance } from 'axios';
import { CardPrices, CardCondition, GradedPrice, GradedPrices, GradingCompany, Language } from '../../../shared/types';
import { cache, TTL } from '../cache/cache.service';
import { currencyService } from './currency.service';
import { logger } from '../logger';
import { withRetry } from '../utils/retry';

// ---------------------------------------------------------------------------
// Raw API shapes (inferred from PokeTrace docs)
// ---------------------------------------------------------------------------
interface PokeTraceRawPrice {
  condition: string;
  market: string;
  price: number;
  currency: string;
  salesCount?: number;
}

interface PokeTraceGradedPrice {
  company: string;
  grade: number;
  market: string;
  price: number;
  currency: string;
  salesCount?: number;
  population?: number;
}

interface PokeTraceCardResponse {
  cardId: string;
  name?: string;
  language?: string;
  rawPrices?: PokeTraceRawPrice[];
  gradedPrices?: PokeTraceGradedPrice[];
  updatedAt?: string;
}

// Map PokeTrace condition strings → our CardCondition
const CONDITION_MAP: Record<string, CardCondition> = {
  NM: 'NM',
  'Near Mint': 'NM',
  LP: 'LP',
  'Lightly Played': 'LP',
  MP: 'MP',
  'Moderately Played': 'MP',
  HP: 'HP',
  'Heavily Played': 'HP',
  DMG: 'DMG',
  Damaged: 'DMG',
};

const COMPANY_MAP: Record<string, GradingCompany> = {
  PSA: 'PSA',
  BGS: 'BGS',
  CGC: 'CGC',
  SGC: 'SGC',
  ACE: 'ACE',
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class PokeTraceService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: process.env.POKETRACE_BASE_URL || 'https://api.poketrace.com/v1',
      timeout: 10_000,
      headers: {
        ...(process.env.POKETRACE_API_KEY
          ? { Authorization: `Bearer ${process.env.POKETRACE_API_KEY}` }
          : {}),
        'User-Agent': 'PokemonTCGArbitrageApp/1.0',
      },
    });
  }

  // -------------------------------------------------------------------------
  // Raw prices
  // -------------------------------------------------------------------------

  /**
   * Get raw (ungraded) prices for a card from PokeTrace.
   * Complements TCGdex data with eBay market prices.
   */
  async getRawPrices(cardId: string, language: Language = 'EN'): Promise<CardPrices | null> {
    const key = `poketrace:raw:${cardId}:${language}`;
    return cache.getOrSet(key, () => this.fetchRawPrices(cardId, language), TTL.PRICES_RAW);
  }

  private async fetchRawPrices(cardId: string, language: Language): Promise<CardPrices | null> {
    try {
      const { data } = await withRetry(() =>
        this.http.get<PokeTraceCardResponse>(`/cards/${encodeURIComponent(cardId)}/prices`, {
          params: { language, type: 'raw' },
        }),
      );

      if (!data.rawPrices?.length) return null;
      return await this.mapRawPrices(cardId, language, data.rawPrices);
    } catch (err) {
      logger.warn({ err, cardId, language }, 'PokeTrace: raw price fetch failed');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Graded prices
  // -------------------------------------------------------------------------

  /**
   * Get graded prices (all companies, all grades) for a card.
   */
  async getGradedPrices(cardId: string, language: Language = 'EN'): Promise<GradedPrices | null> {
    const key = `poketrace:graded:${cardId}:${language}`;
    return cache.getOrSet(key, () => this.fetchGradedPrices(cardId, language), TTL.PRICES_GRADED);
  }

  private async fetchGradedPrices(cardId: string, language: Language): Promise<GradedPrices | null> {
    try {
      const { data } = await withRetry(() =>
        this.http.get<PokeTraceCardResponse>(`/cards/${encodeURIComponent(cardId)}/prices`, {
          params: { language, type: 'graded' },
        }),
      );

      if (!data.gradedPrices?.length) return null;
      return await this.mapGradedPrices(cardId, language, data.gradedPrices);
    } catch (err) {
      logger.warn({ err, cardId, language }, 'PokeTrace: graded price fetch failed');
      return null;
    }
  }

  /**
   * Get both raw and graded prices in a single API call (if supported).
   */
  async getAllPrices(
    cardId: string,
    language: Language = 'EN',
  ): Promise<{ raw: CardPrices | null; graded: GradedPrices | null }> {
    const key = `poketrace:all:${cardId}:${language}`;
    return cache.getOrSet(
      key,
      async () => {
        try {
          const { data } = await withRetry(() =>
            this.http.get<PokeTraceCardResponse>(`/cards/${encodeURIComponent(cardId)}/prices`, {
              params: { language },
            }),
          );
          const [raw, graded] = await Promise.all([
            data.rawPrices?.length
              ? this.mapRawPrices(cardId, language, data.rawPrices)
              : Promise.resolve(null),
            data.gradedPrices?.length
              ? this.mapGradedPrices(cardId, language, data.gradedPrices)
              : Promise.resolve(null),
          ]);
          return { raw, graded };
        } catch (err) {
          logger.warn({ err, cardId, language }, 'PokeTrace: all prices fetch failed');
          return { raw: null, graded: null };
        }
      },
      TTL.PRICES_GRADED,
    );
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private async mapRawPrices(
    cardId: string,
    language: Language,
    rawPrices: PokeTraceRawPrice[],
  ): Promise<CardPrices> {
    const now = Date.now();
    const prices: CardPrices = { cardId, language, raw: {}, updatedAt: now };

    for (const p of rawPrices) {
      const condition = CONDITION_MAP[p.condition];
      if (!condition) continue;

      const currency = (p.currency?.toUpperCase() ?? 'USD') as 'EUR' | 'USD' | 'JPY' | 'GBP';
      const { EUR, USD } = await currencyService.toEurAndUsd(p.price, currency);

      // Prefer market with best data — TCGPlayer first, then eBay, then Cardmarket
      if (prices.raw[condition] && p.market === 'cardmarket') continue;
      prices.raw[condition] = {
        value: p.price,
        currency,
        valueEUR: EUR,
        valueUSD: USD,
        fetchedAt: now,
        source: 'poketrace',
      };
    }

    return prices;
  }

  private async mapGradedPrices(
    cardId: string,
    language: Language,
    gradedPrices: PokeTraceGradedPrice[],
  ): Promise<GradedPrices> {
    const now = Date.now();
    const grades: GradedPrice[] = [];

    for (const p of gradedPrices) {
      const company = COMPANY_MAP[p.company.toUpperCase()];
      if (!company) continue;

      const currency = (p.currency?.toUpperCase() ?? 'USD') as 'EUR' | 'USD' | 'JPY' | 'GBP';
      const { EUR, USD } = await currencyService.toEurAndUsd(p.price, currency);

      grades.push({
        company,
        grade: p.grade,
        marketPrice: p.price,
        currency,
        marketPriceEUR: EUR,
        marketPriceUSD: USD,
        population: p.population,
        salesCount: p.salesCount,
        source: 'poketrace',
        fetchedAt: now,
      });
    }

    return { cardId, language, grades, updatedAt: now };
  }
}

export const pokeTraceService = new PokeTraceService();
