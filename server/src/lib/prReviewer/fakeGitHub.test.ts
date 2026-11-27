import { assert } from "chai";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { FakeGitHub } from "./fakeGitHub.js";
import { GitCache } from "./gitCache.js";
import { GitHubError } from "./github.js";
import { FakeLlmClient } from "./llm/index.js";
import { MemoryStageCache } from "./pipeline/stage.js";
import { removeDir, tempDir } from "./repoFixtures.test.js";
import { createExecutor, type RunProgress } from "./runner.js";

const ORG = "playola-demo";
const REPO = "station-scheduler";
const BRANCH = "feature/weekly-top-songs";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

describe("FakeGitHub", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir("fake-github");
  });
  afterEach(() => removeDir(root));

  it("resolves a fixture pull request from the repository it builds", async () => {
    const github = new FakeGitHub(root);
    const pr = await github.resolvePullRequest(ORG, REPO, 42);
    const dir = join(root, ORG, REPO);
    const { files, additions, deletions, changedFiles, ...rest } = pr;
    assert.lengthOf(files, changedFiles);
    assert.isAbove(changedFiles, 0);
    assert.strictEqual(
      additions,
      files.reduce((n, f) => n + f.additions, 0),
    );
    assert.strictEqual(
      deletions,
      files.reduce((n, f) => n + f.deletions, 0),
    );
    assert.deepEqual(rest, {
      title: "Show listeners this week's most-played songs",
      url: `https://github.com/${ORG}/${REPO}/pull/42`,
      baseRef: "main",
      headRef: BRANCH,
      headSha: git(dir, "rev-parse", BRANCH),
      baseSha: git(dir, "rev-parse", "main"),
      commits: 4,
      hasNetDiff: true,
      author: "playola-demo",
      body: "",
    });
    assert.strictEqual(github.remoteUrl(ORG, REPO), `file://${dir}`);
    assert.deepEqual(
      (await github.compareCommits(ORG, REPO, pr.baseSha, pr.headSha)).length,
      4,
    );
  });

  it("answers pr_not_found for a pull request or repository it doesn't have", async () => {
    const github = new FakeGitHub(root);
    for (const [org, repo, n] of [
      [ORG, REPO, 99],
      [ORG, "gadgets", 42],
    ] as const) {
      const err = await github.resolvePullRequest(org, repo, n).then(
        () => null,
        (e: unknown) => e,
      );
      assert.instanceOf(err, GitHubError);
      assert.strictEqual((err as GitHubError).code, "pr_not_found");
    }
  });

  it("sees a push: moving the branch to its pushed-later commits changes the head, not the base", async () => {
    const github = new FakeGitHub(root);
    const before = await github.resolvePullRequest(ORG, REPO, 42);
    git(
      join(root, ORG, REPO),
      "update-ref",
      `refs/heads/${BRANCH}`,
      `refs/pushed-later/${BRANCH}`,
    );
    const after = await github.resolvePullRequest(ORG, REPO, 42);
    assert.notStrictEqual(after.headSha, before.headSha);
    assert.strictEqual(after.baseSha, before.baseSha);
    assert.strictEqual(after.commits, 5);
  });

  it("rebuilds a repository whose directory was removed (the demo reset), with the same commit IDs", async () => {
    const github = new FakeGitHub(root);
    const first = await github.resolvePullRequest(ORG, REPO, 42);
    removeDir(join(root, ORG));
    const again = await github.resolvePullRequest(ORG, REPO, 42);
    assert.strictEqual(again.headSha, first.headSha);
    assert.strictEqual(again.baseSha, first.baseSha);
  });

  it("serves the demo pull request offline through the real git cache, extraction and pipeline", async function () {
    this.timeout(30_000);
    const github = new FakeGitHub(root);
    const pr = await github.resolvePullRequest(ORG, REPO, 42);
    const stages: RunProgress["stage"][] = [];
    const execute = createExecutor({
      github,
      gitCache: new GitCache({ root: join(root, "cache") }),
      llm: new FakeLlmClient(),
      cache: new MemoryStageCache(),
    });
    const doc = await execute(
      {
        leaseToken: "t",
        run: {
          id: "r",
          org: ORG,
          repo: REPO,
          prNumber: 42,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          attempt: 1,
          prMeta: { ...pr },
        },
      },
      {
        progress: async (p) => {
          stages.push(p.stage);
        },
      },
    );

    assert.includeMembers(stages, ["fetch", "extract", "outline", "summarize"]);
    assert.lengthOf(doc.document.commits, 4);
    assert.deepEqual(
      doc.document.chapters.map((c) => c.headline),
      [
        "Count each song's plays over the last seven days",
        "Serve the weekly top songs from the stations API",
        "Show the top songs on the station page",
        "Document the top-songs endpoint",
      ],
    );
    assert.deepEqual(
      doc.markdownSources.map((m) => m.path),
      ["docs/api.md"],
    );
    const excluded = doc.document.excluded.map(
      (e) => doc.document.runs.find((r) => r.id === e.runId)?.path,
    );
    assert.include(excluded, "package-lock.json");
  });
});
