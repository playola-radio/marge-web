import type { RequestHandler } from 'express';

export const healthz: RequestHandler = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

export const healthCheck: RequestHandler = (_req, res) => {
  res.json({ status: 'ok' });
};
