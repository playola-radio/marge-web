import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sequelize } from "sequelize";
import { getSequelize } from "../../db/index.js";
import { GitCache } from "./gitCache.js";
import type { GitHubSource } from "./github.js";
import { createGitHubSource } from "./githubSource.js";
import { createLlmClient } from "./llm/index.js";
import { PostgresStageCache } from "./pipeline/stageCache.js";
import { createExecutor, Runner, RunStore } from "./runner.js";

export { PIPELINE_VERSION, Runner } from "./runner.js";

export interface PrReviewer {
  runner: Runner;
  sequelize: Sequelize;
  github: GitHubSource;
}

export interface StartOptions {
  log?: (message: string) => void;
  /** Injected in tests; otherwise from DATABASE_URL. */
  sequelize?: Sequelize | null;
}

/**
 * Starts the generation runner when the reviewer can run: a database plus
 * LLM and GitHub App credentials (or their stand-ins — `PR_REVIEWER_LLM=fake`,
 * `PR_REVIEWER_GITHUB=fake`). Otherwise logs one line and returns null, and the
 * server boots exactly as before.
 */
export function startPrReviewer(
  env: NodeJS.ProcessEnv,
  options: StartOptions = {},
): PrReviewer | null {
  const log = options.log ?? ((m: string) => console.log(m));
  const sequelize =
    options.sequelize !== undefined
      ? options.sequelize
      : env.DATABASE_URL
        ? getSequelize()
        : null;
  const llm = createLlmClient(env);
  const github = createGitHubSource(env);

  const missing = [
    ...(sequelize ? [] : ["DATABASE_URL"]),
    ...(llm ? [] : ["ANTHROPIC_API_KEY"]),
    ...(github ? [] : ["GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY"]),
  ];
  if (!sequelize || !llm || !github) {
    log(`pr_reviewer_off missing ${missing.join(", ")}`);
    return null;
  }

  const concurrency = Number(env.PR_REVIEWER_WRITE_CONCURRENCY);
  const runner = new Runner({
    store: new RunStore(sequelize),
    execute: createExecutor({
      github,
      gitCache: new GitCache({
        root: join(tmpdir(), "marge-pr-reviewer"),
      }),
      llm,
      cache: new PostgresStageCache(sequelize),
      concurrency:
        Number.isInteger(concurrency) && concurrency > 0
          ? concurrency
          : undefined,
    }),
    log,
  });
  runner.start();
  log(`pr_reviewer_on model=${llm.model}`);
  return { runner, sequelize, github };
}
