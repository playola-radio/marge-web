import { assert } from "chai";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { extract, unitsOf, type ExtractResult } from "./extract.js";
import {
  CacheTooLargeError,
  Git,
  GitCache,
  spawnGit,
  type GitSpawn,
} from "./gitCache.js";
import { FixtureRepo, lines, removeDir, tempDir } from "./repoFixtures.test.js";

const git = new Git();

/** The changed lines of one file as [kind, text, owner] triples, in diff order. */
function owners(
  result: ExtractResult,
  path: string,
): [string, string, string][] {
  const file = result.files.find((f) => f.path === path);
  assert.exists(file, `no file ${path}`);
  const runs = new Map(result.runs.map((r) => [r.id, r]));
  return file!.hunks.flatMap((h) =>
    h.lines
      .filter((l) => l.kind !== " ")
      .map((l): [string, string, string] => [
        l.kind,
        l.text,
        runs.get(l.runId!)!.commitSha,
      ]),
  );
}

function runsOf(result: ExtractResult, path: string) {
  return result.runs.filter((r) => r.path === path);
}

async function extractFrom(up: FixtureRepo, base: string, head: string) {
  return extract({
    git,
    gitDir: up.dir,
    baseSha: base,
    headSha: head,
    baseRef: "main",
    branch: "feature",
    repo: "widgets",
  });
}

describe("extract", () => {
  let up: FixtureRepo;
  beforeEach(() => {
    up = FixtureRepo.create();
  });
  afterEach(() => up.remove());

  /** Starts a branch off a base commit holding `files`; returns the base SHA. */
  function base(files: Record<string, string | Buffer>): string {
    const sha = up.commit("base", files);
    up.checkout("feature", true);
    return sha;
  }

  it("1. single commit, new file: one added file, one run owned by that commit", async () => {
    const b = base({ "README.md": lines("hi") });
    const c1 = up.commit("add greet", {
      "src/greet.ts": lines("export", "const", "x"),
    });

    const { result } = await extractFrom(up, b, c1);

    assert.deepInclude(result, {
      baseRef: "main",
      baseSha: b,
      headSha: c1,
      branch: "feature",
      repo: "widgets",
    });
    assert.deepEqual(
      result.commits.map((c) => ({ ...c, date: undefined })),
      [
        {
          sha: c1,
          subject: "add greet",
          body: "",
          author: "Fixture Author",
          date: undefined,
        },
      ],
    );
    assert.match(result.commits[0].date, /^2026-01-01T/);
    const [file] = result.files;
    assert.deepInclude(file, {
      path: "src/greet.ts",
      status: "added",
      binary: false,
    });
    assert.lengthOf(file.hunks, 1);
    assert.deepInclude(file.hunks[0], {
      header: "@@ -0,0 +1,3 @@",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 3,
    });
    assert.deepEqual(file.hunks[0].lines[0], {
      kind: "+",
      newNo: 1,
      text: "export",
      runId: result.runs[0].id,
    });
    assert.lengthOf(result.runs, 1);
    const run = result.runs[0];
    assert.deepEqual(run, {
      id: createHash("sha256")
        .update("src/greet.ts\0\0" + "1-3\0" + "+export\n+const\n+x")
        .digest("hex")
        .slice(0, 12),
      path: "src/greet.ts",
      commitSha: c1,
      added: 3,
      removed: 0,
      newRange: [1, 3],
    });
    assert.deepEqual(result.ownerFallbacks, []);
  });

  it("2. a function built across three commits: one run per owner, one unit", async () => {
    const b = base({ "README.md": lines("hi") });
    const c1 = up.commit("skeleton", { "f.ts": lines("function f() {", "}") });
    const c2 = up.commit("body 1", {
      "f.ts": lines("function f() {", "  one();", "}"),
    });
    const c3 = up.commit("body 2", {
      "f.ts": lines("function f() {", "  one();", "  two();", "}"),
    });

    const { result } = await extractFrom(up, b, c3);

    assert.deepEqual(owners(result, "f.ts"), [
      ["+", "function f() {", c1],
      ["+", "  one();", c2],
      ["+", "  two();", c3],
      ["+", "}", c1],
    ]);
    const runs = runsOf(result, "f.ts");
    assert.lengthOf(runs, 4);
    assert.deepEqual(
      runs.map((r) => r.newRange),
      [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ],
    );
    assert.deepEqual(unitsOf(result), [
      { id: runs[0].id, path: "f.ts", runIds: runs.map((r) => r.id) },
    ]);
    assert.deepEqual(
      result.commits.map((c) => c.sha),
      [c1, c2, c3],
    );
  });

  it("3. a branch deleting base lines: reverse blame gives each line its deleting commit", async () => {
    const b = base({
      "a.txt": lines("1", "2", "3", "4", "5", "6", "7", "8", "9", "10"),
    });
    const c1 = up.commit("drop 2", {
      "a.txt": lines("1", "3", "4", "5", "6", "7", "8", "9", "10"),
    });
    const c2 = up.commit("drop 9", {
      "a.txt": lines("1", "3", "4", "5", "6", "7", "8", "10"),
    });

    const { result } = await extractFrom(up, b, c2);

    assert.deepEqual(owners(result, "a.txt"), [
      ["-", "2", c1],
      ["-", "9", c2],
    ]);
    const [first] = result.files[0].hunks[0].lines.filter(
      (l) => l.kind === "-",
    );
    assert.deepInclude(first, { oldNo: 2 });
    assert.deepInclude(runsOf(result, "a.txt")[0], {
      removed: 1,
      added: 0,
      oldRange: [2, 2],
    });
    assert.notProperty(runsOf(result, "a.txt")[0], "newRange");
  });

  it("3b. reverse blame: a base line edited and later deleted belongs to the commit that first removed it", async () => {
    const b = base({ "a.txt": lines("keep", "old", "tail") });
    const c1 = up.commit("edit", { "a.txt": lines("keep", "new", "tail") });
    const c2 = up.commit("delete", { "a.txt": lines("keep", "tail") });

    const { result } = await extractFrom(up, b, c2);

    assert.deepEqual(owners(result, "a.txt"), [["-", "old", c1]]);
  });

  it("3c. reverse blame: a replaced line splits into its deleting and adding commits", async () => {
    const b = base({ "a.txt": lines("a", "b", "c") });
    const c1 = up.commit("remove b", { "a.txt": lines("a", "c") });
    const c2 = up.commit("add B", { "a.txt": lines("a", "B", "c") });

    const { result } = await extractFrom(up, b, c2);

    assert.deepEqual(owners(result, "a.txt"), [
      ["-", "b", c1],
      ["+", "B", c2],
    ]);
    const runs = runsOf(result, "a.txt");
    assert.lengthOf(runs, 2);
    assert.lengthOf(unitsOf(result), 1, "touching runs form one unit");
  });

  it("4. a line added in c1 and edited in c3 belongs to c3", async () => {
    const b = base({ "README.md": lines("hi") });
    const c1 = up.commit("add", { "x.ts": lines("a = 1", "b = 2") });
    up.commit("other", { "y.ts": lines("y") });
    const c3 = up.commit("edit", { "x.ts": lines("a = 10", "b = 2") });

    const { result } = await extractFrom(up, b, c3);

    assert.deepEqual(owners(result, "x.ts"), [
      ["+", "a = 10", c3],
      ["+", "b = 2", c1],
    ]);
  });

  it("5. a line added then removed within the branch is absent", async () => {
    const b = base({ "a.txt": lines("a") });
    up.commit("add", { "a.txt": lines("a", "temp") });
    const c2 = up.commit("remove", { "a.txt": lines("a") });

    const { result } = await extractFrom(up, b, c2);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.runs, []);
    assert.lengthOf(result.commits, 2, "Extract still lands with no net diff");
  });

  it("6. a rename with edits records oldPath and blames each side on its own path", async () => {
    const body = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const b = base({ "old.txt": lines(...body) });
    up.git("mv", "old.txt", "new.txt");
    const c1 = up.commit("rename", {
      "new.txt": lines("1", "2", "THREE", "4", "5", "6", "7", "8"),
    });
    const c2 = up.commit("edit", {
      "new.txt": lines("1", "2", "THREE", "4", "5", "6", "7", "EIGHT"),
    });

    const { result } = await extractFrom(up, b, c2);

    const [file] = result.files;
    assert.deepInclude(file, {
      path: "new.txt",
      oldPath: "old.txt",
      status: "renamed",
    });
    assert.deepEqual(owners(result, "new.txt"), [
      ["-", "3", c1],
      ["+", "THREE", c1],
      ["-", "8", c2],
      ["+", "EIGHT", c2],
    ]);
  });

  it("6b. a pure rename has no hunks and one content-less run owned by the renaming commit", async () => {
    const b = base({ "old.txt": lines("1", "2", "3") });
    up.git("mv", "old.txt", "new.txt");
    const c1 = up.commit("rename");

    const { result } = await extractFrom(up, b, c1);

    assert.deepInclude(result.files[0], {
      path: "new.txt",
      oldPath: "old.txt",
      status: "renamed",
      hunks: [],
    });
    assert.deepInclude(result.runs[0], {
      path: "new.txt",
      commitSha: c1,
      added: 0,
      removed: 0,
    });
  });

  it("7. a deleted file: every line belongs to the deleting commit", async () => {
    const b = base({ "gone.txt": lines("a", "b"), "keep.txt": lines("k") });
    up.commit("touch", { "keep.txt": lines("k", "k2") });
    const c2 = up.commit("delete", { "gone.txt": null });

    const { result } = await extractFrom(up, b, c2);

    const file = result.files.find((f) => f.path === "gone.txt")!;
    assert.deepInclude(file, { status: "deleted" });
    assert.notProperty(file, "oldPath");
    assert.deepEqual(owners(result, "gone.txt"), [
      ["-", "a", c2],
      ["-", "b", c2],
    ]);
  });

  it("a file replaced by a symlink: a deletion and a creation, both owned by the replacing commit", async () => {
    base({ "conf.txt": lines("a", "b") });
    up.git("rm", "-q", "--", "conf.txt");
    symlinkSync("target.txt", join(up.dir, "conf.txt"));
    const c1 = up.commit("link conf");

    const { result } = await extractFrom(up, up.mergeBase("main", c1), c1);

    assert.deepEqual(
      result.files.map((f) => [f.path, f.status]),
      [
        ["conf.txt", "deleted"],
        ["conf.txt", "added"],
      ],
    );
    assert.deepEqual(
      runsOf(result, "conf.txt").map((r) => [r.commitSha, r.removed, r.added]),
      [
        [c1, 2, 0],
        [c1, 0, 1],
      ],
    );
  });

  it("8. a binary file: one content-less run owned by the last commit touching it", async () => {
    const b = base({ "README.md": lines("hi") });
    up.commit("logo", { "logo.png": Buffer.from([0x89, 0x50, 0, 1, 2]) });
    const c2 = up.commit("new logo", {
      "logo.png": Buffer.from([0x89, 0x50, 0, 3, 4]),
    });

    const { result } = await extractFrom(up, b, c2);

    assert.deepInclude(result.files[0], {
      path: "logo.png",
      status: "added",
      binary: true,
      hunks: [],
    });
    assert.lengthOf(result.runs, 1);
    assert.deepInclude(result.runs[0], {
      path: "logo.png",
      commitSha: c2,
      added: 0,
      removed: 0,
    });
    assert.deepEqual(unitsOf(result), [
      { id: result.runs[0].id, path: "logo.png", runIds: [result.runs[0].id] },
    ]);
  });

  it("9. main merged into the branch mid-way: the merge is not a commit and main's lines are not in the diff", async () => {
    up.commit("m1", { "a.txt": lines("1"), "f.txt": lines("f0") });
    up.checkout("feature", true);
    const f1 = up.commit("f1", { "f.txt": lines("f0", "f1") });
    up.checkout("main");
    up.commit("m2", { "a.txt": lines("1", "2") });
    up.checkout("feature");
    up.merge("main", "Merge main into feature");
    const f2 = up.commit("f2", {
      "a.txt": lines("1", "2", "3"),
      "f.txt": lines("f0", "f1", "f2"),
    });
    const mergeBase = up.mergeBase("main", f2);

    const { result } = await extractFrom(up, mergeBase, f2);

    assert.deepEqual(
      result.commits.map((c) => c.subject),
      ["f1", "f2"],
    );
    assert.deepEqual(owners(result, "a.txt"), [["+", "3", f2]]);
    assert.deepEqual(owners(result, "f.txt"), [
      ["+", "f1", f1],
      ["+", "f2", f2],
    ]);
  });

  it("10. blame/diff disagreement: a whitespace-only change inherits a neighbouring owner and is recorded", async () => {
    const b = base({ "a.py": lines("def f():", "    x = 1", "    return x") });
    up.commit("other", { "b.py": lines("b") });
    const c2 = up.commit("reindent and add", {
      "a.py": lines("def f():", "  x = 1", "  y = 2", "    return x"),
    });

    const { result } = await extractFrom(up, b, c2);

    assert.deepEqual(owners(result, "a.py"), [
      ["-", "    x = 1", c2],
      ["+", "  x = 1", c2],
      ["+", "  y = 2", c2],
    ]);
    const fallbackTexts = result.ownerFallbacks.map(
      (f) => `${f.kind}${f.text}`,
    );
    assert.include(fallbackTexts, "+  x = 1");
    for (const f of result.ownerFallbacks) {
      assert.strictEqual(f.path, "a.py");
      assert.strictEqual(f.owner, c2);
    }
  });

  it("separate edits in one file make separate units; run IDs are stable across runs", async () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const b = base({ "a.txt": lines(...body) });
    const edited = [...body];
    edited[1] = "LINE 2";
    edited[17] = "LINE 18";
    const c1 = up.commit("two edits", { "a.txt": lines(...edited) });

    const first = (await extractFrom(up, b, c1)).result;
    const second = (await extractFrom(up, b, c1)).result;

    assert.lengthOf(first.files[0].hunks, 2);
    assert.lengthOf(unitsOf(first), 2);
    assert.deepEqual(
      first.runs.map((r) => r.id),
      second.runs.map((r) => r.id),
    );
  });

  describe("markdownSources", () => {
    it("holds the complete head text of a changed markdown file, including content outside every hunk", async () => {
      const top = [
        "# Title",
        "",
        "```ts",
        ...Array.from({ length: 12 }, (_, i) => `code ${i}`),
      ];
      const b = base({ "docs/guide.md": lines(...top, "end") });
      const c1 = up.commit("docs", {
        "docs/guide.md": lines(...top, "added in fence", "end"),
      });

      const { markdownSources, result } = await extractFrom(up, b, c1);

      assert.notInclude(
        result.files[0].hunks.flatMap((h) => h.lines.map((l) => l.text)),
        "```ts",
        "the fence opener is outside the hunk",
      );
      assert.deepEqual(markdownSources, [
        { path: "docs/guide.md", text: lines(...top, "added in fence", "end") },
      ]);
    });

    it("gives no entry to oversized, binary, deleted or non-markdown files", async () => {
      const b = base({ "old.md": lines("bye"), "keep.markdown": lines("a") });
      const c1 = up.commit("mixed", {
        "old.md": null,
        "big.md": "x".repeat(1024 * 1024 + 1),
        "nul.md": Buffer.from("a\0b\n"),
        "comp.mdx": lines("<X />"),
        "keep.markdown": lines("a", "b"),
        "README.MD": lines("upper"),
      });

      const { markdownSources } = await extractFrom(up, b, c1);

      assert.deepEqual(markdownSources.map((m) => m.path).sort(), [
        "README.MD",
        "keep.markdown",
      ]);
    });
  });

  describe("partial (blobless) clones", () => {
    let root: string;
    beforeEach(() => {
      root = tempDir("extract-cache");
    });
    afterEach(() => removeDir(root));

    it("hydrates missing blobs in one authenticated fetch with a current token, then reads with no further fetch", async () => {
      const b = base({
        "a.txt": lines("1", "2", "3"),
        "docs/x.md": lines("# x"),
      });
      const c1 = up.commit("c1", { "a.txt": lines("1", "two", "3") });
      const c2 = up.commit("c2", {
        "a.txt": lines("1", "two", "3", "4"),
        "docs/x.md": lines("# x", "more"),
      });
      up.checkout("main");

      const calls: string[][] = [];
      const spawn: GitSpawn = (argv, opts) => {
        calls.push(argv);
        return spawnGit(argv, opts);
      };
      const recording = new Git(spawn);
      let expired = false;
      const token = async () => (expired ? "ghs_reminted2" : "ghs_original1");
      const cache = new GitCache({ root, git: recording });
      const lease = await cache.checkout({
        org: "acme",
        repo: "widgets",
        prNumber: 3,
        headSha: c2,
        baseSha: b,
        remoteUrl: up.url,
        token,
        repoSizeKb: async () => 10,
        prCommits: async () => up.prCommits(b, c2),
      });
      const missing = await recording.run(["cat-file", "--batch-check"], {
        cwd: lease.dir,
        input: `${up.git("rev-parse", `${c2}:a.txt`)}\n`,
      });
      assert.match(missing, /missing/, "the clone starts without blobs");

      expired = true; // the cached installation token has expired since the clone
      const before = calls.length;
      const { result, markdownSources } = await extract({
        git: recording,
        gitDir: lease.dir,
        baseSha: b,
        headSha: c2,
        baseRef: "main",
        branch: "feature",
        repo: "widgets",
        auth: token,
      });
      lease.release();

      const network = calls
        .slice(before)
        .filter((argv) => argv.includes("fetch") || argv.includes("clone"));
      assert.lengthOf(network, 1, "exactly one fetch: the batch hydration");
      const basic = Buffer.from("x-access-token:ghs_reminted2").toString(
        "base64",
      );
      assert.include(
        network[0],
        `http.extraHeader=Authorization: Basic ${basic}`,
      );
      assert.include(network[0], "--stdin");
      assert.deepEqual(owners(result, "a.txt"), [
        ["-", "2", c1],
        ["+", "two", c1],
        ["+", "4", c2],
      ]);
      assert.deepEqual(markdownSources, [
        { path: "docs/x.md", text: lines("# x", "more") },
      ]);
    });

    it("caps the hydration fetch at the per-PR size and evicts down to the total cap on release", async () => {
      const b = base({ "a.txt": lines("1") });
      const c1 = up.commit("asset", { "big.bin": randomBytes(256 * 1024) });
      up.checkout("main");

      const cache = new GitCache({ root });
      const lease = await cache.checkout({
        org: "acme",
        repo: "widgets",
        prNumber: 4,
        headSha: c1,
        baseSha: b,
        remoteUrl: up.url,
        token: async () => "ghs_token",
        repoSizeKb: async () => 10,
        prCommits: async () => up.prCommits(b, c1),
      });
      cache.limits.perPrBytes = GitCache.sizeOf(lease.dir) + 64 * 1024;

      const err = await lease
        .withSizeCap((signal) =>
          extract({
            git,
            gitDir: lease.dir,
            baseSha: b,
            headSha: c1,
            baseRef: "main",
            branch: "feature",
            repo: "widgets",
            auth: async () => "ghs_token",
            signal,
          }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.instanceOf(err, CacheTooLargeError);

      cache.limits.totalBytes = 0;
      lease.release();
      await new Promise((resolve) => setImmediate(resolve));
      assert.isFalse(existsSync(lease.dir), "evicted once released");
    });
  });
});
