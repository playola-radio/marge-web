import { Router } from "express";
import { healthCheck, healthz } from "./healthCheck.api.js";

export const healthzRouter = Router();
healthzRouter.get("/", healthz);

export const healthCheckRouter = Router();
healthCheckRouter.get("/", healthCheck);
