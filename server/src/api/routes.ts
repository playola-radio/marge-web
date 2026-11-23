import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import type { AppDeps } from "../app.js";
import { healthCheckRouter, healthzRouter } from "./healthCheck/index.js";
import { sessionRouter } from "./session/index.js";
import { authorizeRouter } from "./authorize/index.js";
import { connectAdvanceRouter, connectRouter } from "./connect/index.js";
import { callbackRouter } from "./callback/index.js";
import { resultRouter } from "./result/index.js";
import { authRouter } from "./auth/index.js";
import { factoryRouter, factorySyncRouter } from "./factory/index.js";
import { userRouter } from "./user/index.js";
import { prReviewerRouter } from "./prReviewer/index.js";

export function addRoutes(app: Express, deps: AppDeps): void {
  // The factory push checks its token before any body parsing, so it parses its own body.
  app.use("/v1/factory/sync", factorySyncRouter(deps));
  app.use(express.json());

  const { windowMs, max } = deps.rateLimit ?? { windowMs: 60_000, max: 30 };
  const limiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  });
  // Separate instance so sign-in and the relay never share a per-IP count.
  const signInLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use("/healthz", healthzRouter);
  app.use("/session", limiter);
  app.use("/connect", limiter);
  app.use("/result", limiter);
  app.use("/session", sessionRouter(deps));
  app.use("/connect", connectRouter(deps));
  app.use("/connect-advance.js", connectAdvanceRouter);
  app.use("/authorize", authorizeRouter(deps));
  app.use("/callback", callbackRouter(deps));
  app.use("/result", resultRouter(deps));
  // CORS before the limiter: preflights end here, and a 429 still carries the header.
  app.use("/v1", cors({ origin: deps.config.clientOrigins }));
  app.use("/v1/auth", signInLimiter);
  app.use("/v1/healthCheck", healthCheckRouter);
  app.use("/v1/auth", authRouter(deps));
  app.use("/v1/factory", factoryRouter(deps));
  app.use("/v1/pr-reviewer", prReviewerRouter(deps));
  app.use("/v1/me", userRouter);
}
