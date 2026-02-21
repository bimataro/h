/**
 * TCGdex API service — tcgdex.dev
 *
 * Provides:
 *  - Card data in 14 languages (EN, FR, DE, ES, IT, PT, NL, PL, JP, ZH-TW, ZH-CN, KO, RU, ...)
 *  - Cardmarket (EUR) and TCGPlayer (USD) prices with 1/7/30-day trends
 *
 * No API key required.
 * Rate limit: courteous use expected (no documented hard limit).
 * Refresh cadence: hourly for prices.
 *
 * Docs: https://api.tcgdex.dev
 */

import axios, { AxiosInstance } from 'axios';
import { Card, CardPrices, CardSet, Currency, Language, MarketPrice, PriceTrend } from '../../../shared/types';
import { cache, TTL } from '../cache/cache.service';
import { currencyService } from './currency.service';
import { logger } from '../logger';
import { withRetry } from '../utils/retry';

// ---------------------------------------------------------------------------
// Raw API shapes (subset of TCGdex response)
// ---------------------------------------------------------------------------
interface TCGdexCardBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

interface TCGdexPrices {
  cardmarket?: {
    prices?: {
      averageSellPrice?: number;
      lowPrice?: number;
      trendPrice?: number;
      avg1?: number;
      avg7?: number;
      avg30?: number;
    };
    updatedAt?: string;
  };
  tcgplayer?: {
    prices?: {
      normal?: { low?: number; mid?: number; market?: number; directLow?: number };
      holofoil?: { low?: number; mid?: number; market?: number };
    };
    updatedAt?: string;
  };
}

interface TCGdexCardFull extends TCGdexCardBrief {
  rarity?: string;
  hp?: number;
  types?: string[];
  set?: {
    id: string;
    name: string;
    serie?: { name: string };
    cardCount?: { total: number; official: number };
    releaseDate?: string;
    logo?: string;
    symbol?: string;
  };
  variants?: { holo?: boolean; reverse?: boolean; firstEdition?: boolean };
  price?: TCGdexPrices;
}

interface TCGdexSetFull {
  id: string;
  name: string;
  serie?: { name: string };
  cardCount?: { total: number; official: number };
  releaseDate?: string;
  logo?: string;
  symbol?: string;
  cards?: TCGdexCardBrief[];
}

// Language → TCGdex lang code mapping
const LANG_MAP: Partial<Record<Language, string>> = {
  EN: 'en',
  FR: 'fr',
  DE: 'de',
  ES: 'es',
  IT: 'it',
  PT: 'pt',
  NL: 'nl',
  PL: 'pl',
  JP: 'ja',
  'ZH-TW': 'zh-tw',
  'ZH-CN': 'zh-cn',
  KO: 'ko',
  RU: 'ru',
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class TCGdexService {
  private readonly clients: Map<Language, AxiosInstance> = new Map();

  private getClient(language: Language): AxiosInstance {
    const existing = this.clients.get(language);
    if (existing) return existing;

    const lang = LANG_MAP[language] ?? 'en';
    const client = axios.create({
      baseURL: `https://api.tcgdex.net/v2/${lang}`,
      timeout: 10_000,
    });
    this.clients.set(language, client);
    return client;
  }

  // -------------------------------------------------------------------------
  // Sets
  // -------------------------------------------------------------------------

  async getSets(language: Language = 'EN'): Promise<CardSet[]> {
    const key = `tcgdex:sets:${language}`;
    return cache.getOrSet(key, () => this.fetchSets(language), TTL.CARD_META);
  }

  private async fetchSets(language: Language): Promise<CardSet[]> {
    logger.info(`TCGdex: fetching sets (${language})`);
    const http = this.getClient(language);
    const { data } = await withRetry(() => http.get<TCGdexSetFull[]>('/sets'));
    return data.map(this.mapSet);
  }

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  async getCardsBySet(setId: string, language: Language = 'EN'): Promise<Card[]> {
    const key = `tcgdex:cards:${setId}:${language}`;
    return cache.getOrSet(key, () => this.fetchCardsBySet(setId, language), TTL.CARD_META);
  }

  private async fetchCardsBySet(setId: string, language: Language): Promise<Card[]> {
    logger.info(`TCGdex: fetching cards for set ${setId} (${language})`);
    const http = this.getClient(language);
    try {
      const { data } = await withRetry(() => http.get<TCGdexSetFull>(`/sets/${setId}`));
      const set = this.mapSet(data);
      return (data.cards ?? []).map((c) => this.mapCardBrief(c, set, language, data.id));
    } catch (err) {
      logger.warn({ err, setId, language }, 'TCGdex: set fetch failed');
      return [];
    }
  }

  /**
   * Fetch full card data including prices.
   * cardId format: "<setId>/<localId>" (e.g. "sv1/001")
   */
  async getCard(setId: string, localId: string, language: Language = 'EN'): Promise<Card | null> {
    const key = `tcgdex:card:${setId}:${localId}:${language}`;
    return cache.getOrSet(
      key,
      () => this.fetchCard(setId, localId, language),
      TTL.CARD_META,
    );
  }

  private async fetchCard(setId: string, localId: string, language: Language): Promise<Card | null> {
    const http = this.getClient(language);
    try {
      const { data } = await withRetry(() =>
        http.get<TCGdexCardFull>(`/sets/${setId}/${localId}`),
      );
      return this.mapCardFull(data, language, setId);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Prices
  // -------------------------------------------------------------------------

  /**
   * Get raw (ungraded) prices for a card.
   * Returns Cardmarket (EUR) and TCGPlayer (USD) data.
   */
  async getPrices(setId: string, localId: string, language: Language = 'EN'): Promise<CardPrices | null> {
    const key = `tcgdex:prices:${setId}:${localId}:${language}`;
    return cache.getOrSet(
      key,
      () => this.fetchPrices(setId, localId, language),
      TTL.PRICES_RAW,
    );
  }

  private async fetchPrices(setId: string, localId: string, language: Language): Promise<CardPrices | null> {
    const http = this.getClient(language);
    try {
      const { data } = await withRetry(() =>
        http.get<TCGdexCardFull>(`/sets/${setId}/${localId}`),
      );

      const priceData = data.price;
      if (!priceData) return null;

      const cardId = `${setId}/${localId}:${language}`;
      return await this.mapPrices(cardId, language, priceData);
    } catch (err) {
      logger.warn({ err, setId, localId, language }, 'TCGdex: price fetch failed');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Mappers
  // -------------------------------------------------------------------------

  private mapSet(s: TCGdexSetFull): CardSet {
    return {
      id: s.id,
      name: s.name,
      series: s.serie?.name ?? '',
      printedTotal: s.cardCount?.official ?? 0,
      total: s.cardCount?.total ?? 0,
      releaseDate: s.releaseDate ?? '',
      symbol: s.symbol,
      logo: s.logo,
    };
  }

  private mapCardBrief(c: TCGdexCardBrief, set: CardSet, language: Language, setId: string): Card {
    return {
      id: `${setId}/${c.localId}:${language}`,
      number: c.localId,
      name: c.name,
      language,
      setId: set.id,
      set,
      imageSmall: c.image ? `${c.image}/low.webp` : undefined,
      imageLarge: c.image ? `${c.image}/high.webp` : undefined,
      tcgdexId: c.id,
      updatedAt: new Date().toISOString(),
    };
  }

  private mapCardFull(c: TCGdexCardFull, language: Language, setId: string): Card {
    const set: CardSet = c.set
      ? {
          id: c.set.id,
          name: c.set.name,
          series: c.set.serie?.name ?? '',
          printedTotal: c.set.cardCount?.official ?? 0,
          total: c.set.cardCount?.total ?? 0,
          releaseDate: c.set.releaseDate ?? '',
          symbol: c.set.symbol,
          logo: c.set.logo,
        }
      : { id: setId, name: '', series: '', printedTotal: 0, total: 0, releaseDate: '' };

    return {
      id: `${setId}/${c.localId}:${language}`,
      number: c.localId,
      name: c.name,
      language,
      setId,
      set,
      rarity: c.rarity,
      types: c.types,
      hp: c.hp,
      imageSmall: c.image ? `${c.image}/low.webp` : undefined,
      imageLarge: c.image ? `${c.image}/high.webp` : undefined,
      isHolo: c.variants?.holo,
      tcgdexId: c.id,
      updatedAt: new Date().toISOString(),
    };
  }

  private async mapPrices(cardId: string, language: Language, raw: TCGdexPrices): Promise<CardPrices> {
    const now = Date.now();
    const prices: CardPrices = {
      cardId,
      language,
      raw: {},
      trends: {},
      updatedAt: now,
    };

    // Cardmarket prices (EUR)
    if (raw.cardmarket?.prices) {
      const p = raw.cardmarket.prices;
      const nmPrice = p.trendPrice ?? p.averageSellPrice;
      if (nmPrice) {
        const { EUR, USD } = await currencyService.toEurAndUsd(nmPrice, 'EUR');
        const marketPrice: MarketPrice = {
          value: nmPrice,
          currency: 'EUR',
          valueEUR: EUR,
          valueUSD: USD,
          fetchedAt: now,
          source: 'cardmarket',
        };
        prices.raw['NM'] = marketPrice;
      }

      // Trends
      const trend: PriceTrend = {
        value: p.trendPrice ?? 0,
        currency: 'EUR' as Currency,
        delta1d: p.avg1 && p.trendPrice ? p.trendPrice - p.avg1 : undefined,
        delta7d: p.avg7 && p.trendPrice ? p.trendPrice - p.avg7 : undefined,
        delta30d: p.avg30 && p.trendPrice ? p.trendPrice - p.avg30 : undefined,
      };
      prices.trends!.cardmarket = trend;
    }

    // TCGPlayer prices (USD)
    if (raw.tcgplayer?.prices) {
      const p = raw.tcgplayer.prices;
      const nmPrice = p.normal?.market ?? p.holofoil?.market;
      if (nmPrice) {
        const { EUR, USD } = await currencyService.toEurAndUsd(nmPrice, 'USD');
        const marketPrice: MarketPrice = {
          value: nmPrice,
          currency: 'USD',
          valueEUR: EUR,
          valueUSD: USD,
          fetchedAt: now,
          source: 'tcgplayer',
        };
        // Only overwrite NM if we don't have cardmarket data
        if (!prices.raw['NM']) {
          prices.raw['NM'] = marketPrice;
        }
        prices.trends!.tcgplayer = {
          value: nmPrice,
          currency: 'USD' as Currency,
        };
      }
    }

    return prices;
  }
}

export const tcgdexService = new TCGdexService();
