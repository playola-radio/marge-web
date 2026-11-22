import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { create } from './session.api.js';

export function sessionRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', create(deps));
  return router;
}
