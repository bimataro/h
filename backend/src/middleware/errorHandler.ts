import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { ApiError } from '../../../shared/types';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const body: ApiError = { code: err.code, message: err.message, details: err.details };
    res.status(err.statusCode).json({ error: body });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  const body: ApiError = { code: 'INTERNAL_ERROR', message: 'Internal server error' };
  res.status(500).json({ error: body });
}
