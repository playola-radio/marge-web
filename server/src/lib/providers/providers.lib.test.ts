import { assert } from "chai";
import { buildConsentUrl, type OAuthProvider } from "./index.js";

const googleProvider: OAuthProvider = {
  authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  extraAuthParams: { access_type: "offline", prompt: "consent" },
  supportsLoginHint: true,
};

const spotifyProvider: OAuthProvider = {
  authorizeEndpoint: "https://accounts.spotify.com/authorize",
  extraAuthParams: {},
  supportsLoginHint: false,
};

const consent = {
  clientId: "client-123",
  scopes: "openid email",
  state: "state-abc",
  codeChallenge: "challenge-xyz",
  loginHint: "user@example.com",
};

const redirectUri = "https://relay.test/callback";

describe("buildConsentUrl", () => {
  it("builds a Google consent URL with PKCE + Google-specific params", () => {
    const url = new URL(
      buildConsentUrl({ provider: googleProvider, redirectUri, consent }),
    );
    assert.strictEqual(
      url.origin + url.pathname,
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const p = url.searchParams;
    assert.strictEqual(p.get("client_id"), "client-123");
    assert.strictEqual(p.get("redirect_uri"), redirectUri);
    assert.strictEqual(p.get("response_type"), "code");
    assert.strictEqual(p.get("scope"), "openid email");
    assert.strictEqual(p.get("state"), "state-abc");
    assert.strictEqual(p.get("code_challenge"), "challenge-xyz");
    assert.strictEqual(p.get("code_challenge_method"), "S256");
    assert.strictEqual(p.get("access_type"), "offline");
    assert.strictEqual(p.get("prompt"), "consent");
    assert.strictEqual(p.get("login_hint"), "user@example.com");
  });

  it("builds a Spotify consent URL with PKCE and without Google-only params", () => {
    const url = new URL(
      buildConsentUrl({ provider: spotifyProvider, redirectUri, consent }),
    );
    assert.strictEqual(
      url.origin + url.pathname,
      "https://accounts.spotify.com/authorize",
    );
    const p = url.searchParams;
    assert.strictEqual(p.get("client_id"), "client-123");
    assert.strictEqual(p.get("redirect_uri"), redirectUri);
    assert.strictEqual(p.get("response_type"), "code");
    assert.strictEqual(p.get("scope"), "openid email");
    assert.strictEqual(p.get("code_challenge"), "challenge-xyz");
    assert.strictEqual(p.get("code_challenge_method"), "S256");
    // Google-only params must NOT leak onto a Spotify URL.
    assert.isFalse(p.has("access_type"));
    assert.isFalse(p.has("prompt"));
    // Spotify does not support login_hint; it must be dropped even when supplied.
    assert.isFalse(p.has("login_hint"));
  });

  it("omits login_hint for a login-hint provider when none is provided", () => {
    const url = new URL(
      buildConsentUrl({
        provider: googleProvider,
        redirectUri,
        consent: { ...consent, loginHint: undefined },
      }),
    );
    assert.isFalse(url.searchParams.has("login_hint"));
  });
});
