import jwt from "jsonwebtoken";

/**
 * Reads from GitHub as the marge-reviewer GitHub App: App JWT → installation
 * token (cached until shortly before its ~1 h expiry), then PR resolution over
 * the REST API. The same installation token also authenticates git fetches
 * (see gitCache.ts), which ask `tokenSource` for a current token every time.
 */

export type GitHubErrorCode = "pr_not_found" | "github_error";

export class GitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface PullRequestInfo {
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  /** The PR head commit, pinned for the run. */
  headSha: string;
  /** The merge base of the base branch and the head, pinned for the run. */
  baseSha: string;
  /** GitHub's commit count; never used to decide whether the diff is empty. */
  commits: number;
  /** Whether merge base → head changes any file. */
  hasNetDiff: boolean;
}

export interface PrCommit {
  sha: string;
  parents: string[];
}

export interface GitHubAppOptions {
  appId: string;
  /** PEM private key; literal "\n" sequences (as env vars often carry) are accepted. */
  privateKey: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

/** A token is re-minted once it is this close to expiring. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const NAME = /^[A-Za-z0-9._-]+$/;

interface CachedToken {
  token: string;
  expiresAt: number;
}

function checkName(org: string, repo: string): void {
  if (!NAME.test(org) || !NAME.test(repo))
    throw new GitHubError(
      "pr_not_found",
      `Not a GitHub repository: ${org}/${repo}`,
    );
}

export class GitHubApp {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<number, CachedToken>();
  private readonly minting = new Map<number, Promise<CachedToken>>();

  constructor(options: GitHubAppOptions) {
    this.appId = options.appId;
    this.privateKey = options.privateKey.replace(/\\n/g, "\n");
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** A current installation token for the repo, minted or from cache. */
  async installationToken(org: string, repo: string): Promise<string> {
    checkName(org, repo);
    const installationId = await this.installationId(org, repo);
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now())
      return cached.token;
    let pending = this.minting.get(installationId);
    if (!pending) {
      pending = this.mintToken(installationId).finally(() =>
        this.minting.delete(installationId),
      );
      this.minting.set(installationId, pending);
    }
    return (await pending).token;
  }

  /** A function the git helper calls before each network operation. */
  tokenSource(org: string, repo: string): () => Promise<string> {
    return () => this.installationToken(org, repo);
  }

  async resolvePullRequest(
    org: string,
    repo: string,
    prNumber: number,
  ): Promise<PullRequestInfo> {
    checkName(org, repo);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0)
      throw new GitHubError(
        "pr_not_found",
        `Not a pull request number: ${prNumber}`,
      );
    const pr = (await this.repoGet(org, repo, `/pulls/${prNumber}`)) as {
      title: string;
      html_url: string;
      state: string;
      commits: number;
      base: { ref: string; sha: string };
      head: { ref: string; sha: string };
    };
    if (pr.state !== "open")
      throw new GitHubError(
        "pr_not_found",
        `Pull request #${prNumber} is not open`,
        404,
      );
    // One compare call against the base branch's current tip yields both the
    // merge base and the net changed files. A branch whose commits cancel out
    // has commits but no files, so the file list — never the commit count —
    // decides whether there is a diff.
    const compare = (await this.repoGet(
      org,
      repo,
      `/compare/${encodeRef(pr.base.ref)}...${pr.head.sha}?per_page=1`,
    )) as { merge_base_commit: { sha: string }; files?: unknown[] };
    return {
      title: pr.title,
      url: pr.html_url,
      baseRef: pr.base.ref,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      baseSha: compare.merge_base_commit.sha,
      commits: pr.commits,
      hasNetDiff: (compare.files ?? []).length > 0,
    };
  }

  /** GitHub's reported repository size, in KB. */
  async repoSizeKb(org: string, repo: string): Promise<number> {
    checkName(org, repo);
    const body = (await this.repoGet(org, repo, "")) as { size: number };
    return body.size;
  }

  /** Every commit in base...head with its parents, across compare pages. */
  async compareCommits(
    org: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<PrCommit[]> {
    checkName(org, repo);
    const commits: PrCommit[] = [];
    let total = Infinity;
    for (let page = 1; commits.length < total; page += 1) {
      const body = (await this.repoGet(
        org,
        repo,
        `/compare/${baseSha}...${headSha}?per_page=100&page=${page}`,
      )) as {
        total_commits: number;
        commits: { sha: string; parents: { sha: string }[] }[];
      };
      total = body.total_commits;
      if (body.commits.length === 0) break;
      for (const c of body.commits)
        commits.push({ sha: c.sha, parents: c.parents.map((p) => p.sha) });
    }
    if (commits.length !== total)
      throw new GitHubError(
        "github_error",
        `GitHub listed ${commits.length} of the pull request's ${total} commits`,
      );
    return commits;
  }

  private async installationId(org: string, repo: string): Promise<number> {
    const key = `${org}/${repo}`.toLowerCase();
    const known = this.installations.get(key);
    if (known !== undefined) return known;
    const body = (await this.request(
      "GET",
      `/repos/${org}/${repo}/installation`,
      `Bearer ${this.appJwt()}`,
    )) as { id: number };
    this.installations.set(key, body.id);
    return body.id;
  }

  private async mintToken(installationId: number): Promise<CachedToken> {
    const body = (await this.request(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      `Bearer ${this.appJwt()}`,
    )) as { token: string; expires_at: string };
    const token = { token: body.token, expiresAt: Date.parse(body.expires_at) };
    this.tokens.set(installationId, token);
    return token;
  }

  private appJwt(): string {
    const nowSec = Math.floor(this.now() / 1000);
    // Backdated a minute for clock drift; GitHub caps App JWTs at 10 minutes.
    return jwt.sign(
      { iat: nowSec - 60, exp: nowSec + 540, iss: this.appId },
      this.privateKey,
      { algorithm: "RS256" },
    );
  }

  private async repoGet(org: string, repo: string, path: string) {
    const token = await this.installationToken(org, repo);
    return this.request(
      "GET",
      `/repos/${org}/${repo}${path}`,
      `Bearer ${token}`,
    );
  }

  private async request(
    method: string,
    path: string,
    authorization: string,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.github.com${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: authorization,
          "User-Agent": "marge-pr-reviewer",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (err) {
      throw new GitHubError(
        "github_error",
        `Could not reach GitHub: ${(err as Error).message}`,
      );
    }
    if (res.status === 404)
      throw new GitHubError(
        "pr_not_found",
        `GitHub: not found (${method} ${path})`,
        404,
      );
    if (!res.ok)
      throw new GitHubError(
        "github_error",
        `GitHub answered HTTP ${res.status} to ${method} ${path}`,
        res.status,
      );
    return res.json();
  }
}

/** A branch name for a URL path: each segment encoded, slashes kept. */
function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
