import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { claim } from './result.api.js';

export function resultRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', claim(deps));
  return router;
}
