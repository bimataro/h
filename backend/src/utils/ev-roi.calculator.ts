/**
 * EV / ROI Calculator for grading arbitrage
 *
 * Logic originally from App.tsx lines 62–95 — improved and generalised.
 *
 * Expected Value (EV):
 *   EV = Σ (P(grade_i) × salePrice(grade_i)) − rawPrice − totalCosts
 *
 * ROI:
 *   ROI = EV / (rawPrice + totalCosts) × 100
 *
 * Signal thresholds (configurable via env):
 *   strong-buy : ROI ≥ 50%
 *   buy        : ROI ≥ 20%
 *   neutral    : ROI ≥ 0%
 *   avoid      : ROI <  0%
 */

import {
  ArbitrageOpportunity,
  Card,
  GradedPrice,
  GradingCompany,
  PriceSource,
} from '../../../shared/types';

// ---------------------------------------------------------------------------
// Grading cost table (EUR) — estimates, updated periodically
// Includes submission fee + return shipping.
// ---------------------------------------------------------------------------
const GRADING_COSTS_EUR: Record<GradingCompany, { base: number; shipping: number }> = {
  PSA: { base: 25, shipping: 30 },   // PSA Regular service
  BGS: { base: 22, shipping: 28 },
  CGC: { base: 18, shipping: 25 },
  SGC: { base: 15, shipping: 25 },
  ACE: { base: 12, shipping: 20 },
};

// ---------------------------------------------------------------------------
// Grade distribution for NM raw cards (empirical probabilities)
// Source: community data / PokeTrace population statistics
// P(PSA 10) for modern NM holo ≈ 35–55%; P(PSA 9) ≈ 35–45%
// ---------------------------------------------------------------------------
const DEFAULT_GRADE_DISTRIBUTION_PSA: Array<{ grade: number; prob: number }> = [
  { grade: 10, prob: 0.40 },
  { grade: 9, prob: 0.40 },
  { grade: 8, prob: 0.12 },
  { grade: 7, prob: 0.05 },
  { grade: 6, prob: 0.02 },
  { grade: 5, prob: 0.01 },
];

const DEFAULT_GRADE_DISTRIBUTION_BGS: Array<{ grade: number; prob: number }> = [
  { grade: 10, prob: 0.05 },   // BGS 10 (pristine) is much rarer
  { grade: 9.5, prob: 0.30 },
  { grade: 9, prob: 0.40 },
  { grade: 8.5, prob: 0.15 },
  { grade: 8, prob: 0.07 },
  { grade: 7, prob: 0.03 },
];

const DEFAULT_GRADE_DISTRIBUTION_CGC: Array<{ grade: number; prob: number }> = [
  { grade: 10, prob: 0.30 },
  { grade: 9.5, prob: 0.15 },
  { grade: 9, prob: 0.38 },
  { grade: 8.5, prob: 0.10 },
  { grade: 8, prob: 0.05 },
  { grade: 7, prob: 0.02 },
];

const GRADE_DISTRIBUTIONS: Record<GradingCompany, Array<{ grade: number; prob: number }>> = {
  PSA: DEFAULT_GRADE_DISTRIBUTION_PSA,
  BGS: DEFAULT_GRADE_DISTRIBUTION_BGS,
  CGC: DEFAULT_GRADE_DISTRIBUTION_CGC,
  SGC: DEFAULT_GRADE_DISTRIBUTION_PSA,  // SGC similar to PSA for estimates
  ACE: DEFAULT_GRADE_DISTRIBUTION_PSA,
};

// ---------------------------------------------------------------------------
// Thresholds (overridable via env)
// ---------------------------------------------------------------------------
const THRESHOLD_STRONG_BUY = parseFloat(process.env.ROI_THRESHOLD_STRONG_BUY ?? '50');
const THRESHOLD_BUY = parseFloat(process.env.ROI_THRESHOLD_BUY ?? '20');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EVInput {
  card: Card;
  rawPriceEUR: number;
  rawPriceSource: PriceSource;
  gradingCompany: GradingCompany;
  /** All available graded prices for this card + company */
  gradedPrices: GradedPrice[];
  /** Custom grade probability distribution (optional — uses defaults if omitted) */
  gradeDist?: Array<{ grade: number; prob: number }>;
}

export interface EVResult {
  ev: number;
  roi: number;
  totalCostEUR: number;
  bestGrade: number;
  bestGradePrice: number;
  bestGradeProbability: number;
  gradeBreakdown: Array<{
    grade: number;
    prob: number;
    priceEUR: number;
    contribution: number;
  }>;
}

/**
 * Calculate EV and ROI for grading a single NM raw card.
 */
export function calculateEV(input: EVInput): EVResult {
  const { rawPriceEUR, gradingCompany, gradedPrices, gradeDist } = input;

  const costs = GRADING_COSTS_EUR[gradingCompany];
  const totalCostEUR = rawPriceEUR + costs.base + costs.shipping;

  // Build price lookup: grade → EUR price
  const gradeToPrice = new Map<number, number>();
  for (const gp of gradedPrices) {
    if (gp.company === gradingCompany && gp.marketPriceEUR > 0) {
      // Keep the higher price if duplicates exist
      const existing = gradeToPrice.get(gp.grade) ?? 0;
      if (gp.marketPriceEUR > existing) {
        gradeToPrice.set(gp.grade, gp.marketPriceEUR);
      }
    }
  }

  const distribution = gradeDist ?? GRADE_DISTRIBUTIONS[gradingCompany];
  const gradeBreakdown: EVResult['gradeBreakdown'] = [];
  let expectedRevenue = 0;

  for (const { grade, prob } of distribution) {
    // Find closest available graded price at or below this grade
    const priceEUR = gradeToPrice.get(grade) ?? findClosestLowerGradePrice(gradeToPrice, grade);
    const contribution = prob * priceEUR;
    expectedRevenue += contribution;
    gradeBreakdown.push({ grade, prob, priceEUR, contribution });
  }

  const ev = expectedRevenue - totalCostEUR;
  const roi = totalCostEUR > 0 ? (ev / totalCostEUR) * 100 : 0;

  // Find the best grade (highest EV contribution)
  const best = gradeBreakdown.reduce((a, b) => (a.contribution > b.contribution ? a : b));

  return {
    ev: Math.round(ev * 100) / 100,
    roi: Math.round(roi * 10) / 10,
    totalCostEUR: Math.round(totalCostEUR * 100) / 100,
    bestGrade: best.grade,
    bestGradePrice: best.priceEUR,
    bestGradeProbability: best.prob,
    gradeBreakdown,
  };
}

/**
 * Build a full ArbitrageOpportunity from an EV result.
 */
export function buildOpportunity(
  input: EVInput,
  result: EVResult,
): ArbitrageOpportunity {
  const { ev, roi, bestGrade, bestGradePrice, bestGradeProbability, totalCostEUR } = result;
  const gradingCost = totalCostEUR - input.rawPriceEUR;

  const signal =
    roi >= THRESHOLD_STRONG_BUY
      ? 'strong-buy'
      : roi >= THRESHOLD_BUY
      ? 'buy'
      : roi >= 0
      ? 'neutral'
      : 'avoid';

  return {
    card: input.card,
    rawPriceEUR: input.rawPriceEUR,
    rawPriceSource: input.rawPriceSource,
    gradingCompany: input.gradingCompany,
    targetGrade: bestGrade,
    hitProbability: bestGradeProbability,
    gradedSalePriceEUR: bestGradePrice,
    gradingCostEUR: gradingCost,
    ev,
    roi,
    signal,
    computedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findClosestLowerGradePrice(prices: Map<number, number>, grade: number): number {
  let closest = 0;
  let closestGrade = -Infinity;
  for (const [g, p] of prices.entries()) {
    if (g <= grade && g > closestGrade) {
      closestGrade = g;
      closest = p;
    }
  }
  return closest;
}

/** Return the default grading cost breakdown for a company (EUR). */
export function getGradingCost(company: GradingCompany): { base: number; shipping: number; total: number } {
  const c = GRADING_COSTS_EUR[company];
  return { base: c.base, shipping: c.shipping, total: c.base + c.shipping };
}
