import { assert } from "chai";
import request from "supertest";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { buildApp } from "../../app.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";
import { loadConfig } from "../../lib/config/index.js";
import { MemoryKV } from "../../lib/kv/index.js";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

describe("POST /v1/auth/dev-login", () => {
  const prevSecret = process.env.JWT_SECRET;
  const prevNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
  });
  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });
  after(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  const makeApp = (nodeEnv: string | undefined) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    return buildApp({
      kv: new MemoryKV(),
      factoryHistory: new MemoryFactoryHistory(),
      config: loadConfig({
        BASE_URL: "http://localhost",
        KV_BACKEND: "memory",
        NODE_ENV: process.env.NODE_ENV,
      } as NodeJS.ProcessEnv),
    });
  };

  it("in development returns a 30-day token for the dev user", async () => {
    const res = await request(makeApp("development")).post(
      "/v1/auth/dev-login",
    );
    assert.strictEqual(res.status, 200);
    const payload = jwt.verify(res.body.margeToken, "test-secret", {
      algorithms: ["HS256"],
    }) as JwtPayload;
    assert.strictEqual(payload.email, "dev@marge.local");
    assert.strictEqual(payload.name, "Dev User");
    assert.strictEqual(payload.exp! - payload.iat!, THIRTY_DAYS);
  });

  it("signs in a second dev user with ?as=second, for two-account demos", async () => {
    const res = await request(makeApp("development")).post(
      "/v1/auth/dev-login?as=second",
    );
    assert.strictEqual(res.status, 200);
    const payload = jwt.verify(res.body.margeToken, "test-secret", {
      algorithms: ["HS256"],
    }) as JwtPayload;
    assert.strictEqual(payload.email, "dev2@marge.local");
    assert.strictEqual(payload.name, "Second Dev User");
  });

  it("returns a token that GET /v1/me accepts", async () => {
    const app = makeApp("development");
    const { body } = await request(app).post("/v1/auth/dev-login");
    const res = await request(app)
      .get("/v1/me")
      .set("Authorization", `Bearer ${body.margeToken}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.email, "dev@marge.local");
  });

  it("does not exist in production", async () => {
    const res = await request(makeApp("production")).post("/v1/auth/dev-login");
    assert.strictEqual(res.status, 404);
  });

  it("does not exist when NODE_ENV is unset", async () => {
    const res = await request(makeApp(undefined)).post("/v1/auth/dev-login");
    assert.strictEqual(res.status, 404);
  });

  it("returns 500 internal_error in development when JWT_SECRET is unset", async () => {
    delete process.env.JWT_SECRET;
    const res = await request(makeApp("development")).post(
      "/v1/auth/dev-login",
    );
    assert.strictEqual(res.status, 500);
    assert.deepEqual(res.body, { error: "internal_error" });
  });
});
