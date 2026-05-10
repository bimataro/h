/**
 * Financial Datasets Service
 *
 * Wraps the financialdatasets.ai REST API.
 * All calls use withRetry() and cache.getOrSet() per project conventions.
 */

import axios from 'axios';
import { cache, TTL } from '../cache/cache.service';
import { withRetry } from '../utils/retry';
import { logger } from '../logger';
import type {
  StockPriceSnapshot,
  StockPricePoint,
  IncomeStatement,
  BalanceSheet,
  CashFlowStatement,
  CompanyFacts,
  FinancialSummary,
} from '../../../shared/types';

const BASE_URL = process.env.FINANCIAL_DATASETS_BASE_URL ?? 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY ?? '';

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: API_KEY ? { 'X-API-KEY': API_KEY } : {},
});

// ---------------------------------------------------------------------------
// Price snapshot
// ---------------------------------------------------------------------------

export async function getPriceSnapshot(ticker: string): Promise<StockPriceSnapshot | null> {
  const key = `fd:snapshot:${ticker}`;
  return cache.getOrSet(
    key,
    async () => {
      try {
        const { data } = await withRetry(
          () => http.get(`/prices/snapshot`, { params: { ticker } }),
          { maxAttempts: 3, baseDelayMs: 500 },
        );
        const s = data?.snapshot ?? data;
        return {
          ticker,
          price: s.price ?? s.close,
          open: s.open,
          high: s.high,
          low: s.low,
          volume: s.volume,
          marketCap: s.market_cap ?? s.marketCap,
          fetchedAt: Date.now(),
        } satisfies StockPriceSnapshot;
      } catch (err) {
        logger.warn({ err, ticker }, 'getPriceSnapshot failed');
        return null;
      }
    },
    TTL.STOCK_PRICES,
  );
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

export async function getPriceHistory(ticker: string, days = 90): Promise<StockPricePoint[]> {
  const key = `fd:history:${ticker}:${days}`;
  return cache.getOrSet(
    key,
    async () => {
      try {
        const end = new Date().toISOString().slice(0, 10);
        const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        const { data } = await withRetry(
          () => http.get(`/prices`, { params: { ticker, start_date: start, end_date: end } }),
          { maxAttempts: 3, baseDelayMs: 500 },
        );
        const prices: Array<Record<string, number | string>> = data?.prices ?? data ?? [];
        return prices.map((p) => ({
          date: String(p.date ?? p.time),
          open: Number(p.open),
          high: Number(p.high),
          low: Number(p.low),
          close: Number(p.close),
          volume: Number(p.volume),
        }));
      } catch (err) {
        logger.warn({ err, ticker }, 'getPriceHistory failed');
        return [];
      }
    },
    TTL.STOCK_PRICES,
  );
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

export async function getFinancials(ticker: string): Promise<FinancialSummary> {
  const key = `fd:financials:${ticker}`;
  return cache.getOrSet(
    key,
    async () => {
      const [incomeRes, balanceRes, cashRes] = await Promise.allSettled([
        withRetry(
          () => http.get(`/financials/income-statements`, { params: { ticker, limit: 8 } }),
          { maxAttempts: 3, baseDelayMs: 500 },
        ),
        withRetry(
          () => http.get(`/financials/balance-sheets`, { params: { ticker, limit: 8 } }),
          { maxAttempts: 3, baseDelayMs: 500 },
        ),
        withRetry(
          () => http.get(`/financials/cash-flow-statements`, { params: { ticker, limit: 8 } }),
          { maxAttempts: 3, baseDelayMs: 500 },
        ),
      ]);

      const rawIncome: Array<Record<string, unknown>> =
        incomeRes.status === 'fulfilled' ? (incomeRes.value.data?.income_statements ?? incomeRes.value.data ?? []) : [];
      const rawBalance: Array<Record<string, unknown>> =
        balanceRes.status === 'fulfilled' ? (balanceRes.value.data?.balance_sheets ?? balanceRes.value.data ?? []) : [];
      const rawCash: Array<Record<string, unknown>> =
        cashRes.status === 'fulfilled' ? (cashRes.value.data?.cash_flow_statements ?? cashRes.value.data ?? []) : [];

      const incomeStatements: IncomeStatement[] = rawIncome.map((r) => ({
        period: String(r.period ?? r.date ?? r.fiscal_date ?? ''),
        revenue: Number(r.revenue ?? r.total_revenue ?? 0),
        grossProfit: Number(r.gross_profit ?? 0),
        operatingIncome: Number(r.operating_income ?? 0),
        netIncome: Number(r.net_income ?? 0),
        eps: r.eps != null ? Number(r.eps) : undefined,
        ebitda: r.ebitda != null ? Number(r.ebitda) : undefined,
      }));

      const balanceSheets: BalanceSheet[] = rawBalance.map((r) => ({
        period: String(r.period ?? r.date ?? r.fiscal_date ?? ''),
        totalAssets: Number(r.total_assets ?? 0),
        totalLiabilities: Number(r.total_liabilities ?? 0),
        totalEquity: Number(r.total_equity ?? r.shareholders_equity ?? 0),
        cash: Number(r.cash_and_equivalents ?? r.cash ?? 0),
        debt: Number(r.total_debt ?? r.long_term_debt ?? 0),
      }));

      const cashFlows: CashFlowStatement[] = rawCash.map((r) => ({
        period: String(r.period ?? r.date ?? r.fiscal_date ?? ''),
        operatingCashFlow: Number(r.operating_cash_flow ?? r.net_cash_from_operating ?? 0),
        capitalExpenditures: Number(r.capital_expenditures ?? r.capex ?? 0),
        freeCashFlow: Number(r.free_cash_flow ?? 0),
      }));

      return { ticker, incomeStatements, balanceSheets, cashFlows, fetchedAt: Date.now() };
    },
    TTL.FINANCIALS,
  );
}

// ---------------------------------------------------------------------------
// Company facts
// ---------------------------------------------------------------------------

export async function getCompanyFacts(ticker: string): Promise<CompanyFacts | null> {
  const key = `fd:facts:${ticker}`;
  return cache.getOrSet(
    key,
    async () => {
      try {
        const { data } = await withRetry(
          () => http.get(`/company/facts`, { params: { ticker } }),
          { maxAttempts: 3, baseDelayMs: 500 },
        );
        const f = data?.company_facts ?? data?.facts ?? data;
        return {
          ticker,
          name: String(f?.name ?? f?.company_name ?? ticker),
          description: f?.description ?? f?.long_description,
          sector: f?.sector,
          industry: f?.industry,
          employees: f?.employees != null ? Number(f.employees) : undefined,
          website: f?.website,
          ceo: f?.ceo,
          country: f?.country,
        } satisfies CompanyFacts;
      } catch (err) {
        logger.warn({ err, ticker }, 'getCompanyFacts failed');
        return null;
      }
    },
    TTL.FINANCIALS,
  );
}

export const financialDatasetsService = {
  getPriceSnapshot,
  getPriceHistory,
  getFinancials,
  getCompanyFacts,
};
