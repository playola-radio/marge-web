import { Router } from "express";
import { authenticate } from "../middleware/security.js";
import { me } from "./user.controller.js";

export const userRouter = Router();
userRouter.get("/", authenticate, me);
