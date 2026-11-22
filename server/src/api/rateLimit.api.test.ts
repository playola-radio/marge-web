import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../app.js';
import { MemoryFactoryHistory } from '../lib/factoryHistory/index.js';
import { loadConfig } from '../lib/config/index.js';
import { MemoryKV } from '../lib/kv/index.js';

describe('rate limiting', () => {
  it('429s on /result after exceeding the configured max', async () => {
    const config = loadConfig({
      BASE_URL: 'https://relay.test',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    const app = buildApp({
      kv: new MemoryKV(),
      config,
      factoryHistory: new MemoryFactoryHistory(),
      rateLimit: { windowMs: 60_000, max: 2 },
    });

    const send = () => request(app).post('/result').send({ sessionId: 'x', pickup_secret: 'y' });
    await send();
    await send();
    const third = await send();
    expect(third.status).to.equal(429);
  });
});
