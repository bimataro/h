import axios from 'axios';
import { Currency, ExchangeRates } from '../../../shared/types';
import { cache, TTL } from '../cache/cache.service';
import { logger } from '../logger';
import { withRetry } from '../utils/retry';

const CACHE_KEY = 'currency:rates';

// Fallback static rates (EUR base) — updated at build time
const FALLBACK_RATES: ExchangeRates = {
  base: 'EUR',
  rates: {
    EUR: 1,
    USD: 1.08,
    JPY: 163,
    GBP: 0.855,
  },
  fetchedAt: 0,
};

class CurrencyService {
  /**
   * Fetch latest exchange rates from exchangerate-api (free tier).
   * Falls back to cached / static rates on failure.
   */
  async getRates(): Promise<ExchangeRates> {
    const cached = cache.get<ExchangeRates>(CACHE_KEY);
    if (cached) return cached;

    try {
      const apiKey = process.env.EXCHANGE_RATE_API_KEY;
      let rates: ExchangeRates;

      if (apiKey) {
        // exchangerate-api.com free tier
        const { data } = await withRetry(() =>
          axios.get<{ conversion_rates: Record<string, number> }>(
            `https://v6.exchangerate-api.com/v6/${apiKey}/latest/EUR`,
            { timeout: 5_000 },
          ),
        );
        rates = {
          base: 'EUR',
          rates: {
            EUR: 1,
            USD: data.conversion_rates['USD'] ?? FALLBACK_RATES.rates.USD,
            JPY: data.conversion_rates['JPY'] ?? FALLBACK_RATES.rates.JPY,
            GBP: data.conversion_rates['GBP'] ?? FALLBACK_RATES.rates.GBP,
          },
          fetchedAt: Date.now(),
        };
      } else {
        // No API key — use open.er-api.com (free, no key)
        const { data } = await withRetry(() =>
          axios.get<{ rates: Record<string, number> }>(
            'https://open.er-api.com/v6/latest/EUR',
            { timeout: 5_000 },
          ),
        );
        rates = {
          base: 'EUR',
          rates: {
            EUR: 1,
            USD: data.rates['USD'] ?? FALLBACK_RATES.rates.USD,
            JPY: data.rates['JPY'] ?? FALLBACK_RATES.rates.JPY,
            GBP: data.rates['GBP'] ?? FALLBACK_RATES.rates.GBP,
          },
          fetchedAt: Date.now(),
        };
      }

      cache.set(CACHE_KEY, rates, TTL.EXCHANGE_RATES);
      logger.info('Exchange rates refreshed');
      return rates;
    } catch (err) {
      logger.warn('Failed to fetch exchange rates — using fallback', { err });
      return FALLBACK_RATES;
    }
  }

  /** Convert amount from one currency to another. */
  async convert(amount: number, from: Currency, to: Currency): Promise<number> {
    if (from === to) return amount;
    const { rates } = await this.getRates();
    // All rates are EUR-based
    const amountInEUR = from === 'EUR' ? amount : amount / rates[from];
    return to === 'EUR' ? amountInEUR : amountInEUR * rates[to];
  }

  /** Convert any amount to both EUR and USD in one call. */
  async toEurAndUsd(amount: number, from: Currency): Promise<{ EUR: number; USD: number }> {
    const { rates } = await this.getRates();
    const amountInEUR = from === 'EUR' ? amount : amount / rates[from];
    return {
      EUR: Math.round(amountInEUR * 100) / 100,
      USD: Math.round(amountInEUR * rates['USD'] * 100) / 100,
    };
  }

  /** Invalidate cached rates so they are fetched fresh on next call. */
  invalidate(): void {
    cache.delete(CACHE_KEY);
  }
}

export const currencyService = new CurrencyService();
