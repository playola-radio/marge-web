import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { claim } from './result.controller.js';

export function resultRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', claim(deps));
  return router;
}
