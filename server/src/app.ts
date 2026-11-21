import express, { type Express } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import type { KV } from './lib/kv.js';
import type { Config } from './config.js';
import type { ExchangeGoogleCode } from './lib/googleSignIn.js';
import { healthRouter } from './api/health.js';
import { sessionRouter } from './api/session.js';
import { authorizeRouter } from './api/authorize.js';
import { connectRouter } from './api/connect.js';
import { callbackRouter } from './api/callback.js';
import { resultRouter } from './api/result.js';
import { v1Router } from './v1/index.js';
import { errorHandler } from './middleware/error.js';

export interface AppDeps {
  kv: KV;
  config: Config;
  rateLimit?: { windowMs: number; max: number };
  exchangeGoogleCode?: ExchangeGoogleCode;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  app.use(helmet());
  app.use(express.json());

  const { windowMs, max } = deps.rateLimit ?? { windowMs: 60_000, max: 30 };
  const limiter = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
  // Separate instance so sign-in and the relay never share a per-IP count.
  const signInLimiter = rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

  app.use(healthRouter);
  app.use('/session', limiter);
  app.use('/connect', limiter);
  app.use('/result', limiter);
  app.use(sessionRouter(deps));
  app.use(connectRouter(deps));
  app.use(authorizeRouter(deps));
  app.use(callbackRouter(deps));
  app.use(resultRouter(deps));
  // CORS before the limiter: preflights end here, and a 429 still carries the header.
  app.use('/v1', cors({ origin: deps.config.clientOrigins }));
  app.use('/v1/auth', signInLimiter);
  app.use('/v1', v1Router(deps));
  app.use(errorHandler);
  return app;
}
