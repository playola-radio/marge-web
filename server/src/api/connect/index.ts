import { Router } from "express";
import type { AppDeps } from "../../app.js";
import { advance, show } from "./connect.api.js";

export function connectRouter(deps: AppDeps): Router {
  const router = Router();
  router.get("/", show(deps));
  return router;
}

export const connectAdvanceRouter = Router();
connectAdvanceRouter.get("/", advance);
