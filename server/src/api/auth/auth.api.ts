import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { AppDeps } from "../../app.js";
import {
  exchangeGoogleCode as realExchangeGoogleCode,
  GoogleSignInRejected,
} from "../../lib/googleSignIn/index.js";

const TOKEN_LIFETIME = "30d";

function signMargeToken(
  user: { email: string; name: string },
  secret: string,
): string {
  return jwt.sign(user, secret, {
    algorithm: "HS256",
    expiresIn: TOKEN_LIFETIME,
  });
}

export function googleSignIn(deps: AppDeps): RequestHandler {
  const exchangeGoogleCode = deps.exchangeGoogleCode ?? realExchangeGoogleCode;

  return async (req, res, next) => {
    const code = (req.body as Record<string, unknown> | undefined)?.code;
    if (typeof code !== "string" || code.length === 0) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const client = deps.config.googleSignIn;
    const secret = process.env.JWT_SECRET;
    if (!client || !secret) {
      next(new Error("google sign-in is not configured"));
      return;
    }
    try {
      const identity = await exchangeGoogleCode(code, client);
      if (!identity.emailVerified) {
        res.status(401).json({ error: "sign_in_failed" });
        return;
      }
      const email = identity.email.toLowerCase();
      if (!deps.config.allowedEmails.includes(email)) {
        res.status(403).json({ error: "not_approved" });
        return;
      }
      res.json({
        margeToken: signMargeToken({ email, name: identity.name }, secret),
      });
    } catch (err) {
      if (err instanceof GoogleSignInRejected) {
        res.status(401).json({ error: "sign_in_failed" });
        return;
      }
      next(err);
    }
  };
}

const DEV_USER = { email: "dev@marge.local", name: "Dev User" };
const SECOND_DEV_USER = { email: "dev2@marge.local", name: "Second Dev User" };

export const devLogin: RequestHandler = (req, res, next) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    next(new Error("JWT_SECRET is not set"));
    return;
  }
  const user = req.query.as === "second" ? SECOND_DEV_USER : DEV_USER;
  res.json({ margeToken: signMargeToken(user, secret) });
};
