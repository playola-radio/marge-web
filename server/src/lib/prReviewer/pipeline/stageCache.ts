import { QueryTypes, type Sequelize } from "sequelize";
import type { LlmStage } from "../llm/LlmClient.js";
import type { StageCache, StageCacheEntry } from "./stage.js";

/**
 * JSON for a jsonb column. PostgreSQL's jsonb refuses NUL, and a diff line (or
 * an LLM answer quoting one) can still carry it past git's binary check.
 */
export function storable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "string" ? v.replaceAll("\0", "\ufffd") : v,
  );
}

/**
 * The stage cache in `pr_reviewer_stage_outputs`: content-addressed, shared by
 * every attempt and run. Each row stores `{ output, fallbackUsed }` so a hit
 * restores the result and its fallback provenance.
 */
export class PostgresStageCache implements StageCache {
  constructor(private readonly sequelize: Sequelize) {}

  async get(key: string): Promise<StageCacheEntry | null> {
    const rows = await this.sequelize.query<{ output: StageCacheEntry }>(
      `SELECT output FROM pr_reviewer_stage_outputs WHERE cache_key = $key`,
      { bind: { key }, type: QueryTypes.SELECT },
    );
    const row = rows[0]?.output;
    return row
      ? { output: row.output, fallbackUsed: row.fallbackUsed === true }
      : null;
  }

  async put(key: string, stage: LlmStage, entry: StageCacheEntry) {
    await this.sequelize.query(
      `INSERT INTO pr_reviewer_stage_outputs (cache_key, stage, output, created_at)
       VALUES ($key, $stage, $output::jsonb, now())
       ON CONFLICT (cache_key) DO NOTHING`,
      {
        bind: {
          key,
          stage,
          output: storable({
            output: entry.output,
            fallbackUsed: entry.fallbackUsed,
          }),
        },
        type: QueryTypes.INSERT,
      },
    );
  }
}
