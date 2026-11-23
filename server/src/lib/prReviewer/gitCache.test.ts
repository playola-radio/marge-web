import { assert } from "chai";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Git,
  GitCache,
  GitCacheError,
  GitError,
  spawnGit,
  type GitSpawn,
  type PrSource,
} from "./gitCache.js";
import { FixtureRepo, lines, removeDir, tempDir } from "./repoFixtures.test.js";

/** Wraps the real git spawner and records every argv it is handed. */
function recordingGit(): { git: Git; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: GitSpawn = (argv, opts) => {
    calls.push(argv);
    return spawnGit(argv, opts);
  };
  return { git: new Git(spawn), calls };
}

function basicAuth(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString("base64");
}

function isNetworkOp(argv: string[]): boolean {
  return argv.includes("fetch") || argv.includes("clone");
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** A small upstream with one open PR: `feature` off `main`. */
function smallUpstream() {
  const up = FixtureRepo.create();
  up.commit("base", {
    "README.md": lines("# Widgets"),
    "src/a.ts": lines("a"),
  });
  const base = up.head();
  up.checkout("feature", true);
  up.commit("add b", { "src/b.ts": lines("b") });
  const head = up.commit("edit a", { "src/a.ts": lines("a", "aa") });
  up.checkout("main");
  return { up, base, head };
}

function source(
  up: FixtureRepo,
  overrides: Partial<PrSource> & Pick<PrSource, "headSha" | "baseSha">,
): PrSource {
  return {
    org: "acme",
    repo: "widgets",
    prNumber: 7,
    remoteUrl: up.url,
    token: async () => "tok-static",
    repoSizeKb: async () => 100,
    prCommits: async () => up.prCommits(overrides.baseSha, overrides.headSha),
    ...overrides,
  };
}

describe("GitCache", () => {
  let root: string;
  const upstreams: FixtureRepo[] = [];

  beforeEach(() => {
    root = tempDir("cache");
  });
  afterEach(() => {
    removeDir(root);
    while (upstreams.length) upstreams.pop()!.remove();
  });

  it("clones a small repo blobless, pins the run's SHAs, and reuses the directory on a second fetch", async () => {
    const { up, base, head } = smallUpstream();
    upstreams.push(up);
    const { git, calls } = recordingGit();
    const cache = new GitCache({ root, git });

    const first = await cache.checkout(
      source(up, { headSha: head, baseSha: base }),
    );
    assert.strictEqual(first.mode, "blobless");
    const clone = calls.find((c) => c.includes("clone"))!;
    assert.include(clone, "--filter=blob:none");
    assert.strictEqual(
      (await git.run(["rev-parse", first.headRef], { cwd: first.dir })).trim(),
      head,
    );
    assert.strictEqual(
      (await git.run(["rev-parse", first.baseRef], { cwd: first.dir })).trim(),
      base,
    );
    first.release();

    const before = calls.length;
    const second = await cache.checkout(
      source(up, { headSha: head, baseSha: base }),
    );
    assert.strictEqual(second.dir, first.dir);
    assert.isFalse(
      calls.slice(before).some(isNetworkOp),
      "nothing is cloned or fetched again",
    );
    second.release();
  });

  it("evicts the least-recently-used idle directory and never a pinned one", async () => {
    const { up, base, head } = smallUpstream();
    upstreams.push(up);
    const cache = new GitCache({ root });
    const src = (prNumber: number) =>
      source(up, { prNumber, headSha: head, baseSha: base });

    const pinned = await cache.checkout(src(1)); // oldest, still in use
    const idleOld = await cache.checkout(src(2));
    idleOld.release();
    const idleNew = await cache.checkout(src(3));
    idleNew.release();

    const size = Math.max(
      ...[pinned, idleOld, idleNew].map((l) => GitCache.sizeOf(l.dir)),
    );
    // Room for three directories, so a fourth forces exactly one eviction.
    cache.limits.totalBytes = Math.floor(size * 3.5);
    const fourth = await cache.checkout(src(4));

    assert.isTrue(existsSync(pinned.dir), "pinned directory survives");
    assert.isFalse(existsSync(idleOld.dir), "LRU idle directory evicted");
    assert.isTrue(existsSync(idleNew.dir));
    assert.isTrue(existsSync(fourth.dir));
    pinned.release();
    fourth.release();
  });

  it("aborts a fetch that exceeds the per-PR size cap and leaves no directory", async () => {
    const { up, base, head } = smallUpstream();
    upstreams.push(up);
    const cache = new GitCache({ root, perPrBytes: 1024 });

    const err = await cache
      .checkout(source(up, { headSha: head, baseSha: base }))
      .then(
        () => null,
        (e: unknown) => e,
      );

    assert.instanceOf(err, GitCacheError);
    assert.match((err as Error).message, /too large/);
    assert.deepEqual(allFiles(root), []);
  });

  describe("git authentication", () => {
    it("passes the current token per invocation as an extraHeader, never in the URL or on disk, and re-mints after expiry", async () => {
      const { up, base, head } = smallUpstream();
      upstreams.push(up);
      const { git, calls } = recordingGit();
      const cache = new GitCache({ root, git });
      let expired = false;
      const token = async () => (expired ? "ghs_fresh222" : "ghs_first111");

      const lease = await cache.checkout(
        source(up, { headSha: head, baseSha: base, token }),
      );
      const network = calls.filter(isNetworkOp);
      assert.isNotEmpty(network);
      for (const argv of network) {
        assert.include(
          argv,
          `http.extraHeader=Authorization: Basic ${basicAuth("ghs_first111")}`,
        );
        assert.isFalse(
          argv.some((a) => a.includes(`ghs_first111@`)),
          "token never in a URL",
        );
      }
      const remote = (
        await git.run(["config", "--get", "remote.origin.url"], {
          cwd: lease.dir,
        })
      ).trim();
      assert.strictEqual(remote, up.url);
      for (const file of allFiles(root)) {
        const text = readFileSync(file).toString("latin1");
        assert.notInclude(text, "ghs_first111", file);
        assert.notInclude(text, basicAuth("ghs_first111"), file);
      }
      lease.release();

      // The PR moves on and the cached token expires: the next fetch mints anew.
      up.checkout("feature");
      const newHead = up.commit("more", { "src/c.ts": lines("c") });
      up.checkout("main");
      expired = true;
      const before = calls.length;
      const again = await cache.checkout(
        source(up, { headSha: newHead, baseSha: base, token }),
      );
      const fetches = calls.slice(before).filter(isNetworkOp);
      assert.lengthOf(fetches, 1);
      assert.include(
        fetches[0],
        `http.extraHeader=Authorization: Basic ${basicAuth("ghs_fresh222")}`,
      );
      again.release();
    });

    it("redacts the token and its Authorization value from a failing fetch's error", async () => {
      const cache = new GitCache({ root });
      const token = "ghs_secretSECRET123";
      const err = await cache
        .checkout({
          org: "acme",
          repo: "widgets",
          prNumber: 7,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          remoteUrl: `file://${root}/no-such-upstream`,
          token: async () => token,
          repoSizeKb: async () => 100,
          prCommits: async () => [],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );

      assert.instanceOf(err, GitError);
      const e = err as GitError;
      const everything = JSON.stringify({
        message: e.message,
        stack: e.stack,
        ...e,
      });
      assert.notInclude(everything, token);
      assert.notInclude(everything, basicAuth(token));
      assert.include(e.message, "[REDACTED]");
    });
  });

  describe("PR-only mode for very large repositories", () => {
    const huge = async () => 2 * 1024 * 1024; // 2 GiB in KB

    it("fetches only the merge base and the PR's commits into a shallow repository", async () => {
      const { up, base, head } = smallUpstream();
      upstreams.push(up);
      const { git } = recordingGit();
      const cache = new GitCache({ root, git });

      const lease = await cache.checkout(
        source(up, { headSha: head, baseSha: base, repoSizeKb: huge }),
      );
      assert.strictEqual(lease.mode, "pr-only");
      const shallow = await git.run(["rev-parse", "--is-shallow-repository"], {
        cwd: lease.dir,
      });
      assert.strictEqual(shallow.trim(), "true");
      const count = await git.run(["rev-list", "--count", `${base}..${head}`], {
        cwd: lease.dir,
      });
      assert.strictEqual(count.trim(), "2");
      lease.release();
    });

    it("fails a PR that merges its base branch into itself before fetching anything", async () => {
      const up = FixtureRepo.create();
      upstreams.push(up);
      up.commit("m1", { "a.txt": lines("1") });
      up.checkout("feature", true);
      up.commit("f1", { "f.txt": lines("f1") });
      up.checkout("main");
      up.commit("m2", { "a.txt": lines("1", "2") });
      up.checkout("feature");
      up.merge("main", "Merge main into feature");
      const head = up.commit("f2", { "f.txt": lines("f1", "f2") });
      const mergeBase = up.mergeBase("main", head);
      up.checkout("main");

      const { git, calls } = recordingGit();
      const cache = new GitCache({ root, git });
      const err = await cache
        .checkout(
          source(up, { headSha: head, baseSha: mergeBase, repoSizeKb: huge }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );

      assert.instanceOf(err, GitCacheError);
      assert.match(
        (err as Error).message,
        /Pull request #7 merges its base branch into itself/,
      );
      assert.isFalse(calls.some(isNetworkOp), "no fetch ran at all");
      assert.deepEqual(allFiles(root), []);
    });
  });

  it("refuses names that could escape the cache root", async () => {
    const cache = new GitCache({ root });
    for (const [org, repo] of [
      ["..", "x"],
      ["acme", "../../etc"],
      ["acme", "."],
      ["ac/me", "x"],
    ]) {
      const err = await cache
        .checkout({
          org,
          repo,
          prNumber: 1,
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          remoteUrl: "file:///dev/null",
          token: async () => "t",
          repoSizeKb: async () => 1,
          prCommits: async () => [],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.instanceOf(err, GitCacheError, `${org}/${repo}`);
    }
    assert.isTrue(statSync(root).isDirectory());
  });
});
