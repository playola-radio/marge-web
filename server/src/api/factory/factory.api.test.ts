import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../lib/config/index.js';
import { MemoryKV } from '../../lib/kv/index.js';
import { MemoryFactoryHistory } from '../../lib/factoryHistory/index.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const FACTORY_TOKEN = 'factory-token';

/** The example sync body from ApiContract.md: two builds, one event, one artifact. */
function validSync(): Json {
  return {
    catalog: {
      statuses: [
        { key: 'needs_you', label: 'Needs you', shortLabel: 'You', role: 'attention' },
        { key: 'stopped', label: 'Stopped', shortLabel: 'Stopped', role: 'failure' },
        { key: 'no_progress', label: 'No progress', shortLabel: 'Quiet', role: 'quiet' },
        { key: 'running', label: 'Running', shortLabel: 'Running', role: 'active' },
        { key: 'done', label: 'Done', shortLabel: 'Done', role: 'complete' },
      ],
    },
    snapshot: {
      builds: [
        {
          runId: '98093cbb-16c0-43a9-b026-cc9b1d91c47a',
          repo: 'playola-radio/playola',
          designNumber: '014',
          designName: 'Recorded shows',
          status: 'needs_you',
          stages: ['Implement', 'Review gate', 'PR open', 'Reviewers', 'Merge'],
          currentStage: 4,
          reason: 'Reviews answered. Ready for you to merge.',
          pr: {
            position: 2,
            total: 3,
            number: 812,
            url: 'https://github.com/playola-radio/playola/pull/812',
          },
          lastEventAt: '2026-11-21T18:34:04.801Z',
        },
        {
          runId: '3f0e2a51-7b8c-4d2e-9a61-0c5d8e7f1b24',
          repo: 'playola-radio/factory',
          designNumber: '004',
          designName: 'Notify on pause',
          status: 'no_progress',
          stages: ['Implement', 'Review gate', 'PR open', 'Reviewers', 'Merge'],
          currentStage: 0,
          reason: 'Still implementing. Nothing new for 1 h 10 min.',
          pr: { position: 1, total: 1, number: null, url: null },
          lastEventAt: '2026-11-21T17:32:10.000Z',
        },
      ],
      counts: { upNext: 3, planNotFinished: 1, done: 22 },
    },
    events: [
      {
        id: '0d841412-1ae9-4af5-9c3d-a2e58a6099f0',
        runId: '98093cbb-16c0-43a9-b026-cc9b1d91c47a',
        at: '2026-11-21T18:34:04.801Z',
        repo: 'playola-radio/playola',
        design: '014-recorded-shows',
        pr: 2,
        type: 'pr waiting on owner',
        details: { number: 812, url: 'https://github.com/playola-radio/playola/pull/812' },
        artifactId: '0969de36-50de-4b61-9340-408a40d162ae',
      },
    ],
    artifacts: [
      {
        id: '0969de36-50de-4b61-9340-408a40d162ae',
        kind: 'pr_report',
        at: '2026-11-21T18:34:04.801Z',
        body: { implementation: {}, gate: {}, pullRequest: {}, review: {} },
      },
    ],
  };
}

/** A second, different sync (body B): new run, new event, new artifact. */
function otherSync(): Json {
  const body = validSync();
  body.snapshot.builds = [
    {
      ...body.snapshot.builds[1],
      runId: 'aa0e2a51-7b8c-4d2e-9a61-0c5d8e7f1b24',
      status: 'running',
      reason: 'Implementing.',
    },
  ];
  body.snapshot.counts = { upNext: 2, planNotFinished: 0, done: 23 };
  body.events = [
    {
      id: 'bb841412-1ae9-4af5-9c3d-a2e58a6099f0',
      runId: 'aa0e2a51-7b8c-4d2e-9a61-0c5d8e7f1b24',
      at: '2026-11-21T19:00:00.000Z',
      repo: 'playola-radio/factory',
      design: '004-notify-on-pause',
      pr: 1,
      type: 'gate clean',
      details: {},
      artifactId: 'cc69de36-50de-4b61-9340-408a40d162ae',
    },
  ];
  body.artifacts = [
    {
      id: 'cc69de36-50de-4b61-9340-408a40d162ae',
      kind: 'pr_report',
      at: '2026-11-21T19:00:00.000Z',
      body: { implementation: { summary: 'B' } },
    },
  ];
  return body;
}

const margeToken = () =>
  jwt.sign({ email: 'owner@example.com', name: 'Owner' }, 'test-secret', {
    algorithm: 'HS256',
  });

describe('factory sync and snapshot', () => {
  const prevSecret = process.env.JWT_SECRET;
  before(() => {
    process.env.JWT_SECRET = 'test-secret';
  });
  after(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  function makeApp(opts: { token?: string | null; kv?: MemoryKV } = {}) {
    const env: Record<string, string> = {
      BASE_URL: 'http://localhost',
      KV_BACKEND: 'memory',
      JWT_SECRET: 'test-secret',
    };
    const token = opts.token === undefined ? FACTORY_TOKEN : opts.token;
    if (token !== null) env.FACTORY_REPORT_TOKEN = token;
    const kv = opts.kv ?? new MemoryKV();
    const history = new MemoryFactoryHistory();
    const app = buildApp({
      kv,
      config: loadConfig(env as NodeJS.ProcessEnv),
      factoryHistory: history,
    });
    const push = (body: unknown, auth: string | null = `Bearer ${FACTORY_TOKEN}`) => {
      const req = request(app).post('/v1/factory/sync');
      if (auth !== null) req.set('Authorization', auth);
      return typeof body === 'string'
        ? req.set('Content-Type', 'application/json').send(body)
        : req.send(body as object);
    };
    const read = (auth: string | null = `Bearer ${margeToken()}`) => {
      const req = request(app).get('/v1/factory/snapshot');
      if (auth !== null) req.set('Authorization', auth);
      return req;
    };
    return { history, push, read };
  }

  const historyCopy = (history: MemoryFactoryHistory) => ({
    artifacts: [...history.artifacts.values()],
    events: [...history.events.values()],
  });

  describe('auth', () => {
    it('accepts a valid push with the factory token and answers 204', async () => {
      const { push } = makeApp();
      const res = await push(validSync());
      expect(res.status).to.equal(204);
      expect(res.text).to.equal('');
    });

    it('returns the latest state, as sent, to a signed-in marge user', async () => {
      const { push, read } = makeApp();
      const body = validSync();
      body.snapshot.builds[0].somethingNew = { extra: true };
      const before = Date.now();
      expect((await push(body)).status).to.equal(204);
      const after = Date.now();
      const res = await read();
      expect(res.status).to.equal(200);
      expect(res.body.catalog).to.deep.equal(body.catalog);
      expect(res.body.snapshot).to.deep.equal(body.snapshot);
      const receivedAt = Date.parse(res.body.receivedAt);
      expect(receivedAt).to.be.within(before, after);
      expect(res.body.receivedAt).to.equal(new Date(receivedAt).toISOString());
      expect(res.body.serverNow).to.equal(new Date(Date.parse(res.body.serverNow)).toISOString());
      expect(Date.parse(res.body.serverNow)).to.be.at.least(receivedAt);
    });

    it('answers "never reported" before any push', async () => {
      const { read } = makeApp();
      const before = Date.now();
      const res = await read();
      expect(res.status).to.equal(200);
      expect(res.body).to.include({ catalog: null, snapshot: null, receivedAt: null });
      expect(Object.keys(res.body).sort()).to.deep.equal(
        ['catalog', 'receivedAt', 'serverNow', 'snapshot'].sort(),
      );
      expect(Date.parse(res.body.serverNow)).to.be.at.least(before - 1);
    });

    it('replaces the latest state on a second push', async () => {
      const { push, read } = makeApp();
      await push(validSync());
      await push(otherSync());
      const res = await read();
      expect(res.body.snapshot).to.deep.equal(otherSync().snapshot);
    });

    for (const [name, auth] of [
      ['no Authorization header', null],
      ['a wrong token', 'Bearer not-the-factory-token'],
      ['a valid marge token', 'MARGE'],
      ['the token without Bearer', FACTORY_TOKEN],
    ] as const) {
      it(`refuses a push with ${name} (401)`, async () => {
        const { push, read, history } = makeApp();
        const header = auth === 'MARGE' ? `Bearer ${margeToken()}` : auth;
        const res = await push(validSync(), header);
        expect(res.status).to.equal(401);
        expect(res.body).to.deep.equal({ error: 'unauthorized' });
        expect((await read()).body.snapshot).to.equal(null);
        expect(history.events.size).to.equal(0);
        expect(history.artifacts.size).to.equal(0);
      });
    }

    it('refuses every push while FACTORY_REPORT_TOKEN is unset', async () => {
      const { push } = makeApp({ token: null });
      const res = await push(validSync());
      expect(res.status).to.equal(401);
      expect(res.body).to.deep.equal({ error: 'unauthorized' });
    });

    it('refuses GET with no token, and with the factory token', async () => {
      const { push, read } = makeApp();
      await push(validSync());
      for (const auth of [null, `Bearer ${FACTORY_TOKEN}`]) {
        const res = await read(auth);
        expect(res.status).to.equal(401);
        expect(res.body).to.deep.equal({ error: 'unauthorized' });
      }
    });

    it('answers 401, not 400, to a wrong token whatever the body', async () => {
      const { push } = makeApp();
      const invalid = validSync();
      delete invalid.catalog;
      for (const body of [invalid, '{', 'null']) {
        const res = await push(body, 'Bearer wrong');
        expect(res.status).to.equal(401);
        expect(res.body).to.deep.equal({ error: 'unauthorized' });
      }
    });

    it('answers 400 invalid_sync to malformed JSON or a bare null, storing nothing', async () => {
      const { push, read, history } = makeApp();
      await push(validSync());
      const first = await read();
      const stored = historyCopy(history);
      for (const raw of ['{', 'null', '42']) {
        const res = await push(raw);
        expect(res.status).to.equal(400);
        expect(res.body).to.deep.equal({ error: 'invalid_sync' });
      }
      const after = await read();
      expect(after.body.snapshot).to.deep.equal(first.body.snapshot);
      expect(after.body.receivedAt).to.equal(first.body.receivedAt);
      expect(historyCopy(history)).to.deep.equal(stored);
    });

    it('answers 413 invalid_sync to a body over 5 MB', async () => {
      const { push } = makeApp();
      const raw = `{"padding":"${'a'.repeat(5 * 1024 * 1024 + 1)}"}`;
      const res = await push(raw);
      expect(res.status).to.equal(413);
      expect(res.body).to.deep.equal({ error: 'invalid_sync' });
    });
  });

  describe('history', () => {
    it('keeps the artifact and the event as sent, without unknown fields', async () => {
      const { push, history } = makeApp();
      const body = validSync();
      body.events[0].unknown = 'dropped';
      body.artifacts[0].unknown = 'dropped';
      expect((await push(body)).status).to.equal(204);
      expect(historyCopy(history)).to.deep.equal({
        artifacts: validSync().artifacts,
        events: validSync().events,
      });
    });

    it('keeps exactly one copy when the same body is sent twice', async () => {
      const { push, history } = makeApp();
      expect((await push(validSync())).status).to.equal(204);
      expect((await push(validSync())).status).to.equal(204);
      expect(history.events.size).to.equal(1);
      expect(history.artifacts.size).to.equal(1);
    });

    it('keeps the first copy when an event id is resent with a different type', async () => {
      const { push, history } = makeApp();
      await push(validSync());
      const resend = validSync();
      resend.events[0].type = 'something else';
      expect((await push(resend)).status).to.equal(204);
      expect(history.events.get(validSync().events[0].id)?.type).to.equal('pr waiting on owner');
    });

    it('stores an event without pr, details or artifactId as null, {} and null', async () => {
      const { push, history } = makeApp();
      const body = validSync();
      delete body.events[0].pr;
      delete body.events[0].details;
      delete body.events[0].artifactId;
      expect((await push(body)).status).to.equal(204);
      expect(history.events.get(body.events[0].id)).to.deep.include({
        pr: null,
        details: {},
        artifactId: null,
      });
    });

    it('accepts a heartbeat, updating receivedAt and adding nothing', async () => {
      const { push, read, history } = makeApp();
      await push(validSync());
      const first = await read();
      const stored = historyCopy(history);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const heartbeat = validSync();
      heartbeat.events = [];
      heartbeat.artifacts = [];
      expect((await push(heartbeat)).status).to.equal(204);
      const after = await read();
      expect(Date.parse(after.body.receivedAt)).to.be.greaterThan(
        Date.parse(first.body.receivedAt),
      );
      expect(historyCopy(history)).to.deep.equal(stored);
    });
  });

  describe('validation', () => {
    const status = (key: string) => ({ key, label: key, shortLabel: 'x', role: 'active' });
    const build = (b: Json, i: number) => ({ ...b, runId: randomUUID(), designName: `D ${i}` });
    const event = (i: number) => ({
      id: randomUUID(),
      runId: randomUUID(),
      at: '2026-11-21T18:34:04.801Z',
      repo: 'playola-radio/playola',
      design: '014-recorded-shows',
      type: `event ${i}`,
    });
    const artifact = () => ({
      id: randomUUID(),
      kind: 'pr_report',
      at: '2026-11-21T18:34:04.801Z',
      body: {},
    });
    const b0 = (s: Json) => s.snapshot.builds[0];
    const e0 = (s: Json) => s.events[0];
    const a0 = (s: Json) => s.artifacts[0];

    const cases: Array<[string, (s: Json) => unknown]> = [
      ['no catalog', (s) => delete s.catalog],
      ['catalog.statuses: []', (s) => (s.catalog.statuses = [])],
      [
        '21 statuses',
        (s) =>
          (s.catalog.statuses = [
            ...s.catalog.statuses,
            ...Array.from({ length: 16 }, (_, i) => status(`extra_${i}`)),
          ]),
      ],
      ['a status key "Needs you"', (s) => (s.catalog.statuses[0].key = 'Needs you')],
      ['two statuses with the same key', (s) => (s.catalog.statuses[1].key = 'needs_you')],
      ['a 31-char label', (s) => (s.catalog.statuses[0].label = 'L'.repeat(31))],
      ['a 13-char shortLabel', (s) => (s.catalog.statuses[0].shortLabel = 'S'.repeat(13))],
      ['an empty role', (s) => (s.catalog.statuses[0].role = '')],
      ['no snapshot.builds', (s) => delete s.snapshot.builds],
      [
        '51 builds',
        (s) => (s.snapshot.builds = Array.from({ length: 51 }, (_, i) => build(b0(s), i))),
      ],
      ['two builds with the same runId', (s) => (s.snapshot.builds[1].runId = b0(s).runId)],
      ['runId: "abc"', (s) => (b0(s).runId = 'abc')],
      ['a build status that is not a catalog key', (s) => (b0(s).status = 'waiting')],
      ['designNumber: "14"', (s) => (b0(s).designNumber = '14')],
      ['an empty designName', (s) => (b0(s).designName = '')],
      ['a 121-char designName', (s) => (b0(s).designName = 'D'.repeat(121))],
      ['stages: []', (s) => (b0(s).stages = [])],
      ['11 stages', (s) => (b0(s).stages = Array.from({ length: 11 }, (_, i) => `Stage ${i}`))],
      ['a stage ""', (s) => (b0(s).stages[1] = '')],
      ['currentStage equal to stages.length', (s) => (b0(s).currentStage = b0(s).stages.length)],
      ['currentStage -1', (s) => (b0(s).currentStage = -1)],
      ['currentStage 1.5', (s) => (b0(s).currentStage = 1.5)],
      ['a 301-char reason', (s) => (b0(s).reason = 'r'.repeat(301))],
      ['pr.position: 0', (s) => (b0(s).pr.position = 0)],
      ['pr.position > total', (s) => (b0(s).pr.position = 4)],
      ['pr.number set with url: null', (s) => (b0(s).pr.url = null)],
      ['pr.url starting http://', (s) => (b0(s).pr.url = 'http://github.com/x/y/pull/1')],
      ['lastEventAt: "yesterday"', (s) => (b0(s).lastEventAt = 'yesterday')],
      [
        'lastEventAt in RFC 1123 form',
        (s) => (b0(s).lastEventAt = 'Thu, 01 Jan 1970 00:00:00 GMT'),
      ],
      ['lastEventAt on 30 February', (s) => (b0(s).lastEventAt = '2026-02-30T12:00:00Z')],
      ['lastEventAt in month 13', (s) => (b0(s).lastEventAt = '2026-13-21T17:32:10Z')],
      ['lastEventAt at hour 25', (s) => (b0(s).lastEventAt = '2026-11-21T25:32:10Z')],
      ['counts.done: -1', (s) => (s.snapshot.counts.done = -1)],
      ['no counts', (s) => delete s.snapshot.counts],
      ['no events', (s) => delete s.events],
      ['501 events', (s) => (s.events = Array.from({ length: 501 }, (_, i) => event(i)))],
      ['two events with the same id', (s) => s.events.push({ ...e0(s), type: 'again' })],
      ['an event id in upper case', (s) => (e0(s).id = e0(s).id.toUpperCase())],
      ['an event at 30 February', (s) => (e0(s).at = '2026-02-30T12:00:00Z')],
      ['an empty event type', (s) => (e0(s).type = '')],
      ['event pr: 0', (s) => (e0(s).pr = 0)],
      ['event details: []', (s) => (e0(s).details = [])],
      ['event details: null', (s) => (e0(s).details = null)],
      ['an event artifactId not in this body', (s) => (e0(s).artifactId = randomUUID())],
      ['no artifacts', (s) => delete s.artifacts],
      ['51 artifacts', (s) => (s.artifacts = Array.from({ length: 51 }, artifact))],
      ['two artifacts with the same id', (s) => s.artifacts.push({ ...a0(s) })],
      ['an artifact body that is a string', (s) => (a0(s).body = 'report')],
      ['an artifact body over 262,144 bytes', (s) => (a0(s).body = { text: 'x'.repeat(262144) })],
      [
        'an artifact body over the limit in UTF-8 bytes only',
        (s) => (a0(s).body = { text: 'é'.repeat(140000) }),
      ],
    ];

    for (const [name, mutate] of cases) {
      it(`rejects ${name} with 400 invalid_sync and stores nothing`, async () => {
        const { push, read, history } = makeApp();
        expect((await push(validSync())).status).to.equal(204);
        const first = await read();
        const stored = historyCopy(history);
        const body = validSync();
        mutate(body);
        const res = await push(body);
        expect(res.status).to.equal(400);
        expect(res.body).to.deep.equal({ error: 'invalid_sync' });
        const after = await read();
        expect(after.body.snapshot).to.deep.equal(first.body.snapshot);
        expect(after.body.receivedAt).to.equal(first.body.receivedAt);
        expect(historyCopy(history)).to.deep.equal(stored);
      });
    }

    it('rejects a body that is a JSON array with 400 invalid_sync', async () => {
      const { push } = makeApp();
      const res = await push([validSync()]);
      expect(res.status).to.equal(400);
      expect(res.body).to.deep.equal({ error: 'invalid_sync' });
    });
  });

  describe('accepted edge values', () => {
    it('accepts builds: []', async () => {
      const { push } = makeApp();
      const body = validSync();
      body.snapshot.builds = [];
      expect((await push(body)).status).to.equal(204);
    });

    it('accepts a role marge has no look for and returns it unchanged', async () => {
      const { push, read } = makeApp();
      const body = validSync();
      body.catalog.statuses.push({
        key: 'waiting',
        label: 'Waiting',
        shortLabel: 'Wait',
        role: 'waiting',
      });
      expect((await push(body)).status).to.equal(204);
      expect((await read()).body.catalog).to.deep.equal(body.catalog);
    });

    it('accepts two builds of the same repo and design with different runIds', async () => {
      const { push } = makeApp();
      const body = validSync();
      body.snapshot.builds[1].repo = body.snapshot.builds[0].repo;
      body.snapshot.builds[1].designNumber = body.snapshot.builds[0].designNumber;
      expect((await push(body)).status).to.equal(204);
    });

    it('accepts a microsecond lastEventAt and returns that exact string', async () => {
      const { push, read } = makeApp();
      const body = validSync();
      body.snapshot.builds[0].lastEventAt = '2026-11-21T17:32:10.123456Z';
      expect((await push(body)).status).to.equal(204);
      expect((await read()).body.snapshot.builds[0].lastEventAt).to.equal(
        '2026-11-21T17:32:10.123456Z',
      );
    });
  });

  describe('storage', () => {
    it('stores the latest state under factory:snapshot for 365 days', async () => {
      const kv = new MemoryKV();
      const puts: Array<[string, string, number]> = [];
      const put = kv.put.bind(kv);
      kv.put = async (key, val, ttl) => {
        puts.push([key, val, ttl]);
        await put(key, val, ttl);
      };
      const { push } = makeApp({ kv });
      expect((await push(validSync())).status).to.equal(204);
      expect(puts).to.have.length(1);
      expect(puts[0][0]).to.equal('factory:snapshot');
      expect(puts[0][2]).to.equal(31536000);
      const stored = JSON.parse(puts[0][1]);
      expect(Object.keys(stored).sort()).to.deep.equal(['catalog', 'receivedAt', 'snapshot']);
    });
  });

  describe('failed push, then resend', () => {
    it('answers 500 when the latest state fails to save, and a resend completes it', async () => {
      const kv = new MemoryKV();
      const put = kv.put.bind(kv);
      let failNext = false;
      kv.put = async (key, val, ttl) => {
        if (failNext) {
          failNext = false;
          throw new Error('database unreachable');
        }
        await put(key, val, ttl);
      };
      const { push, read, history } = makeApp({ kv });
      const a = validSync();
      const b = otherSync();
      expect((await push(a)).status).to.equal(204);

      failNext = true;
      const failed = await push(b);
      expect(failed.status).to.equal(500);
      expect(failed.body).to.deep.equal({ error: 'internal_error' });
      expect((await read()).body.snapshot).to.deep.equal(a.snapshot);
      expect(history.events.has(b.events[0].id)).to.equal(true);
      expect(history.artifacts.has(b.artifacts[0].id)).to.equal(true);

      expect((await push(b)).status).to.equal(204);
      expect((await read()).body.snapshot).to.deep.equal(b.snapshot);
      expect([...history.events.keys()].filter((id) => id === b.events[0].id)).to.have.length(1);
      expect([...history.artifacts.keys()].filter((id) => id === b.artifacts[0].id)).to.have.length(
        1,
      );
      expect(history.events.size).to.equal(2);
      expect(history.artifacts.size).to.equal(2);
    });
  });
});
