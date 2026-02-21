# Pokemon TCG Arbitrage — Data Pipeline

Backend Node.js/TypeScript data pipeline for a React Native / Expo mobile app that identifies grading arbitrage opportunities in Pokémon TCG cards.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    REST API (Express)                     │
│  GET /cards   GET /sets   GET /arbitrage-opportunities   │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────▼──────────┐
            │  Aggregator Service  │  ← merges all sources
            └──┬──┬──┬──┬─────────┘
               │  │  │  │
   ┌───────────┘  │  │  └──────────────────────┐
   ▼              │  │                          ▼
TCGdex API     PokeTrace  PokemonPriceTracker  Cardmarket CSV
(prices EN–JP) (graded)   (PSA pop reports)  (daily export)
               │  │
               └──┴──────────────────────────────────────┐
                                                         ▼
                                               pokemontcg.io
                                               (card metadata)
                       │
            ┌──────────▼──────────┐
            │    In-Memory Cache   │  TTL per source
            └─────────────────────┘
```

## Data Sources

| Source | Data | Rate Limit | Auth |
|--------|------|-----------|------|
| [pokemontcg.io](https://pokemontcg.io) | Card metadata, sets, images | 1K/day (no key) · 20K/day (free key) | Optional |
| [tcgdex.dev](https://tcgdex.dev) | Prices EN–JP, trends 1/7/30d | Courteous use | None |
| [poketrace.com](https://poketrace.com/developers) | Graded PSA/BGS/CGC/SGC/ACE + raw by condition | Free tier | Optional |
| [pokemonpricetracker.com](https://pokemonpricetracker.com) | PSA pop reports + history | 100/day free | Optional |
| Cardmarket CSV | NM/LP/Trend prices (EUR) | Daily download | None |

## API Endpoints

### Cards

```
GET /cards
  ?setId=sv1          filter by set
  ?language=FR        card language (EN FR JP DE ES IT PT KO ZH-TW ZH-CN NL PL RU)
  ?q=Charizard        name search
  ?page=1 &pageSize=20

GET /cards/:id
  :id = <setId>/<localId>:<LANG>   e.g. sv1/001:FR

GET /cards/:id/prices
  Returns: CardPrices (NM/LP/MP/HP/DMG + trends)

GET /cards/:id/graded-prices
  ?companies=PSA,BGS   filter companies
  Returns: GradedPrices (all grades for requested companies)
```

### Sets

```
GET /sets
  ?language=FR

GET /sets/:id
```

### Arbitrage

```
GET /arbitrage-opportunities
  ?setId=sv1          limit to one set
  ?language=FR        card language
  ?company=PSA        grading company (PSA BGS CGC SGC ACE) default PSA
  ?minRoi=20          minimum ROI % (default 20)
  ?signal=strong-buy  filter by signal (strong-buy | buy | neutral | avoid)
  ?page=1 &pageSize=20

POST /arbitrage-opportunities/calculate
  Body: { cardId, language?, company? }
  Returns: EVResult with full grade breakdown
```

### Health

```
GET /health  → { status: "ok", ts: <unix ms> }
```

## EV / ROI Formula

```
totalCost = rawPrice + gradingFee + shippingBothWays
EV        = Σ P(grade_i) × salePrice(grade_i) − totalCost
ROI       = EV / totalCost × 100%
```

**Signal thresholds** (configurable via env):
- `strong-buy` : ROI ≥ 50%
- `buy`        : ROI ≥ 20%
- `neutral`    : ROI ≥ 0%
- `avoid`      : ROI < 0%

## Multi-Language Support

Each card language version is treated as a **distinct entity** with its own ID and prices:

- `sv1/001:EN` — Scarlet & Violet base, card #001, English
- `sv1/001:FR` — same card, French version
- `sv1/001:JP` — Japanese version (often different price)

## Cache TTL Policy

| Data | TTL | Job |
|------|-----|-----|
| Raw prices (TCGdex) | 1 hour | Evict every hour |
| Graded prices (PokeTrace) | 6 hours | Evict every 6h |
| Cardmarket CSV | 24 hours | Download daily at 03:00 UTC |
| Card metadata | 7 days | Evict weekly on Sunday 02:00 UTC |
| Exchange rates | 4 hours | Refresh every 4h |
| Arbitrage results | 30 min | Evict every 30min |

## Getting Started

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — all API keys are optional for basic usage
npm run dev
```

## Shared Types

TypeScript types are in `shared/types/index.ts` and are imported by both
the backend and the React Native frontend. Key types:

- `Card` — card entity (language-aware)
- `CardPrices` — raw NM/LP/MP/HP/DMG prices with trends
- `GradedPrices` — PSA/BGS/CGC graded prices with population data
- `ArbitrageOpportunity` — computed EV/ROI with buy signal

## Constraints

- No eBay scraping (ToS February 2026)
- No Cardmarket HTML scraping (Cloudflare + ToS)
- Only official APIs and Cardmarket's official CSV export
