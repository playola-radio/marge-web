import { createRequire } from "node:module";
import { assert } from "chai";
import request from "supertest";
import { buildApp } from "../../app.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";

// libsodium-wrappers ESM build is broken (missing libsodium.mjs sibling);
// use createRequire to force the CJS path, same as in crypto.ts and crypto.test.ts.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium =
  require("libsodium-wrappers") as typeof import("libsodium-wrappers");
import { loadConfig } from "../../lib/config/index.js";
import { MemoryKV } from "../../lib/kv/index.js";
import {
  sessionKey,
  stateKey,
  type SessionRecord,
} from "../../lib/session/index.js";
import { initCrypto } from "../../lib/crypto/index.js";

describe("GET /callback", () => {
  let keypair: sodium.KeyPair;

  before(async () => {
    await initCrypto();
    keypair = sodium.crypto_box_keypair();
  });

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

  function seededRecord(): SessionRecord {
    return {
      consent: {
        clientId: "c1",
        scopes: "openid",
        state: "st1",
        codeChallenge: "ch1",
      },
      pickupHash: "h",
      botPublicKey: sodium.to_base64(
        keypair.publicKey,
        sodium.base64_variants.ORIGINAL,
      ),
      status: "pending",
      createdAt: Date.now(),
    };
  }

  it("seals the code to the bot public key and marks the session complete", async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey("sess1"), JSON.stringify(seededRecord()), 600);
    await kv.put(stateKey("st1"), "sess1", 600);

    const res = await request(app).get(
      "/callback?state=st1&code=auth-code-123",
    );
    assert.strictEqual(res.status, 200);
    assert.include(res.text, "all set");

    const updated = JSON.parse(
      (await kv.get(sessionKey("sess1")))!,
    ) as SessionRecord;
    assert.strictEqual(updated.status, "complete");
    assert.typeOf(updated.sealedCode, "string");

    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(updated.sealedCode!, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    assert.strictEqual(new TextDecoder().decode(opened), "auth-code-123");
    // state index is consumed
    assert.isNull(await kv.get(stateKey("st1")));
  });

  it("stores the error and renders the error page when Google returns ?error", async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey("sess2"), JSON.stringify(seededRecord()), 600);
    await kv.put(stateKey("st1"), "sess2", 600);

    const res = await request(app).get(
      "/callback?state=st1&error=access_denied",
    );
    assert.strictEqual(res.status, 200);
    const updated = JSON.parse(
      (await kv.get(sessionKey("sess2")))!,
    ) as SessionRecord;
    assert.strictEqual(updated.status, "complete");
    assert.strictEqual(updated.error, "access_denied");
    assert.isUndefined(updated.sealedCode);
    // state index is consumed even on the error path (single-use)
    assert.isNull(await kv.get(stateKey("st1")));
  });

  it("returns 410 when state is unknown/expired", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/callback?state=nope&code=x");
    assert.strictEqual(res.status, 410);
  });

  it("a replayed callback for an already-consumed state returns 410 (no re-seal)", async () => {
    const { app, kv } = makeApp();
    await kv.put(sessionKey("sess3"), JSON.stringify(seededRecord()), 600);
    await kv.put(stateKey("st1"), "sess3", 600);

    const first = await request(app).get(
      "/callback?state=st1&code=auth-code-123",
    );
    assert.strictEqual(first.status, 200);
    const sealedAfterFirst = (
      JSON.parse((await kv.get(sessionKey("sess3")))!) as SessionRecord
    ).sealedCode;

    // Replay: state was consumed, so the second callback must not touch the session.
    const replay = await request(app).get(
      "/callback?state=st1&code=different-code",
    );
    assert.strictEqual(replay.status, 410);
    const sealedAfterReplay = (
      JSON.parse((await kv.get(sessionKey("sess3")))!) as SessionRecord
    ).sealedCode;
    assert.strictEqual(sealedAfterReplay, sealedAfterFirst);
  });
});
