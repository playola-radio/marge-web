import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assert } from "chai";
import jwt from "jsonwebtoken";
import request from "supertest";
import { QueryTypes, Sequelize } from "sequelize";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../lib/config/index.js";
import { MemoryFactoryHistory } from "../../lib/factoryHistory/index.js";
import { MemoryKV } from "../../lib/kv/index.js";
import {
  GitHubError,
  type PullRequestInfo,
} from "../../lib/prReviewer/github.js";
import { chaptersDocumentSchema } from "../../lib/prReviewer/pipeline/index.js";
import { PIPELINE_VERSION } from "../../lib/prReviewer/runner.js";
import type { PrReviewerDeps } from "./prReviewer.api.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SECRET = "test-secret";

/**
 * The schema-valid chapters document the client tests render too: two
 * chapters, a markdown file, and an excluded lockfile run.
 */
const fixtureDocument: Json = JSON.parse(
  readFileSync(
    new URL("./fixtures/chaptersDocument.json", import.meta.url),
    "utf8",
  ),
);

const token = (email = "reader@playola.fm") =>
  jwt.sign({ email, name: "Reader" }, SECRET, { algorithm: "HS256" });

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "c".repeat(40);

function prInfo(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    title: "Fix flaky tests by cutting slow git setup work",
    url: "https://github.com/playola-radio/playola/pull/123",
    baseRef: "main",
    headRef: "brian-keane/chapters-flaky-test-fix",
    headSha: HEAD_A,
    baseSha: BASE,
    commits: 3,
    hasNetDiff: true,
    ...overrides,
  };
}

/** GitHub stand-in: PRs keyed by lowercase `org/repo#n`; anything else is not found. */
class FakeGitHub {
  readonly prs = new Map<string, PullRequestInfo>();
  calls = 0;
  /** When set, every resolution waits on it (to line concurrent requests up). */
  gate: Promise<void> | null = null;
  onCall: (() => void) | null = null;

  set(org: string, repo: string, n: number, info: PullRequestInfo) {
    this.prs.set(`${org}/${repo}#${n}`.toLowerCase(), info);
  }

  async resolvePullRequest(
    org: string,
    repo: string,
    n: number,
  ): Promise<PullRequestInfo> {
    this.calls += 1;
    this.onCall?.();
    if (this.gate) await this.gate;
    const info = this.prs.get(`${org}/${repo}#${n}`.toLowerCase());
    if (!info) throw new GitHubError("pr_not_found", "not found", 404);
    return info;
  }
}

function makeApp(prReviewer: PrReviewerDeps | null) {
  return buildApp({
    kv: new MemoryKV(),
    factoryHistory: new MemoryFactoryHistory(),
    config: loadConfig({
      BASE_URL: "http://localhost",
      KV_BACKEND: "memory",
      JWT_SECRET: SECRET,
    } as NodeJS.ProcessEnv),
    prReviewer,
  });
}

const prevSecret = process.env.JWT_SECRET;
function useSecret() {
  before(() => {
    process.env.JWT_SECRET = SECRET;
  });
  after(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });
}

const RUN_ID = "0d4f8a1e-6c2b-4b4e-9a1a-2f6f1f1f9b3c";
const ROUTES: [string, string][] = [
  ["get", "/v1/pr-reviewer/playola-radio/playola/pulls/123/runs/latest"],
  ["post", "/v1/pr-reviewer/playola-radio/playola/pulls/123/runs"],
  ["get", `/v1/pr-reviewer/runs/${RUN_ID}`],
  ["post", `/v1/pr-reviewer/runs/${RUN_ID}/retry`],
  ["get", `/v1/pr-reviewer/runs/${RUN_ID}/chapters`],
  ["get", `/v1/pr-reviewer/runs/${RUN_ID}/files?path=README.md`],
  ["put", `/v1/pr-reviewer/runs/${RUN_ID}/chapters/setup-timeouts/reviewed`],
  ["delete", `/v1/pr-reviewer/runs/${RUN_ID}/chapters/setup-timeouts/reviewed`],
];

function call(app: ReturnType<typeof makeApp>, method: string, path: string) {
  const agent = request(app) as unknown as Record<
    string,
    (p: string) => request.Test
  >;
  return agent[method](path);
}

describe("/v1/pr-reviewer without the reviewer configured", () => {
  useSecret();

  it("the fixture document is schema-valid", () => {
    chaptersDocumentSchema.parse(fixtureDocument);
  });

  for (const [method, path] of ROUTES) {
    it(`${method.toUpperCase()} ${path} answers 401 without a token`, async () => {
      const res = await call(makeApp(null), method, path);
      assert.equal(res.status, 401);
    });

    it(`${method.toUpperCase()} ${path} answers 503 pr_reviewer_unavailable`, async () => {
      const res = await call(makeApp(null), method, path).set(
        "Authorization",
        `Bearer ${token()}`,
      );
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, { error: "pr_reviewer_unavailable" });
    });
  }
});

// Runs only when DATABASE_URL is set, against the migrated database:
//   DATABASE_URL=postgres://postgres:pass@127.0.0.1:5432/margedev npm test
// Every row it writes belongs to an org named test-api-*, deleted after each
// test (documents, files and reviews cascade). It starts no runner.
const dbUrl = process.env.DATABASE_URL;

(dbUrl ? describe : describe.skip)("/v1/pr-reviewer", function () {
  this.timeout(20_000);
  useSecret();
  let sequelize: Sequelize;
  let github: FakeGitHub;
  let wakes: number;
  let app: ReturnType<typeof makeApp>;
  let org: string;
  const repo = "playola";
  const prNumber = 123;
  const auth = () => `Bearer ${token()}`;
  const prBase = () => `/v1/pr-reviewer/${org}/${repo}/pulls/${prNumber}`;

  before(() => {
    sequelize = new Sequelize(dbUrl as string, {
      dialect: "postgres",
      logging: false,
    });
  });
  beforeEach(() => {
    org = `test-api-${randomBytes(6).toString("hex")}`;
    github = new FakeGitHub();
    github.set(org, repo, prNumber, prInfo());
    wakes = 0;
    app = makeApp({
      sequelize,
      github,
      wake: () => {
        wakes += 1;
      },
    });
  });
  afterEach(async () => {
    await sequelize.query(`DELETE FROM pr_reviewer_runs WHERE org = $org`, {
      bind: { org },
    });
  });
  after(() => sequelize.close());

  const runRows = () =>
    sequelize.query<Json>(
      `SELECT * FROM pr_reviewer_runs WHERE org = $org ORDER BY created_at`,
      { bind: { org }, type: QueryTypes.SELECT },
    );

  /** A run row as the runner would leave it; ready runs get the fixture document. */
  async function insertRun(
    opts: {
      status?: string;
      headSha?: string;
      ageSeconds?: number;
      failure?: string;
      attempt?: number;
      files?: { path: string; text: string }[];
    } = {},
  ): Promise<string> {
    const status = opts.status ?? "ready";
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO pr_reviewer_runs
         (org, repo, pr_number, head_sha, base_sha, pipeline_version, status,
          progress, failure, failure_detail, attempt, pr_meta, created_at,
          updated_at)
       VALUES ($org, $repo, $pr, $head, $base, $version, $status,
               $progress::jsonb, $failure, $detail, $attempt, $meta::jsonb,
               now() - $age * interval '1 second',
               now() - $age * interval '1 second')
       RETURNING id`,
      {
        bind: {
          org,
          repo,
          pr: prNumber,
          head: opts.headSha ?? HEAD_A,
          base: BASE,
          version: PIPELINE_VERSION,
          status,
          progress:
            status === "generating"
              ? JSON.stringify({
                  stage: "write",
                  completedChapters: 1,
                  totalChapters: 2,
                })
              : null,
          failure: status === "failed" ? (opts.failure ?? "Failed") : null,
          detail: status === "failed" ? "Error: boom" : null,
          attempt: opts.attempt ?? 1,
          meta: JSON.stringify({
            title: "Fix flaky tests by cutting slow git setup work",
            url: "https://github.com/playola-radio/playola/pull/123",
            baseRef: "main",
            headRef: "brian-keane/chapters-flaky-test-fix",
            commits: 3,
          }),
          age: opts.ageSeconds ?? 60,
        },
        type: QueryTypes.SELECT,
      },
    );
    if (status === "ready") {
      await sequelize.query(
        `INSERT INTO pr_reviewer_documents (run_id, document, created_at)
         VALUES ($id, $doc::jsonb, now())`,
        { bind: { id: row.id, doc: JSON.stringify(fixtureDocument) } },
      );
      for (const f of opts.files ?? [])
        await sequelize.query(
          `INSERT INTO pr_reviewer_run_files (run_id, path, text, created_at)
           VALUES ($id, $path, $text, now())`,
          { bind: { id: row.id, ...f } },
        );
    }
    return row.id;
  }

  function assertRunShape(run: Json) {
    assert.hasAllKeys(run, [
      "id",
      "org",
      "repo",
      "prNumber",
      "headSha",
      "baseSha",
      "pipelineVersion",
      "status",
      "progress",
      "failure",
      "failureDetail",
      "pr",
      "createdAt",
      "updatedAt",
    ]);
    assert.include(["queued", "generating", "ready", "failed"], run.status);
    assert.deepEqual(run.pr, {
      title: "Fix flaky tests by cutting slow git setup work",
      url: "https://github.com/playola-radio/playola/pull/123",
      baseRef: "main",
      headRef: "brian-keane/chapters-flaky-test-fix",
      commits: 3,
    });
    assert.equal(new Date(run.createdAt).toISOString(), run.createdAt);
    assert.equal(new Date(run.updatedAt).toISOString(), run.updatedAt);
  }

  describe("POST runs (find or create)", () => {
    it("creates a queued run for the current revision and enqueues it once (201)", async () => {
      const res = await request(app)
        .post(`${prBase()}/runs`)
        .set("Authorization", auth());
      assert.equal(res.status, 201);
      assertRunShape(res.body.run);
      assert.include(res.body.run, {
        org,
        repo,
        prNumber,
        headSha: HEAD_A,
        baseSha: BASE,
        pipelineVersion: PIPELINE_VERSION,
        status: "queued",
        progress: null,
        failure: null,
        failureDetail: null,
      });
      assert.equal(wakes, 1);
      assert.lengthOf(await runRows(), 1);
    });

    it("converges two concurrent creates for an unseen revision on one run and one enqueue", async () => {
      // Both requests resolve the PR before either inserts, so both race to
      // INSERT and one recovers through the unique-conflict path.
      let release!: () => void;
      github.gate = new Promise<void>((r) => (release = r));
      github.onCall = () => {
        if (github.calls === 2) release();
      };
      const [a, b] = await Promise.all([
        request(app).post(`${prBase()}/runs`).set("Authorization", auth()),
        request(app).post(`${prBase()}/runs`).set("Authorization", auth()),
      ]);
      assert.sameMembers([a.status, b.status], [200, 201]);
      assert.equal(a.body.run.id, b.body.run.id);
      assert.lengthOf(await runRows(), 1);
      assert.equal(wakes, 1);

      github.gate = null;
      const later = await request(app)
        .post(`${prBase()}/runs`)
        .set("Authorization", auth());
      assert.equal(later.status, 200);
      assert.equal(later.body.run.id, a.body.run.id);
      assert.equal(wakes, 1);
    });

    it("shares one lowercase run across differently cased org/repo paths", async () => {
      const upper = await request(app)
        .post(
          `/v1/pr-reviewer/${org.toUpperCase()}/PlayOla/pulls/${prNumber}/runs`,
        )
        .set("Authorization", auth());
      assert.equal(upper.status, 201);
      assert.equal(upper.body.run.org, org);
      assert.equal(upper.body.run.repo, repo);
      const lower = await request(app)
        .post(`${prBase()}/runs`)
        .set("Authorization", auth());
      assert.equal(lower.status, 200);
      assert.equal(lower.body.run.id, upper.body.run.id);
      const latest = await request(app)
        .get(
          `/v1/pr-reviewer/${org.toUpperCase()}/PLAYOLA/pulls/${prNumber}/runs/latest`,
        )
        .set("Authorization", auth());
      assert.equal(latest.status, 200);
      assert.equal(latest.body.run.id, upper.body.run.id);
      const rows = await runRows();
      assert.lengthOf(rows, 1);
      assert.equal(rows[0].org, org);
      assert.equal(rows[0].repo, repo);
      assert.equal(wakes, 1);
    });

    it("creates a second run when the PR has a new head", async () => {
      const first = await request(app)
        .post(`${prBase()}/runs`)
        .set("Authorization", auth());
      github.set(org, repo, prNumber, prInfo({ headSha: HEAD_B, commits: 4 }));
      const second = await request(app)
        .post(`${prBase()}/runs`)
        .set("Authorization", auth());
      assert.equal(second.status, 201);
      assert.notEqual(second.body.run.id, first.body.run.id);
      assert.equal(second.body.run.headSha, HEAD_B);
      assert.equal(second.body.run.pr.commits, 4);
      assert.lengthOf(await runRows(), 2);
      assert.equal(wakes, 2);
    });

    it("answers 404 pr_not_found for a PR GitHub doesn't have", async () => {
      const res = await request(app)
        .post(`/v1/pr-reviewer/${org}/${repo}/pulls/999/runs`)
        .set("Authorization", auth());
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "pr_not_found" });
      assert.lengthOf(await runRows(), 0);
      assert.equal(wakes, 0);
    });

    it("answers 422 empty_diff for commits that cancel out, inserting and enqueuing nothing", async () => {
      // A change followed by its revert: commits, but no net changed files.
      github.set(
        org,
        repo,
        prNumber,
        prInfo({ commits: 2, hasNetDiff: false }),
      );
      const res = await request(app)
        .post(`${prBase()}/runs`)
        .set("Authorization", auth());
      assert.equal(res.status, 422);
      assert.deepEqual(res.body, { error: "empty_diff" });
      assert.lengthOf(await runRows(), 0);
      assert.equal(wakes, 0);
    });
  });

  describe("GET runs/latest", () => {
    it("returns the current revision and run null when the PR has no runs", async () => {
      const res = await request(app)
        .get(`${prBase()}/runs/latest`)
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        pr: {
          title: "Fix flaky tests by cutting slow git setup work",
          url: "https://github.com/playola-radio/playola/pull/123",
          baseRef: "main",
          headRef: "brian-keane/chapters-flaky-test-fix",
          commits: 3,
          currentHeadSha: HEAD_A,
          currentBaseSha: BASE,
        },
        run: null,
      });
      assert.lengthOf(await runRows(), 0);
      assert.equal(wakes, 0);
    });

    it("reports a moved head without creating or enqueuing anything", async () => {
      const id = await insertRun();
      github.set(org, repo, prNumber, prInfo({ headSha: HEAD_B, commits: 4 }));
      const res = await request(app)
        .get(`${prBase()}/runs/latest`)
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.pr.currentHeadSha, HEAD_B);
      assert.equal(res.body.run.id, id);
      assert.equal(res.body.run.headSha, HEAD_A);
      assertRunShape(res.body.run);
      assert.notProperty(res.body, "newerRun");
      assert.lengthOf(await runRows(), 1);
      assert.equal(wakes, 0);
    });

    it("prefers an older ready run and reports the newer generating one as newerRun", async () => {
      const a = await insertRun({ ageSeconds: 120 });
      const b = await insertRun({
        status: "generating",
        headSha: HEAD_B,
        ageSeconds: 10,
      });
      github.set(org, repo, prNumber, prInfo({ headSha: HEAD_B }));
      const res = await request(app)
        .get(`${prBase()}/runs/latest`)
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.run.id, a);
      assert.equal(res.body.run.status, "ready");
      assert.equal(res.body.newerRun.id, b);
      assert.equal(res.body.newerRun.status, "generating");
      assert.deepEqual(res.body.newerRun.progress, {
        stage: "write",
        completedChapters: 1,
        totalChapters: 2,
      });
      assertRunShape(res.body.newerRun);

      await sequelize.query(
        `UPDATE pr_reviewer_runs SET status = 'ready', progress = NULL WHERE id = $b`,
        { bind: { b } },
      );
      const after = await request(app)
        .get(`${prBase()}/runs/latest`)
        .set("Authorization", auth());
      assert.equal(after.body.run.id, b);
      assert.equal(after.body.run.status, "ready");
      assert.notProperty(after.body, "newerRun");
      assert.equal(wakes, 0);
    });

    it("returns the newest run of any status when none is ready, without newerRun", async () => {
      const id = await insertRun({ status: "failed" });
      const res = await request(app)
        .get(`${prBase()}/runs/latest`)
        .set("Authorization", auth());
      assert.equal(res.body.run.id, id);
      assert.equal(res.body.run.status, "failed");
      assert.notProperty(res.body, "newerRun");
    });

    it("answers 404 pr_not_found for a PR GitHub doesn't have", async () => {
      const res = await request(app)
        .get(`/v1/pr-reviewer/${org}/${repo}/pulls/999/runs/latest`)
        .set("Authorization", auth());
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "pr_not_found" });
    });
  });

  describe("GET runs/:runId", () => {
    it("returns the run", async () => {
      const id = await insertRun({ status: "generating" });
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${id}`)
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assertRunShape(res.body.run);
      assert.equal(res.body.run.id, id);
      assert.equal(res.body.run.status, "generating");
    });

    it("answers 404 run_not_found for an unknown or malformed id", async () => {
      for (const id of [randomUUID(), "not-a-uuid"]) {
        const res = await request(app)
          .get(`/v1/pr-reviewer/runs/${id}`)
          .set("Authorization", auth());
        assert.equal(res.status, 404);
        assert.deepEqual(res.body, { error: "run_not_found" });
      }
    });
  });

  describe("POST runs/:runId/retry", () => {
    it("requeues the failed run's pinned revision with a fresh attempt budget", async () => {
      const id = await insertRun({
        status: "failed",
        attempt: 3,
        failure: "Generation failed while writing chapter 3",
      });
      // The PR moved on; retry still targets the run's own revision.
      github.set(org, repo, prNumber, prInfo({ headSha: HEAD_B }));
      const res = await request(app)
        .post(`/v1/pr-reviewer/runs/${id}/retry`)
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assertRunShape(res.body.run);
      assert.include(res.body.run, {
        id,
        status: "queued",
        headSha: HEAD_A,
        baseSha: BASE,
        failure: null,
        failureDetail: null,
      });
      const rows = await runRows();
      assert.lengthOf(rows, 1);
      assert.equal(rows[0].attempt, 0);
      assert.equal(rows[0].head_sha, HEAD_A);
      assert.equal(wakes, 1);
    });

    it("answers 409 run_not_failed for a ready run", async () => {
      const id = await insertRun();
      const res = await request(app)
        .post(`/v1/pr-reviewer/runs/${id}/retry`)
        .set("Authorization", auth());
      assert.equal(res.status, 409);
      assert.deepEqual(res.body, { error: "run_not_failed" });
      assert.equal(wakes, 0);
    });

    it("answers 404 run_not_found for an unknown run", async () => {
      const res = await request(app)
        .post(`/v1/pr-reviewer/runs/${randomUUID()}/retry`)
        .set("Authorization", auth());
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "run_not_found" });
    });
  });

  describe("GET runs/:runId/chapters", () => {
    it("serves the stored document verbatim with the caller's reviewed marks", async () => {
      const id = await insertRun();
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${id}/chapters`)
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assert.hasAllKeys(res.body, ["run", "document", "reviewed"]);
      assertRunShape(res.body.run);
      assert.deepEqual(res.body.document, fixtureDocument);
      chaptersDocumentSchema.parse(res.body.document);
      assert.deepEqual(res.body.reviewed, []);
    });

    it("answers 409 run_not_ready with the run for a generating run", async () => {
      const id = await insertRun({ status: "generating" });
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${id}/chapters`)
        .set("Authorization", auth());
      assert.equal(res.status, 409);
      assert.equal(res.body.error, "run_not_ready");
      assert.equal(res.body.run.id, id);
      assertRunShape(res.body.run);
    });

    it("answers 404 run_not_found for an unknown run", async () => {
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${randomUUID()}/chapters`)
        .set("Authorization", auth());
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "run_not_found" });
    });
  });

  describe("GET runs/:runId/files", () => {
    it("serves a stored markdown file and 404s a path with no row", async () => {
      const text = "# Project\n\n## Testing\n\nRun `npm test`.\n";
      const id = await insertRun({ files: [{ path: "README.md", text }] });
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${id}/files`)
        .query({ path: "README.md" })
        .set("Authorization", auth());
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { path: "README.md", text });

      for (const path of ["src/setup.ts", "docs/missing.md"]) {
        const miss = await request(app)
          .get(`/v1/pr-reviewer/runs/${id}/files`)
          .query({ path })
          .set("Authorization", auth());
        assert.equal(miss.status, 404);
        assert.deepEqual(miss.body, { error: "file_not_available" });
      }
      const noPath = await request(app)
        .get(`/v1/pr-reviewer/runs/${id}/files`)
        .set("Authorization", auth());
      assert.equal(noPath.status, 404);
      assert.deepEqual(noPath.body, { error: "file_not_available" });
    });

    it("answers 404 run_not_found for an unknown run", async () => {
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${randomUUID()}/files`)
        .query({ path: "README.md" })
        .set("Authorization", auth());
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "run_not_found" });
    });
  });

  describe("PUT/DELETE runs/:runId/chapters/:chapterKey/reviewed", () => {
    const reviewedBy = async (id: string, email: string) => {
      const res = await request(app)
        .get(`/v1/pr-reviewer/runs/${id}/chapters`)
        .set("Authorization", `Bearer ${token(email)}`);
      return res.body.reviewed as string[];
    };
    const mark = (
      method: "put" | "delete",
      id: string,
      key: string,
      email: string,
    ) => {
      const path = `/v1/pr-reviewer/runs/${id}/chapters/${key}/reviewed`;
      const req =
        method === "put" ? request(app).put(path) : request(app).delete(path);
      return req.set("Authorization", `Bearer ${token(email)}`);
    };

    it("keeps marks per user and idempotent", async () => {
      const id = await insertRun();
      const ann = "ann@playola.fm";
      const bob = "bob@playola.fm";

      assert.equal((await mark("put", id, "setup-timeouts", ann)).status, 204);
      assert.equal((await mark("put", id, "setup-timeouts", ann)).status, 204);
      assert.equal((await mark("put", id, "retry-logic", bob)).status, 204);
      assert.deepEqual(await reviewedBy(id, ann), ["setup-timeouts"]);
      assert.deepEqual(await reviewedBy(id, bob), ["retry-logic"]);

      const del = await mark("delete", id, "setup-timeouts", ann);
      assert.equal(del.status, 204);
      assert.equal(
        (await mark("delete", id, "setup-timeouts", ann)).status,
        204,
      );
      assert.deepEqual(await reviewedBy(id, ann), []);
      assert.deepEqual(await reviewedBy(id, bob), ["retry-logic"]);
    });

    it("answers 404 for a chapter key not in the document or an unknown run", async () => {
      const id = await insertRun();
      const put = await mark("put", id, "no-such-chapter", "ann@playola.fm");
      assert.equal(put.status, 404);
      const del = await mark("delete", id, "no-such-chapter", "ann@playola.fm");
      assert.equal(del.status, 404);
      const unknown = await mark(
        "put",
        randomUUID(),
        "setup-timeouts",
        "ann@playola.fm",
      );
      assert.equal(unknown.status, 404);
      assert.deepEqual(unknown.body, { error: "run_not_found" });
      const rows = await sequelize.query(
        `SELECT 1 FROM pr_reviewer_chapter_reviews WHERE run_id = $id`,
        { bind: { id }, type: QueryTypes.SELECT },
      );
      assert.lengthOf(rows, 0);
    });
  });
});
