import express, { type Express } from "express";
import helmet from "helmet";
import type { KV } from "./lib/kv/index.js";
import type { Config } from "./lib/config/index.js";
import type { FactoryHistory } from "./lib/factoryHistory/index.js";
import type { ExchangeGoogleCode } from "./lib/googleSignIn/index.js";
import { addRoutes } from "./api/routes.js";
import type { PrReviewerDeps } from "./api/prReviewer/index.js";
import { errorHandler } from "./api/apiError.js";

export interface AppDeps {
  kv: KV;
  config: Config;
  factoryHistory: FactoryHistory;
  rateLimit?: { windowMs: number; max: number };
  exchangeGoogleCode?: ExchangeGoogleCode;
  /** The PR reviewer, when configured; without it every /v1/pr-reviewer route answers 503. */
  prReviewer?: PrReviewerDeps | null;
}

export function buildApp(deps: AppDeps): Express {
  const app = express();
  // Render's proxy appends the real client address to X-Forwarded-For; trust only that one hop.
  app.set("trust proxy", 1);
  app.use(helmet());
  addRoutes(app, deps);
  app.use(errorHandler);
  return app;
}
