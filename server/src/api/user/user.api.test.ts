import { assert } from "chai";
import request from "supertest";
import jwt from "jsonwebtoken";
import { buildApp } from "../../app.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";
import { loadConfig } from "../../lib/config/index.js";
import { MemoryKV } from "../../lib/kv/index.js";

describe("/v1/me", () => {
  const prevSecret = process.env.JWT_SECRET;
  before(() => {
    process.env.JWT_SECRET = "test-secret";
  });
  after(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  const makeApp = () =>
    buildApp({
      kv: new MemoryKV(),
      factoryHistory: new MemoryFactoryHistory(),
      config: loadConfig({
        BASE_URL: "http://localhost",
        KV_BACKEND: "memory",
        JWT_SECRET: "test-secret",
      } as NodeJS.ProcessEnv),
    });

  it("GET /v1/me without token returns 401", async () => {
    const res = await request(makeApp()).get("/v1/me");
    assert.strictEqual(res.status, 401);
  });

  it("GET /v1/me with invalid token returns 401", async () => {
    const bad = jwt.sign({ sub: "u1" }, "wrong-secret");
    const res = await request(makeApp())
      .get("/v1/me")
      .set("Authorization", `Bearer ${bad}`);
    assert.strictEqual(res.status, 401);
  });

  it("GET /v1/me with valid token echoes payload", async () => {
    const token = jwt.sign({ sub: "user-1" }, "test-secret", {
      algorithm: "HS256",
    });
    const res = await request(makeApp())
      .get("/v1/me")
      .set("Authorization", `Bearer ${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.sub, "user-1");
  });
});
