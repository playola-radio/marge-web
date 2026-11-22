import { Router } from 'express';
import type { AppDeps } from '../../app.js';
import { devLogin, googleSignIn } from './auth.api.js';

export function authRouter(deps: AppDeps): Router {
  const router = Router();
  router.post('/google/signin', googleSignIn(deps));
  if (deps.config.devLogin) {
    router.post('/dev-login', devLogin);
  }
  return router;
}
