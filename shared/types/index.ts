// =============================================================================
// SHARED TYPES — Pokemon TCG Arbitrage App
// Shared between backend (Node.js) and frontend (React Native / Expo)
// =============================================================================

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type Language = 'EN' | 'FR' | 'JP' | 'DE' | 'ES' | 'IT' | 'PT' | 'KO' | 'ZH-TW' | 'ZH-CN' | 'NL' | 'PL' | 'RU';
export type Currency = 'EUR' | 'USD' | 'JPY' | 'GBP';
export type CardCondition = 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
export type GradingCompany = 'PSA' | 'BGS' | 'CGC' | 'SGC' | 'ACE';
export type Rarity = 'Common' | 'Uncommon' | 'Rare' | 'Rare Holo' | 'Rare Holo EX' | 'Ultra Rare' | 'Secret Rare' | 'Hyper Rare' | 'Special Illustration Rare' | 'Illustration Rare' | string;

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardSet {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  releaseDate: string;
  symbol?: string;
  logo?: string;
}

export interface Card {
  id: string;
  /** e.g. "sv1-001" */
  number: string;
  name: string;
  /** Language of this specific card version */
  language: Language;
  setId: string;
  set?: CardSet;
  rarity?: Rarity;
  types?: string[];
  hp?: number;
  imageSmall?: string;
  imageLarge?: string;
  /** True if holographic / foil */
  isHolo?: boolean;
  /** Original ID from pokemontcg.io */
  tcgioId?: string;
  /** ID from TCGdex */
  tcgdexId?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Raw (ungraded) Prices
// ---------------------------------------------------------------------------

export interface MarketPrice {
  /** Price in original currency */
  value: number;
  currency: Currency;
  /** Price normalised to EUR */
  valueEUR: number;
  /** Price normalised to USD */
  valueUSD: number;
  /** Unix timestamp */
  fetchedAt: number;
  source: PriceSource;
}

export type PriceSource = 'tcgdex' | 'tcgplayer' | 'cardmarket' | 'cardmarket-csv' | 'poketrace' | 'pokemonpricetracker';

export interface PriceTrend {
  value: number;
  currency: Currency;
  delta1d?: number;
  delta7d?: number;
  delta30d?: number;
}

export interface CardPrices {
  cardId: string;
  language: Language;
  /** Condition → price */
  raw: Partial<Record<CardCondition, MarketPrice>>;
  /** Cardmarket / TCGdex trends */
  trends?: {
    cardmarket?: PriceTrend;
    tcgplayer?: PriceTrend;
  };
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Graded Prices
// ---------------------------------------------------------------------------

export type PSAGrade = 1 | 1.5 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 8.5 | 9 | 10;
export type BGSGrade = 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4 | 4.5 | 5 | 5.5 | 6 | 6.5 | 7 | 7.5 | 8 | 8.5 | 9 | 9.5 | 10;
export type CGCGrade = 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4 | 4.5 | 5 | 5.5 | 6 | 6.5 | 7 | 7.5 | 8 | 8.5 | 9 | 9.5 | 10;

export interface GradedPrice {
  company: GradingCompany;
  grade: number;
  /** Market price in original currency */
  marketPrice: number;
  currency: Currency;
  /** Market price normalised to EUR */
  marketPriceEUR: number;
  /** Market price normalised to USD */
  marketPriceUSD: number;
  /** Population (number of cards graded at this grade) */
  population?: number;
  /** Number of sales used to compute price */
  salesCount?: number;
  source: PriceSource;
  fetchedAt: number;
}

export interface GradedPrices {
  cardId: string;
  language: Language;
  grades: GradedPrice[];
  /** PSA population report */
  psaPopulation?: Record<string, number>;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Arbitrage
// ---------------------------------------------------------------------------

export interface GradingCost {
  company: GradingCompany;
  /** Submission cost in EUR */
  costEUR: number;
  /** Shipping both ways, estimated */
  shippingEUR: number;
}

export interface ArbitrageOpportunity {
  card: Card;
  /** Price paid for raw NM card */
  rawPriceEUR: number;
  rawPriceSource: PriceSource;
  gradingCompany: GradingCompany;
  targetGrade: number;
  /** Probability of hitting target grade (0–1) */
  hitProbability: number;
  gradedSalePriceEUR: number;
  gradingCostEUR: number;
  /** Expected Value = (hitProbability × gradedSalePrice) − rawPrice − gradingCost */
  ev: number;
  /** ROI = ev / (rawPrice + gradingCost) × 100 */
  roi: number;
  /** Recommended action */
  signal: 'strong-buy' | 'buy' | 'neutral' | 'avoid';
  computedAt: number;
}

// ---------------------------------------------------------------------------
// API Response wrappers
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Currency exchange rates
// ---------------------------------------------------------------------------

export interface ExchangeRates {
  base: Currency;
  rates: Record<Currency, number>;
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Portfolio — Stock / Equity
// ---------------------------------------------------------------------------

export interface StockPriceSnapshot {
  ticker: string;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  marketCap?: number;
  /** Unix timestamp */
  fetchedAt: number;
}

export interface StockPricePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IncomeStatement {
  period: string;
  revenue: number;
  grossProfit: number;
  operatingIncome: number;
  netIncome: number;
  eps?: number;
  ebitda?: number;
}

export interface BalanceSheet {
  period: string;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  cash: number;
  debt: number;
}

export interface CashFlowStatement {
  period: string;
  operatingCashFlow: number;
  capitalExpenditures: number;
  freeCashFlow: number;
}

export interface CompanyFacts {
  ticker: string;
  name: string;
  description?: string;
  sector?: string;
  industry?: string;
  employees?: number;
  website?: string;
  ceo?: string;
  country?: string;
}

export interface FinancialSummary {
  ticker: string;
  incomeStatements: IncomeStatement[];
  balanceSheets: BalanceSheet[];
  cashFlows: CashFlowStatement[];
  fetchedAt: number;
}

export interface PriceScenario {
  label: 'bear' | 'base' | 'bull';
  price: number;
  /** Probability 0–1 */
  probability: number;
  rationale: string;
}

export interface PriceTargets {
  '1M': number;
  '3M': number;
  '6M': number;
  '12M': number;
}

export interface ResearchContext {
  ticker: string;
  companyName: string;
  thesis: string;
  /** Bull / base / bear scenarios */
  scenarios: PriceScenario[];
  priceTargets: PriceTargets;
  /** Conditions that would invalidate the thesis and trigger a sell */
  killConditions: string[];
  /** Key catalysts to monitor */
  catalysts: string[];
  /** Latest news / events summary */
  newsSummary: string;
  /** Overall conviction score 1-10 */
  conviction: number;
  /** buy / hold / reduce / sell */
  signal: 'buy' | 'hold' | 'reduce' | 'sell';
  computedAt: number;
}

export interface BuySellSignal {
  ticker: string;
  action: 'buy' | 'add' | 'hold' | 'reduce' | 'sell' | 'watch';
  urgency: 'high' | 'medium' | 'low';
  rationale: string;
  suggestedSizeChangePct?: number;
  computedAt: number;
}

export interface PortfolioHolding {
  ticker: string;
  companyName: string;
  shares: number;
  avgCostBasis: number;
  /** Target allocation as % of total portfolio (0-100) */
  targetWeightPct: number;
  /** Current allocation as % of total portfolio (0-100) */
  currentWeightPct?: number;
  currency: 'USD';
  addedAt: number;
  updatedAt: number;
  notes?: string;
  /** Tags: e.g. "AI", "energy", "speculative" */
  tags?: string[];
}

export interface WatchlistEntry {
  ticker: string;
  companyName: string;
  interest: string;
  addedAt: number;
}

export interface Portfolio {
  holdings: PortfolioHolding[];
  watchlist: WatchlistEntry[];
  updatedAt: number;
}

export interface ScanResult {
  /** Date of the scan (YYYY-MM-DD) */
  date: string;
  /** Summary for public consumption */
  summary: string;
  signals: BuySellSignal[];
  topConvictions: string[];
  riskFlags: string[];
  computedAt: number;
}
