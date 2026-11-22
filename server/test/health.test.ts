import { expect } from 'chai';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { MemoryFactoryHistory } from '../src/lib/factoryHistory.js';
import { loadConfig } from '../src/config.js';

describe('GET /healthz', () => {
  it('returns 200', async () => {
    const config = loadConfig({
      BASE_URL: 'https://x.test',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    const app = buildApp({
      kv: undefined as never,
      config,
      factoryHistory: new MemoryFactoryHistory(),
    });
    const res = await request(app).get('/healthz');
    expect(res.status).to.equal(200);
  });
});
