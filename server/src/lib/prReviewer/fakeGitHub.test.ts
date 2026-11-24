import { assert } from "chai";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DEMO_REPOS } from "./demoFixture.js";
import { FakeGitHub, type DemoRepo } from "./fakeGitHub.js";
import { GitCache } from "./gitCache.js";
import { GitHubError } from "./github.js";
import { FakeLlmClient } from "./llm/index.js";
import { MemoryStageCache } from "./pipeline/stage.js";
import { lines, removeDir, tempDir } from "./repoFixtures.test.js";
import { createExecutor, type RunProgress } from "./runner.js";

const REPOS: DemoRepo[] = [
  {
    org: "acme",
    repo: "widgets",
    history: [{ message: "Start", files: { "a.txt": lines("one", "two") } }],
    pulls: [
      {
        number: 5,
        title: "Count to three",
        headRef: "feature/three",
        commits: [
          {
            message: "Add three",
            files: { "a.txt": lines("one", "two", "3") },
          },
          {
            message: "Spell it out",
            files: { "a.txt": lines("one", "two", "three") },
          },
        ],
        pushedLater: [
          { message: "Add four", files: { "b.txt": lines("four") } },
        ],
      },
    ],
  },
];

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

describe("FakeGitHub", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir("fake-github");
  });
  afterEach(() => removeDir(root));

  it("resolves a fixture pull request from the repository it builds", async () => {
    const github = new FakeGitHub({ root, repos: REPOS });
    const pr = await github.resolvePullRequest("acme", "widgets", 5);
    const dir = join(root, "acme", "widgets");
    assert.deepEqual(pr, {
      title: "Count to three",
      url: "https://github.com/acme/widgets/pull/5",
      baseRef: "main",
      headRef: "feature/three",
      headSha: git(dir, "rev-parse", "feature/three"),
      baseSha: git(dir, "rev-parse", "main"),
      commits: 2,
      hasNetDiff: true,
    });
    assert.strictEqual(github.remoteUrl("acme", "widgets"), `file://${dir}`);
    assert.deepEqual(
      (await github.compareCommits("acme", "widgets", pr.baseSha, pr.headSha))
        .length,
      2,
    );
  });

  it("builds the same commit IDs every time", async () => {
    const other = tempDir("fake-github");
    try {
      const a = await new FakeGitHub({ root, repos: REPOS }).resolvePullRequest(
        "acme",
        "widgets",
        5,
      );
      const b = await new FakeGitHub({
        root: other,
        repos: REPOS,
      }).resolvePullRequest("acme", "widgets", 5);
      assert.strictEqual(a.headSha, b.headSha);
      assert.strictEqual(a.baseSha, b.baseSha);
    } finally {
      removeDir(other);
    }
  });

  it("answers pr_not_found for a pull request or repository it doesn't have", async () => {
    const github = new FakeGitHub({ root, repos: REPOS });
    for (const [org, repo, n] of [
      ["acme", "widgets", 6],
      ["acme", "gadgets", 5],
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
    const github = new FakeGitHub({ root, repos: REPOS });
    const before = await github.resolvePullRequest("acme", "widgets", 5);
    git(
      join(root, "acme", "widgets"),
      "update-ref",
      "refs/heads/feature/three",
      "refs/pushed-later/feature/three",
    );
    const after = await github.resolvePullRequest("acme", "widgets", 5);
    assert.notStrictEqual(after.headSha, before.headSha);
    assert.strictEqual(after.baseSha, before.baseSha);
    assert.strictEqual(after.commits, 3);
  });

  it("rebuilds a repository whose directory was removed (the demo reset)", async () => {
    const github = new FakeGitHub({ root, repos: REPOS });
    const first = await github.resolvePullRequest("acme", "widgets", 5);
    removeDir(join(root, "acme"));
    const again = await github.resolvePullRequest("acme", "widgets", 5);
    assert.strictEqual(again.headSha, first.headSha);
  });

  it("serves the demo pull request offline through the real git cache, extraction and pipeline", async function () {
    this.timeout(30_000);
    const github = new FakeGitHub({ root, repos: DEMO_REPOS });
    const pr = await github.resolvePullRequest(
      "playola-demo",
      "station-scheduler",
      42,
    );
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
          org: "playola-demo",
          repo: "station-scheduler",
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
    assert.isAbove(doc.document.chapters.length, 1);
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
