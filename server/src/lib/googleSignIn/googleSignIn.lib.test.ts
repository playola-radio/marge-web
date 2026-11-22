import { assert } from "chai";
import jwt from "jsonwebtoken";
import { exchangeGoogleCode, GoogleSignInRejected } from "./index.js";

describe("exchangeGoogleCode", () => {
  const realFetch = globalThis.fetch;
  const client = { clientId: "client-id", clientSecret: "client-secret" };
  let calls: { url: string; init: RequestInit }[];

  const stubFetch = (status: number, body: unknown) => {
    calls = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };

  const idToken = (claims: object) => jwt.sign(claims, "any-key");

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts the exact form body to Google, including redirect_uri=postmessage", async () => {
    stubFetch(200, {
      id_token: idToken({ email: "a@x.com", email_verified: true, name: "A" }),
    });
    await exchangeGoogleCode("the-code", client);

    assert.lengthOf(calls, 1);
    assert.strictEqual(calls[0].url, "https://oauth2.googleapis.com/token");
    assert.strictEqual(calls[0].init.method, "POST");
    const body = new URLSearchParams(String(calls[0].init.body));
    assert.deepEqual(Object.fromEntries(body), {
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uri: "postmessage",
    });
  });

  it("maps the id_token claims to a GoogleIdentity", async () => {
    stubFetch(200, {
      id_token: idToken({
        email: "a@x.com",
        email_verified: true,
        name: "Ann Example",
      }),
    });
    assert.deepEqual(await exchangeGoogleCode("c", client), {
      email: "a@x.com",
      emailVerified: true,
      name: "Ann Example",
    });
  });

  it("falls back to the email when the id_token has no name", async () => {
    stubFetch(200, {
      id_token: idToken({ email: "a@x.com", email_verified: false }),
    });
    assert.deepEqual(await exchangeGoogleCode("c", client), {
      email: "a@x.com",
      emailVerified: false,
      name: "a@x.com",
    });
  });

  it("throws GoogleSignInRejected when the id_token has no email", async () => {
    stubFetch(200, { id_token: idToken({ name: "No Email" }) });
    let caught: unknown;
    try {
      await exchangeGoogleCode("c", client);
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, GoogleSignInRejected);
  });

  it("throws GoogleSignInRejected when Google answers 400", async () => {
    stubFetch(400, { error: "invalid_grant" });
    let caught: unknown;
    try {
      await exchangeGoogleCode("c", client);
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, GoogleSignInRejected);
  });

  it("throws a plain Error when Google answers 500", async () => {
    stubFetch(500, { error: "server_error" });
    let caught: unknown;
    try {
      await exchangeGoogleCode("c", client);
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, Error);
    assert.notInstanceOf(caught, GoogleSignInRejected);
  });
});
