import type { Request, RequestHandler } from "express";
import { QueryTypes, type Sequelize } from "sequelize";
import type { AppDeps } from "../../app.js";
import { GitHubError, type GitHubSource } from "../../lib/prReviewer/github.js";
import { PIPELINE_VERSION, type PrMeta } from "../../lib/prReviewer/runner.js";
import type { AuthedRequest } from "../middleware/security.js";

/**
 * The /v1/pr-reviewer endpoints (ApiContract.md). Runs are created here and
 * picked up by the in-process runner; every read is served from Postgres, so
 * chapters stay readable after redeploys and git-cache eviction.
 */

export interface PrReviewerDeps {
  sequelize: Sequelize;
  github: Pick<GitHubSource, "resolvePullRequest">;
  /** Tells the runner a run was just enqueued, so it checks now instead of at its next poll. */
  wake: () => void;
}

interface RunRecord {
  id: string;
  org: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  pipeline_version: string;
  status: string;
  progress: unknown;
  failure: string | null;
  failure_detail: string | null;
  pr_meta: PrMeta;
  created_at: Date | string;
  updated_at: Date | string;
}

/** The `run` JSON every endpoint that returns a run shares. */
function runJson(r: RunRecord) {
  return {
    id: r.id,
    org: r.org,
    repo: r.repo,
    prNumber: r.pr_number,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    pipelineVersion: r.pipeline_version,
    status: r.status,
    progress: r.progress ?? null,
    failure: r.failure ?? null,
    failureDetail: r.failure_detail ?? null,
    pr: r.pr_meta,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Handler = (
  deps: PrReviewerDeps,
  ...args: Parameters<RequestHandler>
) => Promise<void>;

/** Every route answers 503 when the reviewer is not configured. */
function route(deps: AppDeps, handler: Handler): RequestHandler {
  return async (req, res, next) => {
    const reviewer = deps.prReviewer;
    if (!reviewer) {
      res.status(503).json({ error: "pr_reviewer_unavailable" });
      return;
    }
    try {
      await handler(reviewer, req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

async function select<T extends object>(
  sequelize: Sequelize,
  sql: string,
  bind: Record<string, unknown>,
): Promise<T[]> {
  return sequelize.query<T>(sql, { bind, type: QueryTypes.SELECT });
}

/** The path's PR, normalized: GitHub names are case-insensitive, so runs are keyed lowercase. */
function prPath(req: Request) {
  const prNumber = Number(req.params.prNumber);
  return {
    org: String(req.params.org).toLowerCase(),
    repo: String(req.params.repo).toLowerCase(),
    prNumber:
      /^\d+$/.test(String(req.params.prNumber)) &&
      Number.isSafeInteger(prNumber) &&
      prNumber > 0 &&
      prNumber <= 2_147_483_647
        ? prNumber
        : null,
  };
}

/** Resolves the PR on GitHub; null (after answering 404) when there is no such open PR. */
async function resolve(
  deps: PrReviewerDeps,
  req: Request,
  res: Parameters<RequestHandler>[1],
) {
  const { org, repo, prNumber } = prPath(req);
  if (prNumber === null) {
    res.status(404).json({ error: "pr_not_found" });
    return null;
  }
  try {
    const pr = await deps.github.resolvePullRequest(org, repo, prNumber);
    return { org, repo, prNumber, pr };
  } catch (err) {
    if (err instanceof GitHubError && err.code === "pr_not_found") {
      res.status(404).json({ error: "pr_not_found" });
      return null;
    }
    throw err;
  }
}

async function findRun(
  sequelize: Sequelize,
  runId: unknown,
): Promise<RunRecord | null> {
  if (typeof runId !== "string" || !UUID.test(runId)) return null;
  const [row] = await select<RunRecord>(
    sequelize,
    `SELECT * FROM pr_reviewer_runs WHERE id = $runId`,
    { runId },
  );
  return row ?? null;
}

function userEmail(req: Request): string | null {
  const auth = (req as AuthedRequest).auth;
  const email =
    auth && typeof auth === "object"
      ? (auth as { email?: unknown }).email
      : undefined;
  return typeof email === "string" && email ? email : null;
}

/** GET /:org/:repo/pulls/:prNumber/runs/latest — the freshness check; read-only. */
export function latest(deps: AppDeps): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const resolved = await resolve(reviewer, req, res);
    if (!resolved) return;
    const { org, repo, prNumber, pr } = resolved;
    const runs = await select<RunRecord>(
      reviewer.sequelize,
      `SELECT * FROM pr_reviewer_runs
        WHERE org = $org AND repo = $repo AND pr_number = $prNumber
        ORDER BY created_at DESC, id DESC`,
      { org, repo, prNumber },
    );
    const newest = runs[0] ?? null;
    const run = runs.find((r) => r.status === "ready") ?? newest;
    res.json({
      pr: {
        title: pr.title,
        url: pr.url,
        baseRef: pr.baseRef,
        headRef: pr.headRef,
        commits: pr.commits,
        currentHeadSha: pr.headSha,
        currentBaseSha: pr.baseSha,
        author: pr.author,
        body: pr.body,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changedFiles,
        files: pr.files,
      },
      run: run ? runJson(run) : null,
      ...(newest && run && newest.id !== run.id
        ? { newerRun: runJson(newest) }
        : {}),
    });
  });
}

/**
 * POST /:org/:repo/pulls/:prNumber/runs — find or create the run for the PR's
 * current revision. Atomic on the revision's unique key: concurrent first
 * visits converge on one row and one enqueue.
 */
export function create(deps: AppDeps): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const resolved = await resolve(reviewer, req, res);
    if (!resolved) return;
    const { org, repo, prNumber, pr } = resolved;
    if (!pr.hasNetDiff) {
      res.status(422).json({ error: "empty_diff" });
      return;
    }
    const key = {
      org,
      repo,
      prNumber,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      version: PIPELINE_VERSION,
    };
    const prMeta: PrMeta = {
      title: pr.title,
      url: pr.url,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      commits: pr.commits,
    };
    const [inserted] = await select<RunRecord>(
      reviewer.sequelize,
      `INSERT INTO pr_reviewer_runs
         (org, repo, pr_number, head_sha, base_sha, pipeline_version, status,
          pr_meta, created_at, updated_at)
       VALUES ($org, $repo, $prNumber, $headSha, $baseSha, $version, 'queued',
               $prMeta::jsonb, now(), now())
       ON CONFLICT (org, repo, pr_number, head_sha, base_sha, pipeline_version)
       DO NOTHING
       RETURNING *`,
      { ...key, prMeta: JSON.stringify(prMeta) },
    );
    if (inserted) {
      reviewer.wake();
      res.status(201).json({ run: runJson(inserted) });
      return;
    }
    const [existing] = await select<RunRecord>(
      reviewer.sequelize,
      `SELECT * FROM pr_reviewer_runs
        WHERE org = $org AND repo = $repo AND pr_number = $prNumber
          AND head_sha = $headSha AND base_sha = $baseSha
          AND pipeline_version = $version`,
      key,
    );
    if (!existing) throw new Error("The conflicting run could not be read");
    res.status(200).json({ run: runJson(existing) });
  });
}

/** GET /runs/:runId — poll. */
export function poll(deps: AppDeps): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const run = await findRun(reviewer.sequelize, req.params.runId);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    res.json({ run: runJson(run) });
  });
}

/** POST /runs/:runId/retry — re-enqueue this failed run's pinned revision. */
export function retry(deps: AppDeps): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const runId = req.params.runId;
    const [updated] =
      typeof runId === "string" && UUID.test(runId)
        ? await select<RunRecord>(
            reviewer.sequelize,
            `UPDATE pr_reviewer_runs
                SET status = 'queued', attempt = 0, failure = NULL,
                    failure_detail = NULL, progress = NULL, lease_token = NULL,
                    lease_expires_at = NULL, updated_at = now()
              WHERE id = $runId AND status = 'failed'
             RETURNING *`,
            { runId },
          )
        : [];
    if (updated) {
      reviewer.wake();
      res.json({ run: runJson(updated) });
      return;
    }
    const run = await findRun(reviewer.sequelize, runId);
    if (!run) res.status(404).json({ error: "run_not_found" });
    else res.status(409).json({ error: "run_not_failed" });
  });
}

/** GET /runs/:runId/chapters — the stored document, verbatim, plus the caller's marks. */
export function chapters(deps: AppDeps): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const run = await findRun(reviewer.sequelize, req.params.runId);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    if (run.status !== "ready") {
      res.status(409).json({ error: "run_not_ready", run: runJson(run) });
      return;
    }
    const [doc] = await select<{ document: unknown }>(
      reviewer.sequelize,
      `SELECT document FROM pr_reviewer_documents WHERE run_id = $runId`,
      { runId: run.id },
    );
    if (!doc) throw new Error(`Ready run ${run.id} has no document`);
    const marks = await select<{ chapter_key: string }>(
      reviewer.sequelize,
      `SELECT chapter_key FROM pr_reviewer_chapter_reviews
        WHERE run_id = $runId AND user_email = $email`,
      { runId: run.id, email: userEmail(req) ?? "" },
    );
    res.json({
      run: runJson(run),
      document: doc.document,
      reviewed: marks.map((m) => m.chapter_key),
    });
  });
}

/** GET /runs/:runId/files?path= — a changed markdown file's full text at the pinned head. */
export function file(deps: AppDeps): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const run = await findRun(reviewer.sequelize, req.params.runId);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    const path = req.query.path;
    const [row] =
      typeof path === "string" && path
        ? await select<{ path: string; text: string }>(
            reviewer.sequelize,
            `SELECT path, text FROM pr_reviewer_run_files
              WHERE run_id = $runId AND path = $path`,
            { runId: run.id, path },
          )
        : [];
    if (!row) {
      res.status(404).json({ error: "file_not_available" });
      return;
    }
    res.json({ path: row.path, text: row.text });
  });
}

/** PUT / DELETE /runs/:runId/chapters/:chapterKey/reviewed — idempotent, per user. */
export function reviewed(deps: AppDeps, mark: boolean): RequestHandler {
  return route(deps, async (reviewer, req, res) => {
    const email = userEmail(req);
    if (!email) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const run = await findRun(reviewer.sequelize, req.params.runId);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    const chapterKey = String(req.params.chapterKey);
    const [known] = await select<{ run_id: string }>(
      reviewer.sequelize,
      `SELECT run_id FROM pr_reviewer_documents
        WHERE run_id = $runId
          AND document->'chapters' @> jsonb_build_array(jsonb_build_object('key', $chapterKey::text))`,
      { runId: run.id, chapterKey },
    );
    if (!known) {
      res.status(404).json({ error: "chapter_not_found" });
      return;
    }
    await reviewer.sequelize.query(
      mark
        ? `INSERT INTO pr_reviewer_chapter_reviews
             (run_id, chapter_key, user_email, created_at)
           VALUES ($runId, $chapterKey, $email, now())
           ON CONFLICT DO NOTHING`
        : `DELETE FROM pr_reviewer_chapter_reviews
            WHERE run_id = $runId AND chapter_key = $chapterKey
              AND user_email = $email`,
      { bind: { runId: run.id, chapterKey, email } },
    );
    res.status(204).end();
  });
}
