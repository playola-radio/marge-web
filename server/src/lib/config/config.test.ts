import { assert } from "chai";
import { loadConfig } from "./index.js";

describe("loadConfig", () => {
  it("parses env with defaults", () => {
    const cfg = loadConfig({
      BASE_URL: "https://relay.example.com",
      KV_BACKEND: "memory",
    } as NodeJS.ProcessEnv);
    assert.strictEqual(cfg.baseUrl, "https://relay.example.com");
    assert.strictEqual(cfg.kvBackend, "memory");
    assert.strictEqual(cfg.sessionTtlSeconds, 600);
    assert.include(
      cfg.providers.google.authorizeEndpoint,
      "accounts.google.com",
    );
    assert.include(
      cfg.providers.spotify.authorizeEndpoint,
      "accounts.spotify.com",
    );
  });

  it("lets GOOGLE_AUTH_ENDPOINT override the google provider endpoint", () => {
    const cfg = loadConfig({
      BASE_URL: "https://relay.example.com",
      KV_BACKEND: "memory",
      GOOGLE_AUTH_ENDPOINT:
        "https://accounts.google.com/o/oauth2/v2/auth?override=1",
    } as NodeJS.ProcessEnv);
    assert.strictEqual(
      cfg.providers.google.authorizeEndpoint,
      "https://accounts.google.com/o/oauth2/v2/auth?override=1",
    );
  });

  it("throws when BASE_URL is missing", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /BASE_URL/);
  });

  it("defaults KV_BACKEND to postgres and requires DATABASE_URL", () => {
    assert.throws(
      () => loadConfig({ BASE_URL: "https://x.test" } as NodeJS.ProcessEnv),
      /DATABASE_URL/,
    );
    const cfg = loadConfig({
      BASE_URL: "https://x.test",
      DATABASE_URL: "postgres://u:p@h:5432/db",
    } as NodeJS.ProcessEnv);
    assert.strictEqual(cfg.kvBackend, "postgres");
  });

  it("throws when SESSION_TTL_SECONDS is non-numeric or non-positive", () => {
    const base = { BASE_URL: "https://x.test", KV_BACKEND: "memory" };
    assert.throws(
      () =>
        loadConfig({
          ...base,
          SESSION_TTL_SECONDS: "abc",
        } as NodeJS.ProcessEnv),
      /SESSION_TTL_SECONDS/,
    );
    assert.throws(
      () =>
        loadConfig({ ...base, SESSION_TTL_SECONDS: "0" } as NodeJS.ProcessEnv),
      /SESSION_TTL_SECONDS/,
    );
  });

  describe("sign-in settings", () => {
    const base = { BASE_URL: "https://x.test", KV_BACKEND: "memory" };
    const load = (env: Record<string, string>) =>
      loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);

    it("parses MARGE_ALLOWED_EMAILS trimmed, lower-cased, without empties", () => {
      assert.deepEqual(
        load({ MARGE_ALLOWED_EMAILS: " A@x.com, ,b@y.com " }).allowedEmails,
        ["a@x.com", "b@y.com"],
      );
    });

    it("treats a missing MARGE_ALLOWED_EMAILS as an empty list", () => {
      assert.deepEqual(load({}).allowedEmails, []);
    });

    it("parses CLIENT_ORIGINS trimmed, without empties", () => {
      assert.deepEqual(
        load({
          CLIENT_ORIGINS: " https://marge.playola.fm, ,http://localhost:5173 ",
        }).clientOrigins,
        ["https://marge.playola.fm", "http://localhost:5173"],
      );
    });

    it("sets googleSignIn only when both Google settings are present", () => {
      assert.isNull(load({}).googleSignIn);
      assert.isNull(load({ GOOGLE_SIGNIN_CLIENT_ID: "id" }).googleSignIn);
      assert.isNull(
        load({ GOOGLE_SIGNIN_CLIENT_SECRET: "secret" }).googleSignIn,
      );
      assert.deepEqual(
        load({
          GOOGLE_SIGNIN_CLIENT_ID: "id",
          GOOGLE_SIGNIN_CLIENT_SECRET: "secret",
        }).googleSignIn,
        { clientId: "id", clientSecret: "secret" },
      );
    });

    it("turns devLogin on only for NODE_ENV development or test", () => {
      assert.isTrue(load({ NODE_ENV: "development" }).devLogin);
      assert.isTrue(load({ NODE_ENV: "test" }).devLogin);
      assert.isFalse(load({ NODE_ENV: "production" }).devLogin);
      assert.isFalse(load({}).devLogin);
      assert.isFalse(load({ NODE_ENV: "Development" }).devLogin);
    });
  });

  describe("factory report token", () => {
    const base = { BASE_URL: "https://x.test", KV_BACKEND: "memory" };
    const load = (env: Record<string, string>) =>
      loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);

    it("reads FACTORY_REPORT_TOKEN", () => {
      assert.strictEqual(
        load({ FACTORY_REPORT_TOKEN: "abc" }).factoryReportToken,
        "abc",
      );
    });

    it("gives null when FACTORY_REPORT_TOKEN is unset or empty", () => {
      assert.isNull(load({}).factoryReportToken);
      assert.isNull(load({ FACTORY_REPORT_TOKEN: "" }).factoryReportToken);
    });
  });
});
