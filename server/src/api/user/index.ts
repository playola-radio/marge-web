import { Router } from "express";
import { authenticate } from "../middleware/security.js";
import { me } from "./user.api.js";

export const userRouter = Router();
userRouter.get("/", authenticate, me);
