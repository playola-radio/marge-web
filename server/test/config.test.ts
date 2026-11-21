import { expect } from 'chai';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses env with defaults', () => {
    const cfg = loadConfig({
      BASE_URL: 'https://relay.example.com',
      KV_BACKEND: 'memory',
    } as NodeJS.ProcessEnv);
    expect(cfg.baseUrl).to.equal('https://relay.example.com');
    expect(cfg.kvBackend).to.equal('memory');
    expect(cfg.sessionTtlSeconds).to.equal(600);
    expect(cfg.providers.google.authorizeEndpoint).to.contain('accounts.google.com');
    expect(cfg.providers.spotify.authorizeEndpoint).to.contain('accounts.spotify.com');
  });

  it('lets GOOGLE_AUTH_ENDPOINT override the google provider endpoint', () => {
    const cfg = loadConfig({
      BASE_URL: 'https://relay.example.com',
      KV_BACKEND: 'memory',
      GOOGLE_AUTH_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth?override=1',
    } as NodeJS.ProcessEnv);
    expect(cfg.providers.google.authorizeEndpoint).to.equal(
      'https://accounts.google.com/o/oauth2/v2/auth?override=1',
    );
  });

  it('throws when BASE_URL is missing', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).to.throw(/BASE_URL/);
  });

  it('defaults KV_BACKEND to postgres and requires DATABASE_URL', () => {
    expect(() => loadConfig({ BASE_URL: 'https://x.test' } as NodeJS.ProcessEnv)).to.throw(
      /DATABASE_URL/,
    );
    const cfg = loadConfig({
      BASE_URL: 'https://x.test',
      DATABASE_URL: 'postgres://u:p@h:5432/db',
    } as NodeJS.ProcessEnv);
    expect(cfg.kvBackend).to.equal('postgres');
  });

  it('throws when SESSION_TTL_SECONDS is non-numeric or non-positive', () => {
    const base = { BASE_URL: 'https://x.test', KV_BACKEND: 'memory' };
    expect(() => loadConfig({ ...base, SESSION_TTL_SECONDS: 'abc' } as NodeJS.ProcessEnv)).to.throw(
      /SESSION_TTL_SECONDS/,
    );
    expect(() => loadConfig({ ...base, SESSION_TTL_SECONDS: '0' } as NodeJS.ProcessEnv)).to.throw(
      /SESSION_TTL_SECONDS/,
    );
  });

  describe('sign-in settings', () => {
    const base = { BASE_URL: 'https://x.test', KV_BACKEND: 'memory' };
    const load = (env: Record<string, string>) =>
      loadConfig({ ...base, ...env } as NodeJS.ProcessEnv);

    it('parses MARGE_ALLOWED_EMAILS trimmed, lower-cased, without empties', () => {
      expect(load({ MARGE_ALLOWED_EMAILS: ' A@x.com, ,b@y.com ' }).allowedEmails).to.deep.equal([
        'a@x.com',
        'b@y.com',
      ]);
    });

    it('treats a missing MARGE_ALLOWED_EMAILS as an empty list', () => {
      expect(load({}).allowedEmails).to.deep.equal([]);
    });

    it('parses CLIENT_ORIGINS trimmed, without empties', () => {
      expect(
        load({ CLIENT_ORIGINS: ' https://marge.playola.fm, ,http://localhost:5173 ' })
          .clientOrigins,
      ).to.deep.equal(['https://marge.playola.fm', 'http://localhost:5173']);
    });

    it('sets googleSignIn only when both Google settings are present', () => {
      expect(load({}).googleSignIn).to.equal(null);
      expect(load({ GOOGLE_SIGNIN_CLIENT_ID: 'id' }).googleSignIn).to.equal(null);
      expect(load({ GOOGLE_SIGNIN_CLIENT_SECRET: 'secret' }).googleSignIn).to.equal(null);
      expect(
        load({ GOOGLE_SIGNIN_CLIENT_ID: 'id', GOOGLE_SIGNIN_CLIENT_SECRET: 'secret' }).googleSignIn,
      ).to.deep.equal({ clientId: 'id', clientSecret: 'secret' });
    });

    it('turns devLogin on only for NODE_ENV development or test', () => {
      expect(load({ NODE_ENV: 'development' }).devLogin).to.equal(true);
      expect(load({ NODE_ENV: 'test' }).devLogin).to.equal(true);
      expect(load({ NODE_ENV: 'production' }).devLogin).to.equal(false);
      expect(load({}).devLogin).to.equal(false);
      expect(load({ NODE_ENV: 'Development' }).devLogin).to.equal(false);
    });
  });

  describe('sign-in settings', () => {
    const base = { BASE_URL: 'https://x.test', KV_BACKEND: 'memory' };
    const load = (extra: Record<string, string>) =>
      loadConfig({ ...base, ...extra } as NodeJS.ProcessEnv);

    it('parses MARGE_ALLOWED_EMAILS into trimmed, lower-cased, non-empty entries', () => {
      expect(load({ MARGE_ALLOWED_EMAILS: ' A@x.com, ,b@y.com ' }).allowedEmails).to.deep.equal([
        'a@x.com',
        'b@y.com',
      ]);
    });

    it('treats a missing MARGE_ALLOWED_EMAILS as an empty list', () => {
      expect(load({}).allowedEmails).to.deep.equal([]);
    });

    it('parses CLIENT_ORIGINS into trimmed, non-empty entries', () => {
      expect(
        load({ CLIENT_ORIGINS: ' https://a.test, ,http://localhost:5173 ' }).clientOrigins,
      ).to.deep.equal(['https://a.test', 'http://localhost:5173']);
    });

    it('sets googleSignIn only when both Google settings are present', () => {
      expect(load({}).googleSignIn).to.equal(null);
      expect(load({ GOOGLE_SIGNIN_CLIENT_ID: 'id' }).googleSignIn).to.equal(null);
      expect(load({ GOOGLE_SIGNIN_CLIENT_SECRET: 'secret' }).googleSignIn).to.equal(null);
      expect(
        load({ GOOGLE_SIGNIN_CLIENT_ID: 'id', GOOGLE_SIGNIN_CLIENT_SECRET: 'secret' }).googleSignIn,
      ).to.deep.equal({ clientId: 'id', clientSecret: 'secret' });
    });

    it('turns devLogin on only for NODE_ENV exactly development or test', () => {
      expect(load({ NODE_ENV: 'development' }).devLogin).to.equal(true);
      expect(load({ NODE_ENV: 'test' }).devLogin).to.equal(true);
      expect(load({ NODE_ENV: 'production' }).devLogin).to.equal(false);
      expect(load({}).devLogin).to.equal(false);
      expect(load({ NODE_ENV: 'Development' }).devLogin).to.equal(false);
    });
  });
});
