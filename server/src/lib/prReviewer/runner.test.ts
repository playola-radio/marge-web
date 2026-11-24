import { assert } from "chai";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import type { ExtractOutput } from "./extract.js";
import { GitCache } from "./gitCache.js";
import {
  defaultAnswer,
  FakeLlmClient,
  type FakeAnswer,
} from "./llm/fakeClient.js";
import type { LlmStage } from "./llm/LlmClient.js";
import { FixtureRepo, removeDir, tempDir } from "./repoFixtures.test.js";
import {
  chaptersDocumentSchema,
  generateChapters,
  type Assembled,
  type StageCache,
  type StageCacheEntry,
} from "./pipeline/index.js";
import {
  assertCovered,
  featureExtract,
} from "./pipeline/pipelineFixtures.test.js";
import { PostgresStageCache } from "./pipeline/stageCache.js";
import {
  createExecutor,
  PIPELINE_VERSION,
  Runner,
  RunStore,
  type Claim,
  type RunExecutor,
} from "./runner.js";

// Runs only when DATABASE_URL is set, against the migrated database:
//   DATABASE_URL=postgres://postgres:pass@127.0.0.1:5432/margedev npm test
// Every row it writes belongs to an org named test-runner-*, deleted after
// each test (documents and files cascade); its stage-cache rows are tracked
// and deleted too. It never drops anything.
const dbUrl = process.env.DATABASE_URL;

/**
 * The runner claims from the whole queue, so a test against a database holding
 * someone's live runs would consume them. Refuse instead: use a scratch database.
 */
export async function refuseLiveRuns(sequelize: Sequelize): Promise<void> {
  const rows = await sequelize.query<{ id: string }>(
    `SELECT id FROM pr_reviewer_runs
      WHERE status IN ('queued', 'generating') AND org NOT LIKE 'test-runner-%'
      LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  if (rows.length)
    throw new Error(
      "DATABASE_URL holds queued or generating PR reviewer runs the tests would claim; run them against a scratch database",
    );
}

/** The Postgres stage cache, remembering its keys for cleanup. */
class TrackedCache implements StageCache {
  readonly keys: string[] = [];
  constructor(private readonly inner: PostgresStageCache) {}
  get(key: string) {
    return this.inner.get(key);
  }
  put(key: string, stage: LlmStage, entry: StageCacheEntry) {
    this.keys.push(key);
    return this.inner.put(key, stage, entry);
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 500; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

(dbUrl ? describe : describe.skip)("runner", function () {
  this.timeout(20_000);
  let sequelize: Sequelize;
  let cache: TrackedCache;
  let model: string;
  let org: string;
  let up: FixtureRepo;
  let extracted: ExtractOutput;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);

  before(async () => {
    sequelize = new Sequelize(dbUrl as string, {
      dialect: "postgres",
      logging: false,
    });
    await refuseLiveRuns(sequelize);
  });
  beforeEach(async () => {
    cache = new TrackedCache(new PostgresStageCache(sequelize));
    // A model name unique to the test keeps its stage-cache keys its own.
    model = `fake-${randomBytes(6).toString("hex")}`;
    org = `test-runner-${randomBytes(6).toString("hex")}`;
    logs.length = 0;
    up = FixtureRepo.create();
    extracted = await featureExtract(up);
  });
  afterEach(async () => {
    up.remove();
    await sequelize.query(`DELETE FROM pr_reviewer_runs WHERE org = $org`, {
      bind: { org },
    });
    await sequelize.query(
      `DELETE FROM pr_reviewer_stage_outputs WHERE cache_key = ANY($keys)`,
      { bind: { keys: cache.keys } },
    );
  });
  after(() => sequelize.close());

  const llm = (script: Partial<Record<LlmStage, FakeAnswer[]>> = {}) =>
    new FakeLlmClient({ model, script });

  async function insertRun(
    overrides: { prNumber?: number } = {},
  ): Promise<string> {
    const [row] = await sequelize.query<{ id: string }>(
      `INSERT INTO pr_reviewer_runs
         (org, repo, pr_number, head_sha, base_sha, pipeline_version, status,
          pr_meta, created_at, updated_at)
       VALUES ($org, 'widgets', $pr, $head, $base, $version, 'queued',
               $meta::jsonb, now(), now())
       RETURNING id`,
      {
        bind: {
          org,
          pr: overrides.prNumber ?? 7,
          head: extracted.result.headSha,
          base: extracted.result.baseSha,
          version: PIPELINE_VERSION,
          meta: JSON.stringify({
            title: "Add a greeting",
            url: `https://github.com/${org}/widgets/pull/7`,
            baseRef: "main",
            headRef: "feature",
            commits: 3,
          }),
        },
        type: QueryTypes.SELECT,
      },
    );
    return row.id;
  }

  interface RunState {
    status: string;
    attempt: number;
    progress: unknown;
    failure: string | null;
    failure_detail: string | null;
    lease_token: string | null;
    lease_expires_at: Date | null;
  }

  async function runState(id: string): Promise<RunState> {
    const [row] = await sequelize.query<RunState>(
      `SELECT status, attempt, progress, failure, failure_detail, lease_token,
              lease_expires_at
         FROM pr_reviewer_runs WHERE id = $id`,
      { bind: { id }, type: QueryTypes.SELECT },
    );
    return row;
  }

  async function documentOf(id: string) {
    const rows = await sequelize.query<{ document: { title: string } }>(
      `SELECT document FROM pr_reviewer_documents WHERE run_id = $id`,
      { bind: { id }, type: QueryTypes.SELECT },
    );
    return rows[0]?.document ?? null;
  }

  async function filesOf(id: string) {
    return sequelize.query<{ path: string; text: string }>(
      `SELECT path, text FROM pr_reviewer_run_files WHERE run_id = $id ORDER BY path`,
      { bind: { id }, type: QueryTypes.SELECT },
    );
  }

  async function expireLease(id: string) {
    await sequelize.query(
      `UPDATE pr_reviewer_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $id`,
      { bind: { id } },
    );
  }

  /** What PR 4's Retry endpoint does: back to queued with a fresh budget. */
  async function retry(id: string) {
    await sequelize.query(
      `UPDATE pr_reviewer_runs
          SET status = 'queued', attempt = 0, failure = NULL,
              failure_detail = NULL, updated_at = now()
        WHERE id = $id AND status = 'failed'`,
      { bind: { id } },
    );
  }

  /** An executor that skips git and runs the pipeline on the fixture extract. */
  function pipelineExecutor(
    client: FakeLlmClient,
    concurrency = 1,
  ): RunExecutor {
    return async (_claim, ctx) => {
      await ctx.progress({ stage: "fetch" });
      await ctx.progress({ stage: "extract" });
      return generateChapters({
        extract: extracted,
        llm: client,
        cache,
        concurrency,
        onProgress: (p) => ctx.progress(p),
      });
    };
  }

  function runner(
    execute: RunExecutor,
    opts: { maxAttempts?: number; leaseMs?: number } = {},
  ) {
    const leaseMs = opts.leaseMs ?? 60_000;
    return new Runner({
      store: new RunStore(sequelize, leaseMs),
      execute,
      maxAttempts: opts.maxAttempts,
      leaseMs,
      log,
    });
  }

  async function assembledWith(title: string): Promise<Assembled> {
    const out = await generateChapters({
      extract: extracted,
      llm: llm(),
      cache,
    });
    return { ...out, document: { ...out.document, title } };
  }

  it("publishes the complete document, its markdown files and ready in one go", async () => {
    const id = await insertRun();
    assert.isTrue(await runner(pipelineExecutor(llm())).runOnce());

    const state = await runState(id);
    assert.equal(state.status, "ready");
    assert.equal(state.attempt, 1);
    assert.isNull(state.progress);
    assert.isNull(state.lease_token);
    assert.isNull(state.lease_expires_at);
    const doc = chaptersDocumentSchema.parse(await documentOf(id));
    assertCovered(doc);
    assert.deepEqual(await filesOf(id), extracted.markdownSources);
  });

  it("stores NUL characters as U+FFFD but keeps escape text in the source verbatim", async () => {
    await insertRun();
    const store = new RunStore(sequelize, 60_000);
    const claim = (await store.claimNext(3)) as Claim;
    const title = "s.replace(/\\u0000/g, '') a\u0000b";
    assert.isTrue(await store.publish(claim, await assembledWith(title)));
    assert.equal(
      (await documentOf(claim.run.id))!.title,
      "s.replace(/\\u0000/g, '') a\ufffdb",
    );
  });

  it("never marks a run ready when its publication fails part-way", async () => {
    const id = await insertRun();
    const execute: RunExecutor = async (claim, ctx) => {
      const out = await pipelineExecutor(llm())(claim, ctx);
      // Two rows for one path break the files insert inside the transaction.
      return {
        ...out,
        markdownSources: [...out.markdownSources, ...out.markdownSources],
      };
    };
    await runner(execute, { maxAttempts: 1 }).runOnce();

    const state = await runState(id);
    assert.equal(state.status, "failed");
    assert.equal(state.failure, "Generation failed while saving the chapters");
    assert.isNull(await documentOf(id));
    assert.deepEqual(await filesOf(id), []);
  });

  it("reclaims a run whose worker died mid-write and finishes it reusing completed stages", async () => {
    const id = await insertRun();
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    let reachedHang = false;
    let writes = 0;
    const dying = llm({
      write: [
        // Chapter 1 is written and cached; chapter 2 never comes back.
        (req) => {
          writes += 1;
          return defaultAnswer("write", req.input);
        },
        async (req) => {
          reachedHang = true;
          await hung;
          return defaultAnswer("write", req.input);
        },
      ],
    });
    const stale = runner(pipelineExecutor(dying)).runOnce();
    await until(() => reachedHang, "the first worker to stall");
    assert.equal(writes, 1);
    await expireLease(id);

    const fresh = llm();
    assert.isTrue(await runner(pipelineExecutor(fresh)).runOnce());
    const doc = chaptersDocumentSchema.parse(await documentOf(id));
    assert.lengthOf(fresh.callsFor("outline"), 0);
    assert.lengthOf(fresh.callsFor("write"), doc.chapters.length - 1);
    const state = await runState(id);
    assert.equal(state.status, "ready");
    assert.equal(state.attempt, 2);

    release();
    await stale;
    assert.include(logs, `pr_reviewer_run_lease_lost ${id}`);
    assert.equal((await runState(id)).status, "ready");
    assert.deepEqual(await documentOf(id), doc);
  });

  it("rejects every write of a reclaimed worker; only the current claimant publishes", async () => {
    const id = await insertRun();
    const store = new RunStore(sequelize, 60_000);
    const a = (await store.claimNext(3)) as Claim;
    await expireLease(id);
    const b = (await store.claimNext(3)) as Claim;
    assert.notEqual(a.leaseToken, b.leaseToken);
    assert.equal(b.run.attempt, 2);

    assert.isFalse(await store.heartbeat(a));
    assert.isFalse(await store.setProgress(a, { stage: "summarize" }));
    assert.isFalse(await store.publish(a, await assembledWith("stale")));
    assert.isNull(await documentOf(id));
    assert.isFalse(await store.fail(a, "x", "y"));
    assert.isFalse(await store.requeue(a));
    assert.equal((await runState(id)).status, "generating");

    assert.isTrue(await store.setProgress(b, { stage: "outline" }));
    assert.isTrue(await store.publish(b, await assembledWith("current")));
    assert.equal((await documentOf(id))!.title, "current");
    assert.equal((await runState(id)).status, "ready");
    assert.isFalse(await store.publish(a, await assembledWith("stale")));
    assert.equal((await documentOf(id))!.title, "current");
  });

  it("rejects a stalled worker's writes after its run was exhausted, retried and claimed anew", async () => {
    const id = await insertRun();
    const store = new RunStore(sequelize, 60_000);
    const stalled = (await store.claimNext(2)) as Claim;
    assert.equal(stalled.run.attempt, 1);
    await expireLease(id);
    const second = (await store.claimNext(2)) as Claim;
    assert.isTrue(await store.fail(second, "Generation failed", "boom"));
    assert.equal((await runState(id)).status, "failed");

    await retry(id);
    const renewed = (await store.claimNext(2)) as Claim;
    // Same attempt number as the stalled claim: only the token tells them apart.
    assert.equal(renewed.run.attempt, stalled.run.attempt);

    assert.isFalse(await store.heartbeat(stalled));
    assert.isFalse(
      await store.setProgress(stalled, {
        stage: "write",
        completedChapters: 1,
        totalChapters: 3,
      }),
    );
    assert.isFalse(await store.fail(stalled, "stale", "stale"));
    assert.isFalse(await store.requeue(stalled));
    assert.isFalse(await store.publish(stalled, await assembledWith("stale")));
    assert.isNull(await documentOf(id));

    assert.isTrue(await store.publish(renewed, await assembledWith("renewed")));
    assert.equal((await documentOf(id))!.title, "renewed");
  });

  it("retries automatically, then leaves the run failed with its failure and detail past the bound", async () => {
    const id = await insertRun();
    const failing = llm({
      outline: [new Error("ECONNRESET one"), new Error("ECONNRESET two")],
    });
    const r = runner(pipelineExecutor(failing), { maxAttempts: 2 });

    assert.isTrue(await r.runOnce());
    let state = await runState(id);
    assert.equal(state.status, "queued");
    assert.equal(state.attempt, 1);
    assert.isNull(state.failure);

    // The requeued run waits out its backoff instead of being reclaimed at once.
    assert.isFalse(await r.runOnce());
    await sequelize.query(
      `UPDATE pr_reviewer_runs SET updated_at = now() - interval '1 minute'
        WHERE id = $id`,
      { bind: { id } },
    );
    assert.isTrue(await r.runOnce());
    state = await runState(id);
    assert.equal(state.status, "failed");
    assert.equal(state.attempt, 2);
    assert.equal(state.failure, "Generation failed while outlining");
    assert.include(state.failure_detail!, "ECONNRESET two");
    assert.isNull(state.lease_token);
    assert.isNull(state.progress);
    assert.isFalse(await r.runOnce());
  });

  it("names the chapter whose write failed", async () => {
    const id = await insertRun();
    const failing = llm({
      write: [
        { intro: "One.", steps: [] },
        { intro: "One.", steps: [] },
        new Error("overloaded"),
      ],
    });
    await runner(pipelineExecutor(failing), { maxAttempts: 1 }).runOnce();
    const state = await runState(id);
    assert.equal(state.failure, "Generation failed while writing chapter 2");
  });

  it("fails a run whose workers died on every attempt", async () => {
    const id = await insertRun();
    const store = new RunStore(sequelize, 60_000);
    await store.claimNext(1);
    await expireLease(id);
    assert.isFalse(
      await runner(pipelineExecutor(llm()), { maxAttempts: 1 }).runOnce(),
    );
    const state = await runState(id);
    assert.equal(state.status, "failed");
    assert.equal(
      state.failure,
      "Generation stopped before it finished, too many times",
    );
    assert.include(state.failure_detail!, "last stage: fetch");
  });

  it("completes an exhausted failed run after Retry resets its attempt, reusing cached stages", async () => {
    const id = await insertRun();
    const failing = llm({ summarize: [new Error("503 overloaded")] });
    await runner(pipelineExecutor(failing), { maxAttempts: 1 }).runOnce();
    assert.equal((await runState(id)).status, "failed");
    assert.equal(
      (await runState(id)).failure,
      "Generation failed while summarizing",
    );
    // Without Retry the budget is spent: nothing is claimable.
    assert.isFalse(
      await runner(pipelineExecutor(llm()), { maxAttempts: 1 }).runOnce(),
    );

    await retry(id);
    const fresh = llm();
    assert.isTrue(
      await runner(pipelineExecutor(fresh), { maxAttempts: 1 }).runOnce(),
    );
    const state = await runState(id);
    assert.equal(state.status, "ready");
    assert.isNull(state.failure);
    assert.isNull(state.failure_detail);
    assert.lengthOf(fresh.callsFor("outline"), 0);
    assert.lengthOf(fresh.callsFor("write"), 0);
    assert.lengthOf(fresh.callsFor("summarize"), 1);
  });

  describe("with the real executor", () => {
    let root: string;
    const TOKEN = "ghs_runnerTestToken1234567890";
    beforeEach(() => {
      root = tempDir("runner-cache");
    });
    afterEach(() => removeDir(root));

    function github(
      remoteUrl = () => up.url,
      prCommits = () =>
        up.prCommits(extracted.result.baseSha, extracted.result.headSha),
    ) {
      return {
        remoteUrl,
        installationToken: async () => TOKEN,
        repoSizeKb: async () => 10,
        compareCommits: async () => prCommits(),
      };
    }

    it("stores the markdown sources captured at extraction, even when the git cache is cleared before publish", async () => {
      const id = await insertRun();
      const client = llm({
        outline: [
          async (req) => {
            // Extraction is over: wipe the git cache before anything is published.
            rmSync(root, { recursive: true, force: true });
            return defaultAnswer("outline", req.input);
          },
        ],
      });
      const execute = createExecutor({
        github: github(),
        gitCache: new GitCache({ root }),
        llm: client,
        cache,
      });
      await runner(execute).runOnce();

      const state = await runState(id);
      assert.equal(state.status, "ready", state.failure_detail ?? "");
      const doc = chaptersDocumentSchema.parse(await documentOf(id));
      assertCovered(doc);
      assert.deepEqual(doc.pr, {
        number: 7,
        title: "Add a greeting",
        url: `https://github.com/${org}/widgets/pull/7`,
        host: "github.com",
        owner: org,
        repo: "widgets",
      });
      assert.equal(doc.headSha, extracted.result.headSha);
      assert.deepEqual(await filesOf(id), extracted.markdownSources);

      // The same revision again (another PR pointing at it): no LLM calls.
      const again = await insertRun({ prNumber: 8 });
      const second = llm();
      await runner(
        createExecutor({
          github: github(),
          gitCache: new GitCache({ root }),
          llm: second,
          cache,
        }),
      ).runOnce();
      assert.equal((await runState(again)).status, "ready");
      assert.lengthOf(second.calls, 0);
    });

    it("stores a git authentication failure's detail without the token or its Basic value", async () => {
      const id = await insertRun();
      const execute = createExecutor({
        github: github(() => `file://${root}/no-such-upstream.git`),
        gitCache: new GitCache({ root }),
        llm: llm(),
        cache,
      });
      await runner(execute, { maxAttempts: 1 }).runOnce();

      const state = await runState(id);
      assert.equal(state.status, "failed");
      assert.equal(state.failure, "Generation failed while fetching the repo");
      const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
      assert.isNotEmpty(state.failure_detail);
      assert.notInclude(state.failure_detail!, TOKEN);
      assert.notInclude(state.failure_detail!, basic);
      assert.include(state.failure_detail!, "[REDACTED]");
    });
  });
});
