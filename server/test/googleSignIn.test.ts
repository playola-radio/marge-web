import { expect } from 'chai';
import jwt from 'jsonwebtoken';
import { exchangeGoogleCode, GoogleSignInRejected } from '../src/lib/googleSignIn.js';

describe('exchangeGoogleCode', () => {
  const realFetch = globalThis.fetch;
  const client = { clientId: 'client-id', clientSecret: 'client-secret' };
  let calls: { url: string; init: RequestInit }[];

  const stubFetch = (status: number, body: unknown) => {
    calls = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  };

  const idToken = (claims: object) => jwt.sign(claims, 'any-key');

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('posts the exact form body to Google, including redirect_uri=postmessage', async () => {
    stubFetch(200, { id_token: idToken({ email: 'a@x.com', email_verified: true, name: 'A' }) });
    await exchangeGoogleCode('the-code', client);

    expect(calls).to.have.length(1);
    expect(calls[0].url).to.equal('https://oauth2.googleapis.com/token');
    expect(calls[0].init.method).to.equal('POST');
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(body)).to.deep.equal({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uri: 'postmessage',
    });
  });

  it('maps the id_token claims to a GoogleIdentity', async () => {
    stubFetch(200, {
      id_token: idToken({ email: 'a@x.com', email_verified: true, name: 'Ann Example' }),
    });
    expect(await exchangeGoogleCode('c', client)).to.deep.equal({
      email: 'a@x.com',
      emailVerified: true,
      name: 'Ann Example',
    });
  });

  it('falls back to the email when the id_token has no name', async () => {
    stubFetch(200, { id_token: idToken({ email: 'a@x.com', email_verified: false }) });
    expect(await exchangeGoogleCode('c', client)).to.deep.equal({
      email: 'a@x.com',
      emailVerified: false,
      name: 'a@x.com',
    });
  });

  it('throws GoogleSignInRejected when the id_token has no email', async () => {
    stubFetch(200, { id_token: idToken({ name: 'No Email' }) });
    let caught: unknown;
    try {
      await exchangeGoogleCode('c', client);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(GoogleSignInRejected);
  });

  it('throws GoogleSignInRejected when Google answers 400', async () => {
    stubFetch(400, { error: 'invalid_grant' });
    let caught: unknown;
    try {
      await exchangeGoogleCode('c', client);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(GoogleSignInRejected);
  });

  it('throws a plain Error when Google answers 500', async () => {
    stubFetch(500, { error: 'server_error' });
    let caught: unknown;
    try {
      await exchangeGoogleCode('c', client);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(Error);
    expect(caught).not.to.be.instanceOf(GoogleSignInRejected);
  });
});
