import { logger } from '../logger';

/**
 * Retry `fn` up to `maxAttempts` times with exponential backoff.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 3,
    baseDelayMs = 500,
    onRetry,
  }: {
    maxAttempts?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, err: unknown) => void;
  } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.(attempt, err);
      logger.warn({ err, attempt, delay }, `Retrying after ${delay}ms (attempt ${attempt}/${maxAttempts})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
