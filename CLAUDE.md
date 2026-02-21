# CLAUDE.md — Pokemon TCG Arbitrage Data Pipeline

## Project Overview

Backend Node.js/TypeScript data pipeline for a React Native/Expo mobile app
that detects grading arbitrage opportunities in Pokémon TCG cards.

## Repository Structure

```
/
├── shared/
│   └── types/index.ts          # Shared TS types (Card, CardPrices, GradedPrices, …)
│                               # Used by both backend and mobile frontend
├── backend/
│   ├── src/
│   │   ├── app.ts              # Express entry point
│   │   ├── logger.ts           # Winston logger singleton
│   │   ├── cache/
│   │   │   └── cache.service.ts     # In-memory TTL cache + TTL presets
│   │   ├── services/
│   │   │   ├── pokemonTCG.service.ts     # pokemontcg.io — card metadata
│   │   │   ├── tcgdex.service.ts         # tcgdex.dev — multi-lang prices
│   │   │   ├── pokeTrace.service.ts      # poketrace.com — graded prices
│   │   │   ├── pokemonPriceTracker.service.ts  # PSA pop reports
│   │   │   ├── cardmarketCSV.service.ts  # Cardmarket daily CSV export
│   │   │   ├── currency.service.ts       # EUR/USD/JPY/GBP normalization
│   │   │   └── aggregator.service.ts     # Merges all sources with fallback
│   │   ├── utils/
│   │   │   ├── retry.ts                  # withRetry() exponential backoff
│   │   │   └── ev-roi.calculator.ts      # EV/ROI/signal computation
│   │   ├── middleware/
│   │   │   └── errorHandler.ts           # AppError + global handler
│   │   ├── routes/
│   │   │   ├── cards.routes.ts           # GET /cards, /cards/:id/prices, /graded-prices
│   │   │   ├── sets.routes.ts            # GET /sets
│   │   │   └── arbitrage.routes.ts       # GET /arbitrage-opportunities
│   │   └── jobs/
│   │       └── sync.jobs.ts              # node-cron scheduled sync jobs
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
└── README.md
```

## Key Conventions

### Card IDs

Cards are identified by a composite ID that includes language:

```
<setId>/<localId>:<LANGUAGE>
```

Examples:
- `sv1/001:EN` — Scarlet & Violet base, card 001, English
- `sv1/001:FR` — same card, French version (different prices)
- `sv1/001:JP` — Japanese version

Each language version is a **distinct entity** — never conflate prices
across languages.

### Adding a New API Source

1. Create `backend/src/services/<name>.service.ts`
2. Export a singleton instance
3. Add it to `aggregator.service.ts` with appropriate priority + fallback
4. Add cache TTL preset to `cache/cache.service.ts` if needed
5. Add a cron job in `jobs/sync.jobs.ts` for cache invalidation

### Error Handling

- Use `AppError(statusCode, code, message)` for expected HTTP errors
- Use `logger.warn()` for recoverable errors (API down → use cache)
- Use `logger.error()` for unexpected failures
- All routes catch errors with `next(err)` → `errorHandler` middleware

### Cache Pattern

Always use `cache.getOrSet(key, fetcher, TTL.PRESET)`:

```typescript
return cache.getOrSet(`prefix:${id}`, () => fetchFromAPI(id), TTL.PRICES_RAW);
```

TTL presets:
- `TTL.PRICES_RAW` — 1 hour (TCGdex)
- `TTL.PRICES_GRADED` — 6 hours (PokeTrace)
- `TTL.CARDMARKET_CSV` — 24 hours
- `TTL.CARD_META` — 7 days
- `TTL.EXCHANGE_RATES` — 4 hours
- `TTL.ARBITRAGE` — 30 minutes

### Currency Normalization

Always store prices with both `valueEUR` and `valueUSD`. Use
`currencyService.toEurAndUsd(amount, fromCurrency)`:

```typescript
const { EUR, USD } = await currencyService.toEurAndUsd(price, 'JPY');
```

### EV/ROI Calculation

Located in `utils/ev-roi.calculator.ts`. The `calculateEV()` function takes:
- Raw NM price in EUR
- Grading company
- Array of available `GradedPrice[]`

It returns `EVResult` with `ev`, `roi`, `gradeBreakdown`, and `bestGrade`.
Use `buildOpportunity()` to convert to `ArbitrageOpportunity`.

### Retry Pattern

All external API calls must use `withRetry()`:

```typescript
const { data } = await withRetry(() => http.get('/endpoint'), {
  maxAttempts: 3,
  baseDelayMs: 500,
});
```

### ToS Constraints (Important)

- **DO NOT** scrape eBay directly (ToS Feb 2026)
- **DO NOT** scrape Cardmarket HTML pages (Cloudflare + ToS)
- Use only official APIs and Cardmarket's official CSV export
- PokeTrace provides eBay aggregate prices — using their API is ToS-compliant

## Development Commands

```bash
cd backend
npm install          # Install dependencies
npm run dev          # Start with ts-node-dev (hot reload)
npm run build        # Compile to dist/
npm run type-check   # Check types without emitting
```

## Environment Variables

All documented in `backend/.env.example`. All API keys are optional —
free tiers work without keys. Set `DISABLE_CRON=true` during development
to skip the cron jobs.

## Testing

When adding features, verify:
1. Cache keys are unique and follow the `prefix:param:param` pattern
2. Language is always part of cache keys for language-aware data
3. All external calls go through `withRetry()`
4. Error paths return `null` (not throw) so aggregator can fall back
