import { assert } from "chai";
import request from "supertest";
import { buildApp } from "../../app.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";
import { loadConfig } from "../../lib/config/index.js";
import { MemoryKV } from "../../lib/kv/index.js";
import { sessionKey, type SessionRecord } from "../../lib/session/index.js";
import { newToken } from "../../lib/ids/index.js";

function makeApp() {
  const config = loadConfig({
    BASE_URL: "https://relay.test",
    KV_BACKEND: "memory",
  } as NodeJS.ProcessEnv);
  const kv = new MemoryKV();
  return {
    app: buildApp({ kv, config, factoryHistory: new MemoryFactoryHistory() }),
    kv,
    config,
  };
}

const record: SessionRecord = {
  consent: {
    clientId: "c1",
    scopes: "openid",
    state: "st1",
    codeChallenge: "ch1",
  },
  pickupHash: "h",
  botPublicKey: "pk",
  status: "pending",
  createdAt: Date.now(),
};

describe("GET /authorize", () => {
  it("302-redirects to Google with redirect_uri set to this app callback", async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    await kv.put(sessionKey(id), JSON.stringify(record), 600);
    const res = await request(app).get(`/authorize?session=${id}`).redirects(0);
    assert.strictEqual(res.status, 302);
    const loc = new URL(res.headers.location);
    assert.strictEqual(loc.origin, "https://accounts.google.com");
    assert.strictEqual(
      loc.searchParams.get("redirect_uri"),
      "https://relay.test/callback",
    );
    assert.strictEqual(loc.searchParams.get("client_id"), "c1");
    assert.strictEqual(loc.searchParams.get("state"), "st1");
  });

  it("302-redirects to Spotify for a spotify-provider session, without Google-only params", async () => {
    const { app, kv } = makeApp();
    const id = newToken();
    const spotifyRecord: SessionRecord = {
      ...record,
      consent: { ...record.consent, provider: "spotify" },
    };
    await kv.put(sessionKey(id), JSON.stringify(spotifyRecord), 600);
    const res = await request(app).get(`/authorize?session=${id}`).redirects(0);
    assert.strictEqual(res.status, 302);
    const loc = new URL(res.headers.location);
    assert.strictEqual(loc.origin, "https://accounts.spotify.com");
    assert.strictEqual(loc.searchParams.get("client_id"), "c1");
    assert.strictEqual(
      loc.searchParams.get("redirect_uri"),
      "https://relay.test/callback",
    );
    assert.isFalse(loc.searchParams.has("access_type"));
    assert.isFalse(loc.searchParams.has("prompt"));
  });

  it("returns 410 for a well-formed but unknown/expired session", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get(`/authorize?session=${newToken()}`)
      .redirects(0);
    assert.strictEqual(res.status, 410);
  });

  it("returns 400 for a malformed/missing session param", async () => {
    const { app } = makeApp();
    assert.strictEqual(
      (await request(app).get("/authorize").redirects(0)).status,
      400,
    );
    assert.strictEqual(
      (await request(app).get("/authorize?session=not-a-token").redirects(0))
        .status,
      400,
    );
  });
});
