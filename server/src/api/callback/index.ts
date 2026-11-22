import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { receive } from './callback.api.js';

export function callbackRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/', receive(deps));
  return router;
}
