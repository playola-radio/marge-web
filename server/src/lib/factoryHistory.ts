import { QueryTypes, type Sequelize } from 'sequelize';
import type { Config } from '../config.js';
import { getSequelize } from '../db/index.js';
import type { FactoryArtifact, FactoryEvent } from './factorySync.js';

/**
 * The factory machine's build history: every event and report it pushes, kept
 * once by id. An id already stored is skipped and the first copy stays, so a
 * resent push is always safe.
 */
export interface FactoryHistory {
  record(artifacts: FactoryArtifact[], events: FactoryEvent[]): Promise<void>;
}

export class MemoryFactoryHistory implements FactoryHistory {
  readonly artifacts = new Map<string, FactoryArtifact>();
  readonly events = new Map<string, FactoryEvent>();

  async record(artifacts: FactoryArtifact[], events: FactoryEvent[]): Promise<void> {
    for (const artifact of artifacts) {
      if (!this.artifacts.has(artifact.id)) this.artifacts.set(artifact.id, artifact);
    }
    for (const event of events) {
      if (!this.events.has(event.id)) this.events.set(event.id, event);
    }
  }
}

export class PostgresFactoryHistory implements FactoryHistory {
  constructor(private sequelize: Sequelize) {}

  async record(artifacts: FactoryArtifact[], events: FactoryEvent[]): Promise<void> {
    if (artifacts.length) {
      const rows = artifacts.map(({ id, kind, at, body }) => ({ id, kind, at, body }));
      await this.sequelize.query(
        `INSERT INTO factory_artifacts (id, kind, at, body)
         SELECT id, kind, at, body
         FROM jsonb_to_recordset($rows::jsonb) AS r(id uuid, kind text, at timestamptz, body jsonb)
         ON CONFLICT (id) DO NOTHING`,
        { bind: { rows: JSON.stringify(rows) }, type: QueryTypes.INSERT },
      );
    }
    if (events.length) {
      const rows = events.map((e) => ({
        id: e.id,
        run_id: e.runId,
        at: e.at,
        repo: e.repo,
        design: e.design,
        pr: e.pr,
        type: e.type,
        details: e.details,
        artifact_id: e.artifactId,
      }));
      await this.sequelize.query(
        `INSERT INTO factory_events (id, run_id, at, repo, design, pr, type, details, artifact_id)
         SELECT id, run_id, at, repo, design, pr, type, details, artifact_id
         FROM jsonb_to_recordset($rows::jsonb) AS r(
           id uuid, run_id uuid, at timestamptz, repo text, design text,
           pr integer, type text, details jsonb, artifact_id uuid
         )
         ON CONFLICT (id) DO NOTHING`,
        { bind: { rows: JSON.stringify(rows) }, type: QueryTypes.INSERT },
      );
    }
  }
}

export async function createFactoryHistory(config: Config): Promise<FactoryHistory> {
  if (config.kvBackend === 'memory') return new MemoryFactoryHistory();
  const sequelize = getSequelize();
  if (!sequelize) throw new Error('DATABASE_URL is required when KV_BACKEND=postgres');
  return new PostgresFactoryHistory(sequelize);
}
