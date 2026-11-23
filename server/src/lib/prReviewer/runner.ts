import { randomUUID } from "node:crypto";
import type { Sequelize, Transaction } from "sequelize";
import { extract } from "./extract.js";
import { GitCacheError, redact, type GitCache } from "./gitCache.js";
import type { GitHubApp } from "./github.js";
import type { LlmClient } from "./llm/LlmClient.js";
import {
  EmptyDiffError,
  generateChapters,
  StageFailure,
  type Assembled,
  type ChaptersDocument,
  type StageCache,
} from "./pipeline/index.js";

/**
 * The in-process job runner (D8). `pr_reviewer_runs` rows are the queue: a
 * worker claims a `queued` run (or a `generating` one whose lease expired) by
 * minting a fresh `lease_token` and bumping `attempt`. Every later write —
 * heartbeat, progress, failure, publish — is fenced on that token, so a
 * stalled worker whose run was reclaimed (or failed, retried and claimed
 * anew) can never overwrite the current claimant. `attempt` only bounds the
 * automatic retries; it is never a claim identity, since Retry resets it.
 */

/** Bumping this lets a reshaped pipeline regenerate without colliding with old runs. */
export const PIPELINE_VERSION = "1";
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_POLL_MS = 2_000;
/** An automatic retry waits this long, doubling per attempt, so a provider outage can pass. */
export const DEFAULT_RETRY_DELAY_MS = 15_000;

export interface PrMeta {
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  commits: number;
}

export interface RunRow {
  id: string;
  org: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  attempt: number;
  prMeta: PrMeta;
}

export interface Claim {
  run: RunRow;
  leaseToken: string;
}

export type RunStage = "fetch" | "extract" | "outline" | "write" | "summarize";

export type RunProgress =
  | { stage: Exclude<RunStage, "write"> }
  | { stage: "write"; completedChapters: number; totalChapters: number };

/** This worker's claim on the run is gone: it must stop without writing. */
export class LeaseLostError extends Error {
  constructor() {
    super("The run was reclaimed by another worker");
    this.name = "LeaseLostError";
  }
}

interface RunRecord {
  id: string;
  org: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  attempt: number;
  pr_meta: PrMeta;
  lease_token: string;
}

/** PostgreSQL's jsonb refuses NUL; a diff line can still carry one past git's binary check. */
function storable(document: ChaptersDocument): string {
  return JSON.stringify(document, (_key, v) =>
    typeof v === "string" ? v.replaceAll("\0", "\ufffd") : v,
  );
}

export class RunStore {
  constructor(
    private readonly sequelize: Sequelize,
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  ) {}

  private async rows<T>(
    sql: string,
    bind: Record<string, unknown>,
    transaction?: Transaction,
  ): Promise<T[]> {
    const [rows] = await this.sequelize.query(sql, { bind, transaction });
    return rows as T[];
  }

  /**
   * Claims the oldest runnable run within the attempt budget: mints a fresh
   * lease token, bumps `attempt` and starts the lease. A requeued run
   * (attempt > 0) waits out its backoff first.
   */
  async claimNext(maxAttempts: number): Promise<Claim | null> {
    const token = randomUUID();
    const [row] = await this.rows<RunRecord>(
      `UPDATE pr_reviewer_runs r
          SET status = 'generating', lease_token = $token,
              lease_expires_at = now() + $leaseMs * interval '1 millisecond',
              attempt = r.attempt + 1, progress = '{"stage":"fetch"}'::jsonb,
              failure = NULL, failure_detail = NULL, updated_at = now()
        WHERE r.id = (
          SELECT id FROM pr_reviewer_runs
           WHERE ((status = 'queued'
                   AND (attempt = 0
                        OR updated_at <= now() - $retryDelayMs
                           * power(2, attempt - 1) * interval '1 millisecond'))
                  OR (status = 'generating' AND lease_expires_at < now()))
             AND attempt < $maxAttempts
           ORDER BY created_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
       RETURNING r.*`,
      {
        token,
        leaseMs: this.leaseMs,
        retryDelayMs: this.retryDelayMs,
        maxAttempts,
      },
    );
    if (!row) return null;
    return {
      leaseToken: row.lease_token,
      run: {
        id: row.id,
        org: row.org,
        repo: row.repo,
        prNumber: row.pr_number,
        headSha: row.head_sha,
        baseSha: row.base_sha,
        attempt: row.attempt,
        prMeta: row.pr_meta,
      },
    };
  }

  /** Fails runs whose workers died on every attempt of their budget. */
  async failExhausted(maxAttempts: number): Promise<void> {
    await this.rows(
      `UPDATE pr_reviewer_runs
          SET status = 'failed',
              failure = 'Generation stopped before it finished, too many times',
              failure_detail = 'The generation worker stopped responding during '
                || attempt || ' attempts (last stage: '
                || coalesce(progress->>'stage', 'unknown') || ')',
              progress = NULL, lease_token = NULL, lease_expires_at = NULL,
              updated_at = now()
        WHERE attempt >= $maxAttempts
          AND (status = 'queued'
               OR (status = 'generating' AND lease_expires_at < now()))`,
      { maxAttempts },
    );
  }

  private async fenced(
    claim: Claim,
    set: string,
    bind: Record<string, unknown> = {},
    transaction?: Transaction,
  ): Promise<boolean> {
    const rows = await this.rows<{ id: string }>(
      `UPDATE pr_reviewer_runs SET ${set}, updated_at = now()
        WHERE id = $id AND lease_token = $token AND status = 'generating'
       RETURNING id`,
      { ...bind, id: claim.run.id, token: claim.leaseToken },
      transaction,
    );
    return rows.length === 1;
  }

  heartbeat(claim: Claim): Promise<boolean> {
    return this.fenced(
      claim,
      `lease_expires_at = now() + $leaseMs * interval '1 millisecond'`,
      { leaseMs: this.leaseMs },
    );
  }

  setProgress(claim: Claim, progress: RunProgress): Promise<boolean> {
    return this.fenced(claim, `progress = $progress::jsonb`, {
      progress: JSON.stringify(progress),
    });
  }

  /** Hands the run back to the queue for another automatic attempt. */
  requeue(claim: Claim): Promise<boolean> {
    return this.fenced(
      claim,
      `status = 'queued', progress = NULL, lease_token = NULL, lease_expires_at = NULL`,
    );
  }

  fail(claim: Claim, failure: string, detail: string): Promise<boolean> {
    return this.fenced(
      claim,
      `status = 'failed', failure = $failure, failure_detail = $detail,
       progress = NULL, lease_token = NULL, lease_expires_at = NULL`,
      { failure, detail },
    );
  }

  /**
   * In one transaction: the document, the markdown file rows, and `ready`.
   * A run is never `ready` without its complete document. False (and nothing
   * written) when the claim is no longer current.
   */
  async publish(claim: Claim, assembled: Assembled): Promise<boolean> {
    try {
      await this.sequelize.transaction(async (transaction) => {
        const current = await this.fenced(
          claim,
          `status = 'ready', progress = NULL, failure = NULL,
           failure_detail = NULL, lease_token = NULL, lease_expires_at = NULL`,
          {},
          transaction,
        );
        if (!current) throw new LeaseLostError();
        const runId = claim.run.id;
        await this.sequelize.query(
          `INSERT INTO pr_reviewer_documents (run_id, document, created_at)
           VALUES ($runId, $document::jsonb, now())`,
          {
            bind: { runId, document: storable(assembled.document) },
            transaction,
          },
        );
        if (assembled.markdownSources.length)
          await this.sequelize.query(
            `INSERT INTO pr_reviewer_run_files (run_id, path, text, created_at)
             SELECT $runId, path, text, now()
               FROM jsonb_to_recordset($files::jsonb) AS f(path text, text text)`,
            {
              bind: {
                runId,
                files: JSON.stringify(assembled.markdownSources),
              },
              transaction,
            },
          );
      });
      return true;
    } catch (err) {
      if (err instanceof LeaseLostError) return false;
      throw err;
    }
  }
}

export interface ExecuteContext {
  /** Records progress; throws LeaseLostError once the claim is gone. */
  progress(progress: RunProgress): Promise<void>;
}

/** Turns a claimed run into its assembled document. */
export type RunExecutor = (
  claim: Claim,
  ctx: ExecuteContext,
) => Promise<Assembled>;

const STAGE_WORDS: Record<RunStage | "assemble" | "publish", string> = {
  fetch: "fetching the repo",
  extract: "reading the diff",
  outline: "outlining",
  write: "writing chapters",
  summarize: "summarizing",
  assemble: "assembling the chapters",
  publish: "saving the chapters",
};

/** The plain-English failure line for the failed screen. */
export function failureLine(
  err: unknown,
  lastStage: RunStage | "publish",
): string {
  if (err instanceof EmptyDiffError)
    return "The pull request has no changes between its merge base and head";
  if (err instanceof StageFailure) {
    if (err.stage === "write" && err.chapterNumber)
      return `Generation failed while writing chapter ${err.chapterNumber}`;
    return `Generation failed while ${STAGE_WORDS[err.stage]}`;
  }
  return `Generation failed while ${STAGE_WORDS[lastStage]}`;
}

/** The underlying error, credential-redacted, for the collapsed detail. */
export function failureDetail(err: unknown): string {
  const cause = err instanceof StageFailure ? err.cause : err;
  const message =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return redact(message);
}

/** Errors another automatic attempt can't fix: fail at once. */
function permanent(err: unknown): boolean {
  const cause = err instanceof StageFailure ? err.cause : err;
  return cause instanceof EmptyDiffError || cause instanceof GitCacheError;
}

export interface RunnerOptions {
  store: RunStore;
  execute: RunExecutor;
  maxAttempts?: number;
  leaseMs?: number;
  log?: (message: string) => void;
}

export class Runner {
  private readonly store: RunStore;
  private readonly execute: RunExecutor;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private stopped = true;
  private wakeUp: (() => void) | null = null;

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.execute = options.execute;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.log = options.log ?? ((m) => console.log(m));
  }

  /** Claims and executes one run; false when nothing was runnable. */
  async runOnce(): Promise<boolean> {
    await this.store.failExhausted(this.maxAttempts);
    const claim = await this.store.claimNext(this.maxAttempts);
    if (!claim) return false;
    await this.executeClaim(claim);
    return true;
  }

  private async executeClaim(claim: Claim): Promise<void> {
    let lost = false;
    let lastStage: RunStage | "publish" = "fetch";
    const heartbeat = setInterval(
      () => {
        this.store
          .heartbeat(claim)
          .then((ok) => {
            if (!ok) lost = true;
          })
          .catch(() => undefined); // a missed beat only shortens the lease
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    );
    const ctx: ExecuteContext = {
      progress: async (progress) => {
        if (lost) throw new LeaseLostError();
        lastStage = progress.stage;
        if (!(await this.store.setProgress(claim, progress))) {
          lost = true;
          throw new LeaseLostError();
        }
      },
    };
    try {
      const assembled = await this.execute(claim, ctx);
      if (lost) throw new LeaseLostError();
      lastStage = "publish";
      if (!(await this.store.publish(claim, assembled)))
        throw new LeaseLostError();
    } catch (err) {
      if (err instanceof LeaseLostError) {
        this.log(`pr_reviewer_run_lease_lost ${claim.run.id}`);
        return;
      }
      const exhausted = claim.run.attempt >= this.maxAttempts;
      const wrote =
        exhausted || permanent(err)
          ? await this.store.fail(
              claim,
              failureLine(err, lastStage),
              failureDetail(err),
            )
          : await this.store.requeue(claim);
      this.log(
        `pr_reviewer_run_${exhausted || permanent(err) ? "failed" : "retrying"} ${claim.run.id}` +
          (wrote ? "" : " (claim lost)"),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Polls for runs until stopped. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        let worked = false;
        try {
          worked = await this.runOnce();
        } catch (err) {
          this.log(
            `pr_reviewer_runner_error ${(err as Error)?.message ?? err}`,
          );
        }
        if (!worked && !this.stopped)
          await new Promise<void>((resolve) => {
            this.wakeUp = resolve;
            this.timer = setTimeout(resolve, DEFAULT_POLL_MS);
          });
      }
    })();
  }

  /** Checks the queue now instead of at the next poll (a run was just enqueued). */
  wake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.wakeUp?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake();
    await this.loop;
  }
}

export interface ExecutorDeps {
  github: Pick<
    GitHubApp,
    "installationToken" | "repoSizeKb" | "compareCommits"
  >;
  gitCache: GitCache;
  llm: LlmClient;
  cache: StageCache;
  /** WriteChapter calls in flight per run (default 3). */
  concurrency?: number;
  /** The HTTPS clone URL; tests point it at a fixture. */
  remoteUrl?: (org: string, repo: string) => string;
}

/**
 * The real executor: fetch the pinned revision into the git cache, extract
 * (capturing markdown sources while the directory is pinned), release the
 * cache, then run the LLM pipeline. Nothing after extraction reads git.
 */
export function createExecutor(deps: ExecutorDeps): RunExecutor {
  const remoteUrl =
    deps.remoteUrl ??
    ((org: string, repo: string) => `https://github.com/${org}/${repo}.git`);
  return async ({ run }, ctx) => {
    const { org, repo, headSha, baseSha } = run;
    const token = () => deps.github.installationToken(org, repo);
    await ctx.progress({ stage: "fetch" });
    const lease = await deps.gitCache.checkout({
      org,
      repo,
      prNumber: run.prNumber,
      headSha,
      baseSha,
      remoteUrl: remoteUrl(org, repo),
      token,
      repoSizeKb: () => deps.github.repoSizeKb(org, repo),
      prCommits: () => deps.github.compareCommits(org, repo, baseSha, headSha),
    });
    let extracted;
    try {
      await ctx.progress({ stage: "extract" });
      extracted = await lease.withSizeCap((signal) =>
        extract({
          git: deps.gitCache.git,
          gitDir: lease.dir,
          baseSha,
          headSha,
          baseRef: run.prMeta.baseRef,
          branch: run.prMeta.headRef,
          repo,
          auth: token,
          signal,
        }),
      );
    } finally {
      lease.release();
    }
    return generateChapters({
      extract: extracted,
      llm: deps.llm,
      cache: deps.cache,
      concurrency: deps.concurrency,
      pr: {
        number: run.prNumber,
        title: run.prMeta.title,
        url: run.prMeta.url,
        host: "github.com",
        owner: org,
        repo,
      },
      onProgress: (p) => ctx.progress(p),
    });
  };
}
