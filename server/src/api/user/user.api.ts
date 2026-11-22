import type { RequestHandler } from "express";
import type { AuthedRequest } from "../middleware/security.js";

export const me: RequestHandler = (req, res) => {
  res.json({ user: (req as AuthedRequest).auth });
};
