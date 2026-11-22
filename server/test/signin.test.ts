import { expect } from 'chai';
import request from 'supertest';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { MemoryFactoryHistory } from '../src/lib/factoryHistory.js';
import { loadConfig } from '../src/config.js';
import { MemoryKV } from '../src/lib/kv.js';
import {
  GoogleSignInRejected,
  type ExchangeGoogleCode,
  type GoogleIdentity,
} from '../src/lib/googleSignIn.js';

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const ALLOWED_ORIGIN = 'https://marge.playola.fm';

describe('POST /v1/auth/google/signin', () => {
  const prevSecret = process.env.JWT_SECRET;
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
  });
  after(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  const identity: GoogleIdentity = {
    email: 'brian@playola.fm',
    emailVerified: true,
    name: 'Brian Keane',
  };

  const makeApp = (
    opts: {
      exchange?: ExchangeGoogleCode;
      env?: Record<string, string>;
      rateLimit?: { windowMs: number; max: number };
    } = {},
  ) =>
    buildApp({
      kv: new MemoryKV(),
      factoryHistory: new MemoryFactoryHistory(),
      config: loadConfig({
        BASE_URL: 'http://localhost',
        KV_BACKEND: 'memory',
        GOOGLE_SIGNIN_CLIENT_ID: 'client-id',
        GOOGLE_SIGNIN_CLIENT_SECRET: 'client-secret',
        MARGE_ALLOWED_EMAILS: 'brian@playola.fm',
        CLIENT_ORIGINS: `${ALLOWED_ORIGIN},http://localhost:5173`,
        ...opts.env,
      } as NodeJS.ProcessEnv),
      exchangeGoogleCode: opts.exchange ?? (async () => identity),
      rateLimit: opts.rateLimit,
    });

  const signIn = (app: ReturnType<typeof makeApp>, body: object = { code: 'the-code' }) =>
    request(app).post('/v1/auth/google/signin').send(body);

  it('returns a 30-day marge token for an allowlisted, verified email', async () => {
    const res = await signIn(makeApp());
    expect(res.status).to.equal(200);
    const payload = jwt.verify(res.body.margeToken, 'test-secret', {
      algorithms: ['HS256'],
    }) as JwtPayload;
    expect(payload.email).to.equal('brian@playola.fm');
    expect(payload.name).to.equal('Brian Keane');
    expect(payload.exp! - payload.iat!).to.equal(THIRTY_DAYS);
  });

  it('matches the allowlist ignoring case', async () => {
    const res = await signIn(
      makeApp({ exchange: async () => ({ ...identity, email: 'Brian@Playola.FM' }) }),
    );
    expect(res.status).to.equal(200);
    expect(res.body.margeToken).to.be.a('string');
  });

  it('returns a token that GET /v1/me accepts', async () => {
    const app = makeApp();
    const { body } = await signIn(app);
    const res = await request(app).get('/v1/me').set('Authorization', `Bearer ${body.margeToken}`);
    expect(res.status).to.equal(200);
    expect(res.body.user.email).to.equal('brian@playola.fm');
  });

  it('passes the code and the Google client settings to the exchange', async () => {
    let seen: unknown[] = [];
    await signIn(
      makeApp({
        exchange: async (...args) => {
          seen = args;
          return identity;
        },
      }),
    );
    expect(seen).to.deep.equal([
      'the-code',
      { clientId: 'client-id', clientSecret: 'client-secret' },
    ]);
  });

  it('returns 400 invalid_request when code is missing', async () => {
    const res = await signIn(makeApp(), {});
    expect(res.status).to.equal(400);
    expect(res.body).to.deep.equal({ error: 'invalid_request' });
  });

  it('returns 400 invalid_request when code is not a string', async () => {
    const res = await signIn(makeApp(), { code: 123 });
    expect(res.status).to.equal(400);
    expect(res.body).to.deep.equal({ error: 'invalid_request' });
  });

  it('returns 401 sign_in_failed when Google rejects the code', async () => {
    const res = await signIn(
      makeApp({
        exchange: async () => {
          throw new GoogleSignInRejected('rejected');
        },
      }),
    );
    expect(res.status).to.equal(401);
    expect(res.body).to.deep.equal({ error: 'sign_in_failed' });
  });

  it('returns 401 sign_in_failed when the email is not verified', async () => {
    const res = await signIn(
      makeApp({ exchange: async () => ({ ...identity, emailVerified: false }) }),
    );
    expect(res.status).to.equal(401);
    expect(res.body).to.deep.equal({ error: 'sign_in_failed' });
  });

  it('returns 403 not_approved for a verified email not on the list', async () => {
    const res = await signIn(
      makeApp({ exchange: async () => ({ ...identity, email: 'stranger@example.com' }) }),
    );
    expect(res.status).to.equal(403);
    expect(res.body).to.deep.equal({ error: 'not_approved' });
  });

  it('returns 403 not_approved when MARGE_ALLOWED_EMAILS is empty', async () => {
    const res = await signIn(makeApp({ env: { MARGE_ALLOWED_EMAILS: '' } }));
    expect(res.status).to.equal(403);
    expect(res.body).to.deep.equal({ error: 'not_approved' });
  });

  it('returns 500 internal_error when the Google sign-in settings are missing', async () => {
    const res = await signIn(makeApp({ env: { GOOGLE_SIGNIN_CLIENT_SECRET: '' } }));
    expect(res.status).to.equal(500);
    expect(res.body).to.deep.equal({ error: 'internal_error' });
  });

  it('returns 500 internal_error when JWT_SECRET is unset', async () => {
    delete process.env.JWT_SECRET;
    const res = await signIn(makeApp());
    expect(res.status).to.equal(500);
    expect(res.body).to.deep.equal({ error: 'internal_error' });
  });

  it('returns 500 internal_error when the exchange fails unexpectedly', async () => {
    const res = await signIn(
      makeApp({
        exchange: async () => {
          throw new Error('google down');
        },
      }),
    );
    expect(res.status).to.equal(500);
    expect(res.body).to.deep.equal({ error: 'internal_error' });
  });

  describe('CORS', () => {
    const preflight = (app: ReturnType<typeof makeApp>, origin: string) =>
      request(app)
        .options('/v1/auth/google/signin')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

    it('answers a preflight from a listed origin with that origin', async () => {
      const res = await preflight(makeApp(), ALLOWED_ORIGIN);
      expect(res.headers['access-control-allow-origin']).to.equal(ALLOWED_ORIGIN);
    });

    it('sends no Access-Control-Allow-Origin to an unlisted origin', async () => {
      const res = await preflight(makeApp(), 'https://evil.example.com');
      expect(res.headers).not.to.have.property('access-control-allow-origin');
    });

    it('sends no CORS header on relay routes', async () => {
      const res = await request(makeApp()).get('/healthz').set('Origin', ALLOWED_ORIGIN);
      expect(res.status).to.equal(200);
      expect(res.headers).not.to.have.property('access-control-allow-origin');
    });
  });

  describe('rate limiting', () => {
    const rateLimit = { windowMs: 60_000, max: 1 };

    it('429s the second sign-in with the CORS header, not counting preflights', async () => {
      const app = makeApp({ rateLimit });
      const preflight = await request(app)
        .options('/v1/auth/google/signin')
        .set('Origin', ALLOWED_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.status).to.equal(204);

      const first = await signIn(app).set('Origin', ALLOWED_ORIGIN);
      expect(first.status).to.equal(200);

      const second = await signIn(app).set('Origin', ALLOWED_ORIGIN);
      expect(second.status).to.equal(429);
      expect(second.headers['access-control-allow-origin']).to.equal(ALLOWED_ORIGIN);
    });

    it('does not share a count with POST /session', async () => {
      const app = makeApp({ rateLimit });
      expect((await signIn(app)).status).to.equal(200);
      expect((await signIn(app)).status).to.equal(429);
      expect((await request(app).post('/session').send({})).status).not.to.equal(429);
    });

    it("counts each client behind Render's proxy separately", async () => {
      const app = makeApp({ rateLimit });
      expect((await signIn(app).set('X-Forwarded-For', '203.0.113.1')).status).to.equal(200);
      expect((await signIn(app).set('X-Forwarded-For', '203.0.113.1')).status).to.equal(429);
      expect((await signIn(app).set('X-Forwarded-For', '203.0.113.2')).status).to.equal(200);
    });

    it('ignores client-supplied addresses before the one the proxy adds', async () => {
      const app = makeApp({ rateLimit });
      expect(
        (await signIn(app).set('X-Forwarded-For', '198.51.100.9, 203.0.113.1')).status,
      ).to.equal(200);
      expect(
        (await signIn(app).set('X-Forwarded-For', '198.51.100.7, 203.0.113.1')).status,
      ).to.equal(429);
    });

    it('does not let POST /session use up the sign-in count', async () => {
      const app = makeApp({ rateLimit });
      expect((await request(app).post('/session').send({})).status).not.to.equal(429);
      expect((await request(app).post('/session').send({})).status).to.equal(429);
      expect((await signIn(app)).status).to.equal(200);
    });
  });
});
