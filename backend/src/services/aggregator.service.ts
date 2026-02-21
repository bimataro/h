/**
 * Data Aggregation Service
 *
 * Combines data from all sources:
 *   - Card metadata:   PokemonTCG (EN) + TCGdex (all languages)
 *   - Raw prices:      TCGdex + Cardmarket CSV + PokeTrace
 *   - Graded prices:   PokeTrace + PokemonPriceTracker
 *
 * Fallback strategy:
 *   If primary source is unavailable (network error / cache miss),
 *   the service falls back to the next source in priority order.
 *   Cached stale data is preferred over returning nothing.
 */

import { Card, CardPrices, GradedPrices, GradingCompany, Language, PaginatedResponse } from '../../../shared/types';
import { pokemonTCGService } from './pokemonTCG.service';
import { tcgdexService } from './tcgdex.service';
import { pokeTraceService } from './pokeTrace.service';
import { pokemonPriceTrackerService } from './pokemonPriceTracker.service';
import { cardmarketCSVService } from './cardmarketCSV.service';
import { cache, TTL } from '../cache/cache.service';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * Get a card by its composite ID: `<setId>/<localId>:<language>` (TCGdex format)
 * or `<tcgioId>:<language>` (pokemontcg.io format).
 */
export async function getCard(id: string): Promise<Card | null> {
  // Try TCGdex format first (setId/localId:lang)
  const langMatch = id.match(/:([A-Z-]+)$/);
  const language = (langMatch?.[1] ?? 'EN') as Language;
  const withoutLang = id.replace(/:([A-Z-]+)$/, '');

  if (withoutLang.includes('/')) {
    const [setId, localId] = withoutLang.split('/');
    const card = await tcgdexService.getCard(setId, localId, language);
    if (card) return card;
  }

  // Fallback: pokemontcg.io ID
  return pokemonTCGService.getCard(withoutLang);
}

/**
 * List cards with optional filters.
 */
export async function listCards(params: {
  setId?: string;
  language?: Language;
  query?: string;
  page?: number;
  pageSize?: number;
}): Promise<PaginatedResponse<Card>> {
  const { setId, language = 'EN', query, page = 1, pageSize = 20 } = params;

  if (query) {
    const { cards, total } = await pokemonTCGService.searchCards(query, page, pageSize);
    return {
      data: cards,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  if (setId) {
    const key = `agg:cards:${setId}:${language}:${page}:${pageSize}`;
    return cache.getOrSet(
      key,
      async () => {
        // Prefer TCGdex for multi-language support
        let cards: Card[] = await tcgdexService.getCardsBySet(setId, language);

        // Fallback to pokemontcg.io for EN if TCGdex returned nothing
        if (!cards.length && language === 'EN') {
          cards = await pokemonTCGService.getCardsBySet(setId);
        }

        const start = (page - 1) * pageSize;
        return {
          data: cards.slice(start, start + pageSize),
          page,
          pageSize,
          total: cards.length,
          totalPages: Math.ceil(cards.length / pageSize),
        };
      },
      TTL.CARD_META,
    );
  }

  // No filter — return empty page (too large to return all cards)
  return { data: [], page, pageSize, total: 0, totalPages: 0 };
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export async function listSets(language: Language = 'EN') {
  // Merge TCGdex sets (multi-language) with pokemontcg.io (EN authoritative)
  const [tcgdexSets, tcgioSets] = await Promise.allSettled([
    tcgdexService.getSets(language),
    pokemonTCGService.getSets(),
  ]);

  // Prefer TCGdex for language-specific data
  if (tcgdexSets.status === 'fulfilled' && tcgdexSets.value.length) {
    return tcgdexSets.value;
  }
  if (tcgioSets.status === 'fulfilled') {
    return tcgioSets.value;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Raw Prices
// ---------------------------------------------------------------------------

/**
 * Get aggregated raw (ungraded) prices for a card.
 * Priority: TCGdex → Cardmarket CSV → PokeTrace
 */
export async function getRawPrices(cardId: string, language: Language = 'EN'): Promise<CardPrices | null> {
  const key = `agg:raw-prices:${cardId}:${language}`;
  return cache.getOrSet(
    key,
    async () => {
      const results = await Promise.allSettled([
        // 1. TCGdex (Cardmarket + TCGPlayer trends)
        fetchTCGdexPrices(cardId, language),
        // 2. Cardmarket CSV (daily export — most reliable for EUR)
        fetchCSVPrices(cardId, language),
        // 3. PokeTrace (multi-market raw prices)
        pokeTraceService.getRawPrices(cardId, language),
      ]);

      const [tcgdex, csvResult, pokeTrace] = results.map((r) =>
        r.status === 'fulfilled' ? r.value : null,
      );

      // Merge: start with best source and fill gaps
      const merged: CardPrices = tcgdex ??
        csvResult ??
        pokeTrace ?? { cardId, language, raw: {}, updatedAt: Date.now() };

      // Supplement NM price from CSV if TCGdex is missing it
      if (!merged.raw['NM'] && csvResult?.raw['NM']) {
        merged.raw['NM'] = csvResult.raw['NM'];
      }

      // Add PokeTrace prices for other conditions
      if (pokeTrace) {
        for (const [condition, price] of Object.entries(pokeTrace.raw)) {
          const cond = condition as keyof typeof merged.raw;
          if (!merged.raw[cond]) {
            merged.raw[cond] = price;
          }
        }
      }

      return merged;
    },
    TTL.PRICES_RAW,
  );
}

// ---------------------------------------------------------------------------
// Graded Prices
// ---------------------------------------------------------------------------

/**
 * Get aggregated graded prices for a card.
 * Priority: PokeTrace → PokemonPriceTracker (PSA only)
 */
export async function getGradedPrices(
  cardId: string,
  language: Language = 'EN',
  companies?: GradingCompany[],
): Promise<GradedPrices | null> {
  const companiesKey = companies?.sort().join(',') ?? 'all';
  const key = `agg:graded-prices:${cardId}:${language}:${companiesKey}`;

  return cache.getOrSet(
    key,
    async () => {
      const [pokeTrace, ppt] = await Promise.allSettled([
        pokeTraceService.getGradedPrices(cardId, language),
        // PPT only covers EN cards with PSA grades
        language === 'EN'
          ? pokemonPriceTrackerService.getPSAPrices(cardId, language)
          : Promise.resolve(null),
      ]);

      const ptResult = pokeTrace.status === 'fulfilled' ? pokeTrace.value : null;
      const pptResult = ppt.status === 'fulfilled' ? ppt.value : null;

      if (!ptResult && !pptResult) return null;

      // Merge: use PokeTrace as base, add PPT PSA entries if not already present
      const merged: GradedPrices = ptResult ?? {
        cardId,
        language,
        grades: [],
        updatedAt: Date.now(),
      };

      if (pptResult) {
        const existingPSAGrades = new Set(
          merged.grades
            .filter((g) => g.company === 'PSA')
            .map((g) => g.grade),
        );
        for (const g of pptResult.grades) {
          if (!existingPSAGrades.has(g.grade)) {
            merged.grades.push(g);
          }
        }
        if (pptResult.psaPopulation) {
          merged.psaPopulation = { ...pptResult.psaPopulation, ...merged.psaPopulation };
        }
      }

      // Filter by company if requested
      if (companies?.length) {
        merged.grades = merged.grades.filter((g) => companies.includes(g.company));
      }

      return merged;
    },
    TTL.PRICES_GRADED,
  );
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function fetchTCGdexPrices(cardId: string, language: Language): Promise<CardPrices | null> {
  // cardId format: `<setId>/<localId>:<language>`
  const withoutLang = cardId.replace(/:([A-Z-]+)$/, '');
  if (!withoutLang.includes('/')) return null;
  const [setId, localId] = withoutLang.split('/');
  return tcgdexService.getPrices(setId, localId, language);
}

async function fetchCSVPrices(cardId: string, language: Language): Promise<CardPrices | null> {
  if (!cardmarketCSVService.isReady()) return null;
  // Extract name/expansion from a card lookup — simplified approach
  // In production, maintain a cardId → name+expansion mapping
  const card = await getCard(cardId);
  if (!card) return null;
  return cardmarketCSVService.getCardPrices(
    card.name,
    card.set?.name ?? '',
    card.number,
    language,
  );
}
