import { Router } from "express";
import type { AppDeps } from "../../app.js";
import { authenticate } from "../middleware/security.js";
import {
  chapters,
  create,
  file,
  latest,
  poll,
  retry,
  reviewed,
} from "./prReviewer.api.js";

export type { PrReviewerDeps } from "./prReviewer.api.js";

export function prReviewerRouter(deps: AppDeps): Router {
  const router = Router();
  router.use(authenticate);
  router.get("/:org/:repo/pulls/:prNumber/runs/latest", latest(deps));
  router.post("/:org/:repo/pulls/:prNumber/runs", create(deps));
  router.get("/runs/:runId", poll(deps));
  router.post("/runs/:runId/retry", retry(deps));
  router.get("/runs/:runId/chapters", chapters(deps));
  router.get("/runs/:runId/files", file(deps));
  router.put(
    "/runs/:runId/chapters/:chapterKey/reviewed",
    reviewed(deps, true),
  );
  router.delete(
    "/runs/:runId/chapters/:chapterKey/reviewed",
    reviewed(deps, false),
  );
  return router;
}
