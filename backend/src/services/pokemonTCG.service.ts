/**
 * Pokemon TCG API service — pokemontcg.io
 *
 * Provides card metadata: images, sets, numbers, rarities.
 * Rate limits: 1 000 req/day (no key) or 20 000 req/day (free key).
 * Refresh cadence: weekly (card data changes rarely).
 *
 * Docs: https://docs.pokemontcg.io
 */

import axios, { AxiosInstance } from 'axios';
import { Card, CardSet, Language } from '../../../shared/types';
import { cache, TTL } from '../cache/cache.service';
import { logger } from '../logger';
import { withRetry } from '../utils/retry';

// ---------------------------------------------------------------------------
// Raw API shapes
// ---------------------------------------------------------------------------
interface TCGioSet {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
  images: { symbol: string; logo: string };
}

interface TCGioCard {
  id: string;
  name: string;
  number: string;
  rarity?: string;
  set: TCGioSet;
  types?: string[];
  hp?: string;
  images: { small: string; large: string };
}

interface TCGioPagedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  count: number;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class PokemonTCGService {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: 'https://api.pokemontcg.io/v2',
      timeout: 10_000,
      headers: {
        ...(process.env.POKEMONTCG_API_KEY
          ? { 'X-Api-Key': process.env.POKEMONTCG_API_KEY }
          : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Sets
  // -------------------------------------------------------------------------

  /**
   * GET /sets  — returns all sets.
   * Results are cached for a week.
   */
  async getSets(): Promise<CardSet[]> {
    return cache.getOrSet('tcgio:sets', () => this.fetchAllSets(), TTL.CARD_META);
  }

  private async fetchAllSets(): Promise<CardSet[]> {
    logger.info('PokemonTCG: fetching all sets');
    const { data } = await withRetry(() =>
      this.http.get<TCGioPagedResponse<TCGioSet>>('/sets', {
        params: { orderBy: '-releaseDate', pageSize: 250 },
      }),
    );
    return data.data.map(this.mapSet);
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /**
   * Fetch all cards for a set.
   * Language note: pokemontcg.io only covers English cards officially.
   * Other language data is sourced from TCGdex.
   */
  async getCardsBySet(setId: string): Promise<Card[]> {
    const key = `tcgio:cards:set:${setId}`;
    return cache.getOrSet(key, () => this.fetchCardsBySet(setId), TTL.CARD_META);
  }

  private async fetchCardsBySet(setId: string): Promise<Card[]> {
    logger.info(`PokemonTCG: fetching cards for set ${setId}`);
    const allCards: TCGioCard[] = [];
    let page = 1;
    const pageSize = 250;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await withRetry(() =>
        this.http.get<TCGioPagedResponse<TCGioCard>>('/cards', {
          params: { q: `set.id:${setId}`, page, pageSize, orderBy: 'number' },
        }),
      );
      allCards.push(...data.data);
      if (allCards.length >= data.totalCount) break;
      page++;
    }

    return allCards.map((c) => this.mapCard(c, 'EN'));
  }

  /**
   * Search cards by name (across all sets).
   */
  async searchCards(query: string, page = 1, pageSize = 20): Promise<{ cards: Card[]; total: number }> {
    const key = `tcgio:search:${query}:${page}:${pageSize}`;
    return cache.getOrSet(
      key,
      () => this.fetchSearchCards(query, page, pageSize),
      TTL.CARD_META,
    );
  }

  private async fetchSearchCards(
    query: string,
    page: number,
    pageSize: number,
  ): Promise<{ cards: Card[]; total: number }> {
    const { data } = await withRetry(() =>
      this.http.get<TCGioPagedResponse<TCGioCard>>('/cards', {
        params: { q: `name:${query}*`, page, pageSize },
      }),
    );
    return {
      cards: data.data.map((c) => this.mapCard(c, 'EN')),
      total: data.totalCount,
    };
  }

  /**
   * Fetch a single card by its pokemontcg.io ID.
   */
  async getCard(id: string): Promise<Card | null> {
    const key = `tcgio:card:${id}`;
    return cache.getOrSet(
      key,
      async () => {
        try {
          const { data } = await withRetry(() =>
            this.http.get<{ data: TCGioCard }>(`/cards/${id}`),
          );
          return this.mapCard(data.data, 'EN');
        } catch {
          return null;
        }
      },
      TTL.CARD_META,
    );
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private mapSet(s: TCGioSet): CardSet {
    return {
      id: s.id,
      name: s.name,
      series: s.series,
      printedTotal: s.printedTotal,
      total: s.total,
      releaseDate: s.releaseDate,
      symbol: s.images?.symbol,
      logo: s.images?.logo,
    };
  }

  private mapCard(c: TCGioCard, language: Language): Card {
    return {
      id: `${c.id}:${language}`,
      number: c.number,
      name: c.name,
      language,
      setId: c.set.id,
      set: this.mapSet(c.set),
      rarity: c.rarity,
      types: c.types,
      hp: c.hp ? parseInt(c.hp, 10) : undefined,
      imageSmall: c.images?.small,
      imageLarge: c.images?.large,
      tcgioId: c.id,
      updatedAt: new Date().toISOString(),
    };
  }
}

export const pokemonTCGService = new PokemonTCGService();
