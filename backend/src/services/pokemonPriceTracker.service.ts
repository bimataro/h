/**
 * PokemonPriceTracker API service — pokemonpricetracker.com
 *
 * Provides:
 *  - PSA grades 1–10 market prices
 *  - Population reports (number of cards graded at each grade)
 *  - Price history
 *
 * Free tier: 100 req/day.
 * Paid tier: $9.99/month for 20 000 req/day.
 *
 * Strategy: use this as a cross-reference / complement to PokeTrace.
 * Cache aggressively (6h) to stay within free tier.
 *
 * Docs: https://pokemonpricetracker.com/api
 */

import axios, { AxiosInstance } from 'axios';
import { GradedPrice, GradedPrices, Language } from '../../../shared/types';
import { cache, TTL } from '../cache/cache.service';
import { currencyService } from './currency.service';
import { logger } from '../logger';
import { withRetry } from '../utils/retry';

// ---------------------------------------------------------------------------
// Raw API shapes
// ---------------------------------------------------------------------------
interface PPTGradeEntry {
  grade: number;
  marketValue?: number;
  avgValue?: number;
  population?: number;
  recentSales?: number;
}

interface PPTCardResponse {
  id: string;
  name: string;
  set?: string;
  number?: string;
  psaData?: {
    grades?: PPTGradeEntry[];
    totalPop?: number;
  };
  priceHistory?: Array<{ date: string; grade: number; price: number }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class PokemonPriceTrackerService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: process.env.PPT_BASE_URL || 'https://api.pokemonpricetracker.com/v1',
      timeout: 10_000,
      headers: {
        ...(process.env.PPT_API_KEY
          ? { 'X-Api-Key': process.env.PPT_API_KEY }
          : {}),
        'User-Agent': 'PokemonTCGArbitrageApp/1.0',
      },
    });
  }

  /**
   * Get PSA graded prices + population report for a card.
   * `cardId` should be the pokemontcg.io card ID (e.g. "sv1-001").
   * Language parameter: PPT mainly covers EN cards, but accepts lang param.
   */
  async getPSAPrices(cardId: string, language: Language = 'EN'): Promise<GradedPrices | null> {
    const key = `ppt:psa:${cardId}:${language}`;
    return cache.getOrSet(key, () => this.fetchPSAPrices(cardId, language), TTL.PRICES_GRADED);
  }

  private async fetchPSAPrices(cardId: string, language: Language): Promise<GradedPrices | null> {
    try {
      const { data } = await withRetry(() =>
        this.http.get<PPTCardResponse>(`/cards/${encodeURIComponent(cardId)}`, {
          params: { lang: language.toLowerCase() },
        }),
      );

      if (!data.psaData?.grades?.length) return null;
      return await this.mapGradedPrices(cardId, language, data);
    } catch (err) {
      logger.warn({ err, cardId, language }, 'PokemonPriceTracker: PSA price fetch failed');
      return null;
    }
  }

  /**
   * Get price history for a card at a specific PSA grade.
   */
  async getPriceHistory(
    cardId: string,
    grade: number,
    language: Language = 'EN',
  ): Promise<Array<{ date: string; price: number }>> {
    const key = `ppt:history:${cardId}:${grade}:${language}`;
    return cache.getOrSet(
      key,
      async () => {
        try {
          const { data } = await withRetry(() =>
            this.http.get<PPTCardResponse>(`/cards/${encodeURIComponent(cardId)}/history`, {
              params: { grade, lang: language.toLowerCase() },
            }),
          );
          return (data.priceHistory ?? [])
            .filter((h) => h.grade === grade)
            .map((h) => ({ date: h.date, price: h.price }));
        } catch (err) {
          logger.warn({ err, cardId, grade }, 'PokemonPriceTracker: price history fetch failed');
          return [];
        }
      },
      TTL.PRICES_GRADED,
    );
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private async mapGradedPrices(
    cardId: string,
    language: Language,
    data: PPTCardResponse,
  ): Promise<GradedPrices> {
    const now = Date.now();
    const grades: GradedPrice[] = [];
    const psaPopulation: Record<string, number> = {};

    for (const g of data.psaData?.grades ?? []) {
      const price = g.marketValue ?? g.avgValue;
      if (!price) continue;

      const { EUR, USD } = await currencyService.toEurAndUsd(price, 'USD');
      grades.push({
        company: 'PSA',
        grade: g.grade,
        marketPrice: price,
        currency: 'USD',
        marketPriceEUR: EUR,
        marketPriceUSD: USD,
        population: g.population,
        salesCount: g.recentSales,
        source: 'pokemonpricetracker',
        fetchedAt: now,
      });

      if (g.population !== undefined) {
        psaPopulation[String(g.grade)] = g.population;
      }
    }

    return {
      cardId,
      language,
      grades,
      psaPopulation: Object.keys(psaPopulation).length ? psaPopulation : undefined,
      updatedAt: now,
    };
  }
}

export const pokemonPriceTrackerService = new PokemonPriceTrackerService();
