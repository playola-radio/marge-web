import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const BASE_TIME = Date.parse("2026-01-01T00:00:00Z") / 1000;

/**
 * A working repository whose commits get fixed authors and increasing dates,
 * so the same commits always get the same SHAs. It serves as the "GitHub"
 * upstream for tests and for the demo's FakeGitHub: filters and any-SHA wants
 * are on, and `url` is a file:// URL so fetches really are partial and shallow.
 */
export class FixtureRepo {
  private tick = 0;

  private constructor(readonly dir: string) {}

  /** A new repository in `dir` (which must not exist yet), or in a fresh temp directory. */
  static create(dir?: string): FixtureRepo {
    if (dir) mkdirSync(dir, { recursive: true });
    else dir = mkdtempSync(join(tmpdir(), "pr-reviewer-upstream-"));
    const repo = new FixtureRepo(dir);
    repo.git("init", "-q", "-b", "main");
    repo.git("config", "user.name", "Fixture Author");
    repo.git("config", "user.email", "author@example.com");
    repo.git("config", "commit.gpgsign", "false");
    repo.git("config", "uploadpack.allowFilter", "true");
    repo.git("config", "uploadpack.allowAnySHA1InWant", "true");
    return repo;
  }

  /** An existing repository built by `create`. */
  static open(dir: string): FixtureRepo {
    return new FixtureRepo(dir);
  }

  get url(): string {
    return `file://${this.dir}`;
  }

  git(...args: string[]): string {
    this.tick += 1;
    const date = `${BASE_TIME + this.tick * 60} +0000`;
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture Author",
        GIT_AUTHOR_EMAIL: "author@example.com",
        GIT_COMMITTER_NAME: "Fixture Author",
        GIT_COMMITTER_EMAIL: "author@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    }).trim();
  }

  write(path: string, content: string | Buffer): this {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return this;
  }

  /** Writes the given files (null deletes one), commits everything, returns the SHA. */
  commit(
    message: string,
    files: Record<string, string | Buffer | null> = {},
  ): string {
    for (const [path, content] of Object.entries(files)) {
      if (content === null) this.git("rm", "-q", "--", path);
      else this.write(path, content);
    }
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.head();
  }

  head(): string {
    return this.git("rev-parse", "HEAD");
  }

  checkout(branch: string, create = false): this {
    if (create) this.git("checkout", "-q", "-b", branch);
    else this.git("checkout", "-q", branch);
    return this;
  }

  merge(branch: string, message: string): string {
    this.git("merge", "-q", "--no-ff", "-m", message, branch);
    return this.head();
  }

  mergeBase(a: string, b: string): string {
    return this.git("merge-base", a, b);
  }

  /** What GitHub's compare API reports: base...head commits with parents. */
  prCommits(base: string, head: string): { sha: string; parents: string[] }[] {
    const out = this.git(
      "rev-list",
      "--reverse",
      "--parents",
      `${base}..${head}`,
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, ...parents] = line.split(" ");
        return { sha, parents };
      });
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
