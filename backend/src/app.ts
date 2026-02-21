import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';

import { logger } from './logger';
import { errorHandler } from './middleware/errorHandler';
import { cardsRouter } from './routes/cards.routes';
import { setsRouter } from './routes/sets.routes';
import { arbitrageRouter } from './routes/arbitrage.routes';
import { startSyncJobs } from './jobs/sync.jobs';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Security / middleware
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

app.use(
  rateLimit({
    windowMs: 60_000,
    max: parseInt(process.env.RATE_LIMIT_RPM || '120', 10),
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/cards', cardsRouter);
app.use('/sets', setsRouter);
app.use('/arbitrage-opportunities', arbitrageRouter);

// ---------------------------------------------------------------------------
// Error handler (must be last)
// ---------------------------------------------------------------------------
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
  if (process.env.DISABLE_CRON !== 'true') {
    startSyncJobs();
  }
});

export default app;
