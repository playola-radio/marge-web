import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEMO_REPO } from "./demoFixture.js";
import { FixtureRepo } from "./fixtureRepo.js";
import {
  GitHubError,
  type GitHubSource,
  type PrCommit,
  type PullRequestInfo,
} from "./github.js";

/**
 * An offline stand-in for GitHub (the demo environment, via
 * `PR_REVIEWER_GITHUB=fake`). The canned repository (demoFixture.ts) is built on first use
 * into a real git repository under `root`, with fixed authors and dates so
 * its commit IDs are the same on every build, and served over file:// — so
 * the git cache and extraction run unchanged, with no network and no token.
 *
 * Pull requests are read live from the branches: moving a branch to its
 * `refs/pushed-later/<branch>` commits looks like a push. Deleting a
 * repository's directory resets it; the next request rebuilds it.
 */

export interface DemoCommit {
  message: string;
  /** Path → new content; null deletes the file. */
  files: Record<string, string | null>;
}

export interface DemoPull {
  number: number;
  title: string;
  headRef: string;
  commits: DemoCommit[];
  /** Built at `refs/pushed-later/<headRef>`, not yet on the branch. */
  pushedLater?: DemoCommit[];
}

export interface DemoRepo {
  org: string;
  repo: string;
  /** The `main` branch every pull request starts from. */
  history: DemoCommit[];
  pulls: DemoPull[];
}

const BASE_REF = "main";

export class FakeGitHub implements GitHubSource {
  constructor(private readonly root: string) {}

  async installationToken(org: string, repo: string): Promise<string> {
    this.find(org, repo);
    return "fake-installation-token";
  }

  remoteUrl(org: string, repo: string): string {
    return this.open(org, repo).url;
  }

  async resolvePullRequest(
    org: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestInfo> {
    const entry = this.find(org, repo);
    const pull = entry.pulls.find((p) => p.number === prNumber);
    if (!pull)
      throw new GitHubError(
        "pr_not_found",
        `No pull request #${prNumber} in ${org}/${repo}`,
        404,
      );
    const up = this.open(org, repo);
    const headSha = up.git("rev-parse", `refs/heads/${pull.headRef}`);
    const baseSha = up.mergeBase(`refs/heads/${BASE_REF}`, headSha);
    return {
      title: pull.title,
      url: `https://github.com/${entry.org}/${entry.repo}/pull/${prNumber}`,
      baseRef: BASE_REF,
      headRef: pull.headRef,
      headSha,
      baseSha,
      commits: up.prCommits(baseSha, headSha).length,
      hasNetDiff: up.git("diff", "--name-only", baseSha, headSha) !== "",
    };
  }

  /** Small, so the git cache always makes a blobless clone. */
  async repoSizeKb(org: string, repo: string): Promise<number> {
    this.find(org, repo);
    return 1;
  }

  async compareCommits(
    org: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<PrCommit[]> {
    return this.open(org, repo).prCommits(baseSha, headSha);
  }

  private find(org: string, repo: string): DemoRepo {
    const entry = DEMO_REPO;
    if (
      entry.org.toLowerCase() !== org.toLowerCase() ||
      entry.repo.toLowerCase() !== repo.toLowerCase()
    )
      throw new GitHubError(
        "pr_not_found",
        `GitHub: not found (${org}/${repo})`,
        404,
      );
    return entry;
  }

  /** The repository's directory, built first if it isn't there. */
  private open(org: string, repo: string): FixtureRepo {
    const entry = this.find(org, repo);
    const dir = join(this.root, entry.org, entry.repo);
    if (!existsSync(dir)) build(entry, dir);
    return FixtureRepo.open(dir);
  }
}

/** Builds beside `dir` and renames into place, so a half-built repo is never served. */
function build(entry: DemoRepo, dir: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  const partial = `${dir}.building-${randomBytes(4).toString("hex")}`;
  try {
    const up = FixtureRepo.create(partial);
    for (const c of entry.history) up.commit(c.message, c.files);
    for (const pull of entry.pulls) {
      up.checkout(pull.headRef, true);
      for (const c of pull.commits) up.commit(c.message, c.files);
      if (pull.pushedLater) {
        const head = up.head();
        for (const c of pull.pushedLater) up.commit(c.message, c.files);
        up.git("update-ref", `refs/pushed-later/${pull.headRef}`, "HEAD");
        up.git("reset", "-q", "--hard", head);
      }
      up.checkout(BASE_REF);
    }
    renameSync(partial, dir);
  } catch (err) {
    rmSync(partial, { recursive: true, force: true });
    throw err;
  }
}
