import { assert } from "chai";
import request from "supertest";
import { buildApp } from "../../app.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";
import { loadConfig } from "../../lib/config/index.js";
import { MemoryKV } from "../../lib/kv/index.js";
import { initCrypto } from "../../lib/crypto/index.js";

function makeApp() {
  const config = loadConfig({
    BASE_URL: "https://relay.test",
    KV_BACKEND: "memory",
  } as NodeJS.ProcessEnv);
  const kv = new MemoryKV();
  return {
    app: buildApp({ kv, config, factoryHistory: new MemoryFactoryHistory() }),
    kv,
  };
}

// A real X25519 public key is exactly 32 bytes; base64-encode 32 bytes for fixtures.
const validPublicKey = Buffer.alloc(32, 7).toString("base64");

const validBody = {
  consent: {
    clientId: "client-123",
    scopes: "openid email",
    state: "state-abc",
    codeChallenge: "challenge-xyz",
    loginHint: "user@example.com",
  },
  pickupHash: "aGFzaA==",
  botPublicKey: validPublicKey,
};

describe("POST /session", () => {
  // botPublicKey validation decodes with libsodium, so sodium must be ready.
  before(async () => {
    await initCrypto();
  });

  it("creates a session and returns sessionId + authorizeUrl", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/session").send(validBody);
    assert.strictEqual(res.status, 201);
    assert.match(res.body.sessionId, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(
      res.body.authorizeUrl,
      `https://relay.test/connect?session=${res.body.sessionId}`,
    );
  });

  it("stores session by sessionId and indexes by state", async () => {
    const { app, kv } = makeApp();
    const res = await request(app).post("/session").send(validBody);
    const stored = await kv.get(`session:${res.body.sessionId}`);
    assert.typeOf(stored, "string");
    assert.strictEqual(await kv.get("state:state-abc"), res.body.sessionId);
  });

  it("rejects a body missing consent fields with 400", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/session")
      .send({ pickupHash: "x", botPublicKey: "y" });
    assert.strictEqual(res.status, 400);
  });

  it("rejects a botPublicKey that does not decode to 32 bytes with 400", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/session")
      .send({ ...validBody, botPublicKey: "cHVia2V5" }); // "pubkey" -> 6 bytes
    assert.strictEqual(res.status, 400);
  });

  it("rejects a URL-safe base64 botPublicKey with 400 (seal() decoder is strict ORIGINAL)", async () => {
    const { app } = makeApp();
    // 32 bytes of 0xFF -> base64url is all "_" chars, which Node's lenient decoder
    // accepts as 32 bytes but sodium's ORIGINAL decoder (used by seal()) rejects.
    const urlSafeKey = Buffer.alloc(32, 0xff).toString("base64url");
    const res = await request(app)
      .post("/session")
      .send({ ...validBody, botPublicKey: urlSafeKey });
    assert.strictEqual(res.status, 400);
  });

  it("rejects an empty required consent field with 400", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/session")
      .send({ ...validBody, consent: { ...validBody.consent, clientId: "" } });
    assert.strictEqual(res.status, 400);
  });

  it('defaults provider to "google" when omitted', async () => {
    const { app, kv } = makeApp();
    const res = await request(app).post("/session").send(validBody);
    assert.strictEqual(res.status, 201);
    const stored = JSON.parse(
      (await kv.get(`session:${res.body.sessionId}`)) as string,
    );
    assert.strictEqual(stored.consent.provider, "google");
  });

  it('accepts a known provider ("spotify") and stores it on the session', async () => {
    const { app, kv } = makeApp();
    const body = {
      ...validBody,
      consent: {
        ...validBody.consent,
        provider: "spotify",
        state: "spotify-state",
      },
    };
    const res = await request(app).post("/session").send(body);
    assert.strictEqual(res.status, 201);
    const stored = JSON.parse(
      (await kv.get(`session:${res.body.sessionId}`)) as string,
    );
    assert.strictEqual(stored.consent.provider, "spotify");
  });

  it("rejects an unknown provider with 400", async () => {
    const { app } = makeApp();
    const body = {
      ...validBody,
      consent: {
        ...validBody.consent,
        provider: "dropbox",
        state: "dropbox-state",
      },
    };
    const res = await request(app).post("/session").send(body);
    assert.strictEqual(res.status, 400);
  });

  it("rejects a second session reusing the same state with 409", async () => {
    const { app } = makeApp();
    const first = await request(app).post("/session").send(validBody);
    assert.strictEqual(first.status, 201);
    const second = await request(app).post("/session").send(validBody);
    assert.strictEqual(second.status, 409);
  });
});
