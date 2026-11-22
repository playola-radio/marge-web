import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { redirect } from './authorize.controller.js';

export function authorizeRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', redirect(deps));
  return router;
}
