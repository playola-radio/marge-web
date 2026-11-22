import { createHash, timingSafeEqual } from "node:crypto";
import { type ErrorRequestHandler, type RequestHandler } from "express";
import type { AppDeps } from "../../app.js";
import {
  FACTORY_SNAPSHOT_KEY,
  FACTORY_SNAPSHOT_TTL_SECONDS,
  parseSync,
} from "../../lib/factorySync/index.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();

/**
 * The factory machine's push: POST /v1/factory/sync, authorised by
 * FACTORY_REPORT_TOKEN. Mounted ahead of the app's JSON parser, so the token
 * is checked before the body is read and a caller without it always gets 401.
 */
export function requireFactoryToken(deps: AppDeps): RequestHandler {
  return (req, res, next) => {
    const expected = deps.config.factoryReportToken;
    const header = req.headers.authorization;
    const match = header ? /^Bearer (\S+)$/.exec(header) : null;
    if (
      !expected ||
      !match ||
      !timingSafeEqual(sha256(match[1]), sha256(expected))
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function sync(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    const parsed = parseSync(req.body);
    if (!parsed) {
      res.status(400).json({ error: "invalid_sync" });
      return;
    }
    try {
      // History first, then the latest state; a failure partway answers 500
      // and the factory's resend finishes the job (already-stored ids are skipped).
      await deps.factoryHistory.record(parsed.artifacts, parsed.events);
      await deps.kv.put(
        FACTORY_SNAPSHOT_KEY,
        JSON.stringify({
          catalog: parsed.catalog,
          snapshot: parsed.snapshot,
          receivedAt: new Date().toISOString(),
        }),
        FACTORY_SNAPSHOT_TTL_SECONDS,
      );
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  };
}

export const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_sync" });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ error: "invalid_sync" });
    return;
  }
  next(err);
};

/** The /factory page's read: GET /v1/factory/snapshot for a signed-in marge user. */
export function snapshot(deps: AppDeps): RequestHandler {
  return async (_req, res, next) => {
    try {
      const row = await deps.kv.get(FACTORY_SNAPSHOT_KEY);
      const serverNow = new Date().toISOString();
      if (!row) {
        res.json({
          catalog: null,
          snapshot: null,
          receivedAt: null,
          serverNow,
        });
        return;
      }
      res.json({ ...JSON.parse(row), serverNow });
    } catch (err) {
      next(err);
    }
  };
}
