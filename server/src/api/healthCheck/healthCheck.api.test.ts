import { assert } from "chai";
import request from "supertest";
import { buildApp } from "../../app.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";
import { loadConfig } from "../../lib/config/index.js";
import { MemoryKV } from "../../lib/kv/index.js";

describe("GET /healthz", () => {
  it("returns 200", async () => {
    const config = loadConfig({
      BASE_URL: "https://x.test",
      KV_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    const app = buildApp({
      kv: undefined as never,
      config,
      factoryHistory: new MemoryFactoryHistory(),
    });
    const res = await request(app).get("/healthz");
    assert.strictEqual(res.status, 200);
  });
});

describe("/v1 healthCheck", () => {
  const makeApp = () =>
    buildApp({
      kv: new MemoryKV(),
      factoryHistory: new MemoryFactoryHistory(),
      config: loadConfig({
        BASE_URL: "http://localhost",
        KV_BACKEND: "memory",
      } as NodeJS.ProcessEnv),
    });

  it("GET /v1/healthCheck is public and returns ok", async () => {
    const res = await request(makeApp()).get("/v1/healthCheck");
    assert.strictEqual(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });
});
