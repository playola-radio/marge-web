import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { authenticate } from '../middleware/security.js';
import {
  bodyErrors,
  parseSyncBody,
  requireFactoryToken,
  snapshot,
  sync,
} from './factory.controller.js';

export function factorySyncRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/', requireFactoryToken(deps), parseSyncBody, sync(deps));
  router.use(bodyErrors);
  return router;
}

export function factoryRouter(deps: AppDeps): Router {
  const router = Router();
  router.get('/snapshot', authenticate, snapshot(deps));
  return router;
}
