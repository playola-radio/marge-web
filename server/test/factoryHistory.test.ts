import { expect } from 'chai';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { QueryTypes, Sequelize } from 'sequelize';
import { MemoryFactoryHistory, PostgresFactoryHistory } from '../src/lib/factoryHistory.js';
import type { FactoryArtifact, FactoryEvent } from '../src/lib/factorySync.js';

const require = createRequire(import.meta.url);
const migration = require('../src/db/migrations/20261122000000-factory-history.cjs') as {
  up: (qi: unknown, S: typeof Sequelize) => Promise<void>;
};

const artifact = (over: Partial<FactoryArtifact> = {}): FactoryArtifact => ({
  id: '0969de36-50de-4b61-9340-408a40d162ae',
  kind: 'pr_report',
  at: '2026-11-21T18:34:04.801Z',
  body: { implementation: { summary: 'built it' }, gate: {}, pullRequest: {}, review: {} },
  ...over,
});

const event = (over: Partial<FactoryEvent> = {}): FactoryEvent => ({
  id: '0d841412-1ae9-4af5-9c3d-a2e58a6099f0',
  runId: '98093cbb-16c0-43a9-b026-cc9b1d91c47a',
  at: '2026-11-21T18:34:04.801Z',
  repo: 'playola-radio/playola',
  design: '014-recorded-shows',
  pr: 2,
  type: 'pr waiting on owner',
  details: { number: 812, url: 'https://github.com/playola-radio/playola/pull/812' },
  artifactId: '0969de36-50de-4b61-9340-408a40d162ae',
  ...over,
});

describe('MemoryFactoryHistory', () => {
  it('keeps the first copy of an id it already has', async () => {
    const history = new MemoryFactoryHistory();
    await history.record([artifact()], [event()]);
    await history.record([artifact({ kind: 'other' })], [event({ type: 'changed' })]);
    expect(history.artifacts.size).to.equal(1);
    expect(history.events.size).to.equal(1);
    expect(history.artifacts.get(artifact().id)?.kind).to.equal('pr_report');
    expect(history.events.get(event().id)?.type).to.equal('pr waiting on owner');
  });
});

// Runs only when DATABASE_URL is set (e.g. against the compose Postgres):
//   DATABASE_URL=postgres://postgres:pass@127.0.0.1:5432/margedev npm test
// It builds the tables in a throwaway schema, so the real tables and the
// migration records are never touched.
const dbUrl = process.env.DATABASE_URL;
(dbUrl ? describe : describe.skip)('PostgresFactoryHistory', () => {
  const schema = `factory_history_test_${randomBytes(6).toString('hex')}`;
  let admin: Sequelize;
  let sequelize: Sequelize;
  const statements: string[] = [];

  before(async () => {
    admin = new Sequelize(dbUrl as string, { dialect: 'postgres', logging: false });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    sequelize = new Sequelize(dbUrl as string, {
      dialect: 'postgres',
      logging: (sql: string) => {
        statements.push(sql);
      },
      dialectOptions: { options: `-c search_path=${schema}` },
    });
    await migration.up(sequelize.getQueryInterface(), Sequelize);
  });

  after(async () => {
    await sequelize.close();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.close();
  });

  const selectAll = async () => {
    const artifacts = await sequelize.query(
      `SELECT id, kind, at, body FROM factory_artifacts ORDER BY id`,
      { type: QueryTypes.SELECT },
    );
    const events = await sequelize.query(
      `SELECT id, run_id, at, repo, design, pr, type, details, artifact_id FROM factory_events ORDER BY id`,
      { type: QueryTypes.SELECT },
    );
    return { artifacts, events } as {
      artifacts: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };
  };

  it('stores an artifact and an event that points to it, every column as sent', async () => {
    const history = new PostgresFactoryHistory(sequelize);
    await history.record([artifact()], [event()]);
    const { artifacts, events } = await selectAll();
    expect(artifacts).to.have.length(1);
    expect(artifacts[0].id).to.equal(artifact().id);
    expect(artifacts[0].kind).to.equal('pr_report');
    expect((artifacts[0].at as Date).toISOString()).to.equal('2026-11-21T18:34:04.801Z');
    expect(artifacts[0].body).to.deep.equal(artifact().body);
    expect(events).to.have.length(1);
    expect(events[0]).to.deep.include({
      id: event().id,
      run_id: event().runId,
      repo: 'playola-radio/playola',
      design: '014-recorded-shows',
      pr: 2,
      type: 'pr waiting on owner',
      artifact_id: artifact().id,
    });
    expect(events[0].details).to.deep.equal(event().details);
    expect((events[0].at as Date).toISOString()).to.equal('2026-11-21T18:34:04.801Z');
  });

  it('stores an event with null pr and artifactId and empty details', async () => {
    const history = new PostgresFactoryHistory(sequelize);
    const id = '1d841412-1ae9-4af5-9c3d-a2e58a6099f0';
    await history.record([], [event({ id, pr: null, artifactId: null, details: {} })]);
    const { events } = await selectAll();
    const row = events.find((e) => e.id === id);
    expect(row).to.deep.include({ pr: null, artifact_id: null });
    expect(row?.details).to.deep.equal({});
  });

  it('keeps one row each and the first content when the same ids are recorded again', async () => {
    const history = new PostgresFactoryHistory(sequelize);
    await history.record(
      [artifact({ kind: 'changed', body: { other: true } })],
      [event({ type: 'changed', repo: 'other/repo' })],
    );
    const { artifacts, events } = await selectAll();
    expect(artifacts).to.have.length(1);
    expect(artifacts[0].kind).to.equal('pr_report');
    expect(artifacts[0].body).to.deep.equal(artifact().body);
    const row = events.find((e) => e.id === event().id);
    expect(row?.type).to.equal('pr waiting on owner');
    expect(row?.repo).to.equal('playola-radio/playola');
    expect(events.filter((e) => e.id === event().id)).to.have.length(1);
  });

  it('stores strings PostgreSQL cannot hold, with U+FFFD in place of NUL and lone surrogates', async () => {
    const history = new PostgresFactoryHistory(sequelize);
    const artifactId = '2969de36-50de-4b61-9340-408a40d162ae';
    const eventId = '2d841412-1ae9-4af5-9c3d-a2e58a6099f0';
    await history.record(
      [artifact({ id: artifactId, body: { text: 'a\u0000b\ud800c', ['k\u0000']: ['\udc00'] } })],
      [event({ id: eventId, type: 'x\u0000', details: { note: '\u0000' }, artifactId })],
    );
    const { artifacts, events } = await selectAll();
    expect(artifacts.find((a) => a.id === artifactId)?.body).to.deep.equal({
      text: 'a\ufffdb\ufffdc',
      ['k\ufffd']: ['\ufffd'],
    });
    const row = events.find((e) => e.id === eventId);
    expect(row?.type).to.equal('x\ufffd');
    expect(row?.details).to.deep.equal({ note: '\ufffd' });
  });

  it('runs no statement for record([], [])', async () => {
    const history = new PostgresFactoryHistory(sequelize);
    statements.length = 0;
    await history.record([], []);
    expect(statements).to.deep.equal([]);
  });
});
