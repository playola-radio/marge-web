import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import type { PrCommit } from "./github.js";

// ---------------------------------------------------------------------------
// The git helper: every git subprocess the PR reviewer runs goes through it.
// It is also the credential-redaction boundary — no error it throws carries
// the token or its Authorization header value.
// ---------------------------------------------------------------------------

export interface GitSpawnOptions {
  cwd?: string;
  input?: string;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

/** Runs `git <argv>` and resolves with stdout; rejects on a non-zero exit. */
export type GitSpawn = (
  argv: string[],
  opts: GitSpawnOptions,
) => Promise<Buffer>;

export const spawnGit: GitSpawn = (argv, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", argv, {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.stdin.on("error", () => undefined); // git may exit before reading stdin
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(Buffer.concat(out));
      const stderr = Buffer.concat(err).toString("utf8");
      reject(
        new Error(
          `git ${argv.join(" ")} failed (${code ?? signal}): ${stderr.trim()}`,
        ),
      );
    });
    child.stdin.end(opts.input ?? "");
  });

/** A git failure whose message has every credential redacted. */
export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

const REDACTED = "[REDACTED]";

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets)
    if (secret) out = out.split(secret).join(REDACTED);
  return out
    .replace(
      /(Authorization:\s*(?:Basic|Bearer|token)\s+)[^\s'"]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/x-access-token:[^@\s'"]+/g, `x-access-token:${REDACTED}`)
    .replace(/\bgh[opsu]_[A-Za-z0-9]{8,}/g, REDACTED);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
  ])
    delete env[key];
  return {
    ...env,
    // Never prompt, never read the host's git config, and never fetch a
    // missing object behind our back: every fetch is explicit and authenticated.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_LAZY_FETCH: "1",
    LC_ALL: "C",
  };
}

export interface GitRunOptions {
  cwd?: string;
  /** Network operations pass this; it is asked for a current token per invocation. */
  auth?: () => Promise<string>;
  input?: string;
  signal?: AbortSignal;
}

export class Git {
  constructor(private readonly spawnFn: GitSpawn = spawnGit) {}

  async run(args: string[], opts: GitRunOptions = {}): Promise<string> {
    return (await this.runRaw(args, opts)).toString("utf8");
  }

  async runRaw(args: string[], opts: GitRunOptions = {}): Promise<Buffer> {
    const secrets: string[] = [];
    const argv = ["-c", "credential.helper="];
    if (opts.auth) {
      const token = await opts.auth();
      const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
      secrets.push(token, basic);
      // Per invocation only: never in the remote URL, the config, or on disk.
      argv.push("-c", `http.extraHeader=Authorization: Basic ${basic}`);
    }
    argv.push(...args);
    try {
      return await this.spawnFn(argv, {
        cwd: opts.cwd,
        input: opts.input,
        signal: opts.signal,
        env: gitEnv(),
      });
    } catch (err) {
      // Rebuilt from scratch rather than wrapped: the original error (and its
      // `cmd`/`spawnargs`) embeds the full command line, extraHeader included.
      const message = (err as { message?: unknown }).message ?? err;
      throw new GitError(redact(String(message), secrets));
    }
  }
}

// ---------------------------------------------------------------------------
// The bounded git cache: one bare repository per (org, repo, PR).
// ---------------------------------------------------------------------------

export const DEFAULT_PER_PR_BYTES = 512 * 1024 * 1024;
export const DEFAULT_TOTAL_BYTES = 1024 * 1024 * 1024;
/** Repos GitHub reports above this (in KB) get a PR-only shallow fetch. */
export const PR_ONLY_ABOVE_KB = 1024 * 1024;
const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
const SIZE_POLL_MS = 200;
const NAME = /^[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const FETCH_FLAGS = [
  "fetch",
  "--quiet",
  "--no-tags",
  "--refmap=",
  "--no-write-fetch-head",
  "--no-auto-gc",
  "--no-prune",
  "--recurse-submodules=no",
];

export class GitCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCacheError";
  }
}

/** A fetch pushed the PR's directory over the per-PR size cap. */
export class CacheTooLargeError extends GitCacheError {}

export interface PrSource {
  org: string;
  repo: string;
  prNumber: number;
  /** The run's pinned PR head. */
  headSha: string;
  /** The run's pinned merge base. */
  baseSha: string;
  /** HTTPS clone URL, with no credentials in it. */
  remoteUrl: string;
  /** A current installation token; asked again before every network operation. */
  token: () => Promise<string>;
  /** GitHub's repository size in KB; consulted only when creating a directory. */
  repoSizeKb: () => Promise<number>;
  /** The PR's commits with parents (GitHub compare); consulted only in PR-only mode. */
  prCommits: () => Promise<PrCommit[]>;
}

type CacheMode = "blobless" | "pr-only";

export interface CacheLease {
  /** The bare repository; stays pinned (never evicted) until `release()`. */
  dir: string;
  /** Runs `work` (e.g. extraction's blob hydration) under the per-PR size cap. */
  withSizeCap<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Unpins the directory and evicts down to the total cap; the last lease
   * out drops a directory left over the per-PR cap (e.g. by hydration).
   */
  release(): void;
}

export interface GitCacheOptions {
  root: string;
  perPrBytes?: number;
  totalBytes?: number;
  git?: Git;
}

export class GitCache {
  readonly root: string;
  readonly git: Git;
  readonly limits: { perPrBytes: number; totalBytes: number };
  private readonly pins = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly lastUsed = new Map<string, number>();
  private clock = 0;

  constructor(options: GitCacheOptions) {
    this.root = options.root;
    this.git = options.git ?? new Git();
    this.limits = {
      perPrBytes: options.perPrBytes ?? DEFAULT_PER_PR_BYTES,
      totalBytes: options.totalBytes ?? DEFAULT_TOTAL_BYTES,
    };
  }

  /** Total bytes of everything under `path` (0 when it doesn't exist). */
  static sizeOf(path: string): number {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return 0;
    }
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return 0;
    }
    for (const name of names) total += GitCache.sizeOf(join(path, name));
    return total;
  }

  /**
   * Makes sure the PR's pinned head and merge base are in its cache directory
   * (cloning or fetching as needed) and pins the directory until released.
   */
  async checkout(src: PrSource): Promise<CacheLease> {
    if (
      !NAME.test(src.org) ||
      !NAME.test(src.repo) ||
      [src.org, src.repo].some((n) => n === "." || n === "..")
    )
      throw new GitCacheError(`Not a repository name: ${src.org}/${src.repo}`);
    if (!Number.isSafeInteger(src.prNumber) || src.prNumber <= 0)
      throw new GitCacheError(`Not a pull request number: ${src.prNumber}`);
    if (!SHA.test(src.headSha) || !SHA.test(src.baseSha))
      throw new GitCacheError("The pull request's commit IDs are malformed");

    const dir = join(
      this.root,
      src.org.toLowerCase(),
      src.repo.toLowerCase(),
      `pr-${src.prNumber}.git`,
    );
    const refs = {
      headRef: `refs/chapters/pr/${src.prNumber}/head`,
      baseRef: `refs/chapters/pr/${src.prNumber}/base`,
    };
    this.pin(dir);
    try {
      await this.withLock(dir, () => this.prepare(src, dir, refs));
      this.touch(dir);
      await this.evict();
      let released = false;
      return {
        dir,
        withSizeCap: (work) => this.withSizeCap(dir, work),
        release: () => {
          if (released) return;
          released = true;
          this.touch(dir);
          this.unpin(dir);
          if (
            !this.pins.get(dir) &&
            GitCache.sizeOf(dir) > this.limits.perPrBytes
          )
            rmSync(dir, { recursive: true, force: true });
          // Best effort: the next checkout evicts again.
          this.evict().catch(() => undefined);
        },
      };
    } catch (err) {
      this.unpin(dir);
      throw err;
    }
  }

  /** Removes least-recently-used idle directories until the total fits the cap. */
  async evict(): Promise<void> {
    const entries = this.cachedDirs().map((dir) => ({
      dir,
      size: GitCache.sizeOf(dir),
      // Directories this process hasn't used (left by an earlier boot) rank
      // older than any it has, in the order their mtimes give.
      lastUsed: this.lastUsed.get(dir) ?? lstatSync(dir).mtimeMs - Date.now(),
    }));
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    const idle = entries
      .filter((e) => !this.pins.get(e.dir))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (total <= this.limits.totalBytes) break;
      rmSync(entry.dir, { recursive: true, force: true });
      this.lastUsed.delete(entry.dir);
      total -= entry.size;
    }
  }

  private async prepare(
    src: PrSource,
    dir: string,
    refs: { headRef: string; baseRef: string },
  ): Promise<void> {
    if (existsSync(dir)) {
      const shallow = await this.git.run(
        ["rev-parse", "--is-shallow-repository"],
        { cwd: dir },
      );
      // Only a PR-only repo is shallow; a directory keeps the mode it was made in.
      const mode: CacheMode =
        shallow.trim() === "true" ? "pr-only" : "blobless";
      try {
        await this.withSizeCap(dir, (signal) =>
          this.pinCommits(src, dir, mode, refs, signal),
        );
      } catch (err) {
        // An over-cap directory is dropped unless another lease is reading it.
        if (err instanceof CacheTooLargeError && this.pins.get(dir) === 1)
          rmSync(dir, { recursive: true, force: true });
        throw err;
      }
      return;
    }

    const parent = dirname(dir);
    mkdirSync(parent, { recursive: true });
    this.removeStalePartials(parent);
    // Built beside the final path and renamed into place, so an interrupted
    // clone never looks like a usable directory.
    const partial = `${dir}.partial-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      const mode: CacheMode =
        (await src.repoSizeKb()) > PR_ONLY_ABOVE_KB ? "pr-only" : "blobless";
      await this.withSizeCap(partial, async (signal) => {
        if (mode === "blobless") {
          await this.git.run(
            [
              "clone",
              "--bare",
              "--quiet",
              "--no-tags",
              "--filter=blob:none",
              "--",
              src.remoteUrl,
              partial,
            ],
            { auth: src.token, signal },
          );
        } else {
          await this.git.run(["init", "--bare", "--quiet", partial]);
          for (const [key, value] of [
            ["core.repositoryformatversion", "1"],
            ["remote.origin.url", src.remoteUrl],
            ["remote.origin.promisor", "true"],
            ["remote.origin.partialclonefilter", "blob:none"],
          ])
            await this.git.run(["config", key, value], { cwd: partial });
        }
        // Auto-gc in a partial clone races concurrent fetches; the cache is evicted, not gc'd.
        await this.git.run(["config", "gc.auto", "0"], { cwd: partial });
        await this.git.run(["config", "maintenance.auto", "false"], {
          cwd: partial,
        });
        await this.pinCommits(src, partial, mode, refs, signal);
      });
      renameSync(partial, dir);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      throw err;
    }
  }

  /** Points the PR's private refs at the pinned SHAs, fetching what's missing. */
  private async pinCommits(
    src: PrSource,
    dir: string,
    mode: CacheMode,
    refs: { headRef: string; baseRef: string },
    signal: AbortSignal,
  ): Promise<void> {
    const wanted: [string, string][] = [
      [src.baseSha, refs.baseRef],
      [src.headSha, refs.headRef],
    ];
    const missing = new Set<string>();
    for (const [sha, ref] of wanted) {
      if (await this.hasCommit(dir, sha))
        await this.git.run(["update-ref", ref, sha], { cwd: dir });
      else missing.add(sha);
    }
    if (missing.size === 0) return;

    let prCommits: PrCommit[] | null = null;
    if (mode === "blobless") {
      await this.fetch(
        src,
        dir,
        ["--filter=blob:none"],
        wanted
          .filter(([sha]) => missing.has(sha))
          .map(([sha, ref]) => `+${sha}:${ref}`),
        signal,
      );
    } else {
      // No deepening, ever: a PR whose history doesn't connect to the merge
      // base fails here, before anything big is fetched.
      prCommits = await src.prCommits();
      checkConnected(src, prCommits);
      if (missing.has(src.baseSha))
        await this.fetch(
          src,
          dir,
          ["--filter=blob:none", "--depth=1"],
          [`+${src.baseSha}:${refs.baseRef}`],
          signal,
        );
      // By SHA and with no depth: it stops at the merge base, so it brings
      // exactly the PR's commits.
      if (missing.has(src.headSha))
        await this.fetch(
          src,
          dir,
          ["--filter=blob:none"],
          [`+${src.headSha}:${refs.headRef}`],
          signal,
        );
    }

    try {
      await this.git.run(
        ["merge-base", "--is-ancestor", src.baseSha, src.headSha],
        { cwd: dir },
      );
    } catch {
      throw new GitCacheError(
        `The merge base of pull request #${src.prNumber} isn't an ancestor of its head`,
      );
    }
    if (prCommits) {
      const count = await this.git.run(
        ["rev-list", "--count", `${src.baseSha}..${src.headSha}`],
        { cwd: dir },
      );
      if (Number(count.trim()) !== prCommits.length)
        throw new GitCacheError(
          `Fetched ${count.trim()} commits for pull request #${src.prNumber}, but GitHub lists ${prCommits.length}`,
        );
    }
  }

  private fetch(
    src: PrSource,
    dir: string,
    flags: string[],
    refspecs: string[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.git.run(
      [...FETCH_FLAGS, ...flags, "--end-of-options", "origin", ...refspecs],
      { cwd: dir, auth: src.token, signal },
    );
  }

  /** Asks without triggering a lazy fetch: `?<sha>` means the commit is missing. */
  private async hasCommit(dir: string, sha: string): Promise<boolean> {
    try {
      const out = await this.git.run(
        ["rev-list", "--no-walk", "--missing=print", sha],
        { cwd: dir },
      );
      return out.trim() === sha;
    } catch {
      return false;
    }
  }

  private async withSizeCap<T>(
    dir: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const cap = this.limits.perPrBytes;
    const controller = new AbortController();
    let over = false;
    const timer = setInterval(() => {
      if (GitCache.sizeOf(dir) > cap) {
        over = true;
        controller.abort();
      }
    }, SIZE_POLL_MS);
    const tooLarge = () =>
      new CacheTooLargeError(
        `This pull request's repository is too large for the review cache (over ${formatBytes(cap)})`,
      );
    let result: T;
    try {
      result = await work(controller.signal);
    } catch (err) {
      if (over) throw tooLarge();
      throw err;
    } finally {
      clearInterval(timer);
    }
    if (GitCache.sizeOf(dir) > cap) throw tooLarge();
    return result;
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return result;
  }

  private pin(dir: string): void {
    this.pins.set(dir, (this.pins.get(dir) ?? 0) + 1);
  }

  private unpin(dir: string): void {
    const n = (this.pins.get(dir) ?? 1) - 1;
    if (n > 0) this.pins.set(dir, n);
    else this.pins.delete(dir);
  }

  private touch(dir: string): void {
    this.clock = Math.max(Date.now(), this.clock + 1);
    this.lastUsed.set(dir, this.clock);
  }

  private cachedDirs(): string[] {
    const dirs: string[] = [];
    const children = (path: string) => {
      try {
        return readdirSync(path, { withFileTypes: true }).filter((e) =>
          e.isDirectory(),
        );
      } catch {
        return [];
      }
    };
    for (const org of children(this.root))
      for (const repo of children(join(this.root, org.name)))
        for (const pr of children(join(this.root, org.name, repo.name)))
          if (/^pr-\d+\.git$/.test(pr.name))
            dirs.push(join(this.root, org.name, repo.name, pr.name));
    return dirs;
  }

  /** Clears `.partial-*` directories that an interrupted run left behind. */
  private removeStalePartials(parent: string): void {
    for (const name of readdirSync(parent)) {
      if (!/^pr-\d+\.git\.partial-\d+-[0-9a-f]{8}$/.test(name)) continue;
      const path = join(parent, name);
      try {
        if (Date.now() - lstatSync(path).mtimeMs > PARTIAL_MAX_AGE_MS)
          rmSync(path, { recursive: true, force: true });
      } catch {
        // Another run removed it first.
      }
    }
  }
}

/** Every parent of a PR commit must be another PR commit or the merge base. */
function checkConnected(src: PrSource, commits: PrCommit[]): void {
  for (const c of commits)
    if (!SHA.test(c.sha) || !c.parents.every((p) => SHA.test(p)))
      throw new GitCacheError("GitHub returned a malformed commit ID");
  const shas = new Set(commits.map((c) => c.sha));
  if (!shas.has(src.headSha))
    throw new GitCacheError(
      `GitHub's commit list for pull request #${src.prNumber} doesn't include its head commit`,
    );
  for (const c of commits)
    for (const parent of c.parents)
      if (!shas.has(parent) && parent !== src.baseSha)
        throw new GitCacheError(
          `Pull request #${src.prNumber} merges its base branch into itself. ` +
            `This repository is too large to fetch that branch's history, so the pull request can't be read as chapters.`,
        );
}

function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value)} ${units[unit]}`;
}
