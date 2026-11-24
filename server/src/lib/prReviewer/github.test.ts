import { assert } from "chai";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { GitHubApp, GitHubError } from "./github.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const HEAD = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);
const BASE_TIP = "c".repeat(40);

type Handler = (req: {
  method: string;
  path: string;
  auth: string | null;
}) => { status: number; body: unknown } | undefined;

/** A stand-in for api.github.com: routes each request to `handler` and records it. */
function fakeGitHub(handler: Handler) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const req = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      auth: headers.get("authorization"),
    };
    calls.push(req);
    const res = handler(req) ?? {
      status: 404,
      body: { message: "Not Found" },
    };
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

/** The usual routes: one installation, tokens that last an hour, PR 7 open. */
function standardRoutes(
  opts: {
    clock: () => number;
    compareFiles?: unknown[];
    prState?: string;
  } = { clock: () => Date.now() },
): Handler {
  let minted = 0;
  return (req) => {
    if (req.method === "GET" && req.path === "/repos/acme/widgets/installation")
      return { status: 200, body: { id: 42 } };
    if (
      req.method === "POST" &&
      req.path === "/app/installations/42/access_tokens"
    ) {
      minted += 1;
      return {
        status: 201,
        body: {
          token: `ghs_token${minted}`,
          expires_at: new Date(opts.clock() + 60 * 60 * 1000).toISOString(),
        },
      };
    }
    if (req.method === "GET" && req.path === "/repos/acme/widgets/pulls/7")
      return {
        status: 200,
        body: {
          title: "Make widgets spin",
          html_url: "https://github.com/acme/widgets/pull/7",
          state: opts.prState ?? "open",
          commits: 3,
          base: { ref: "main", sha: BASE_TIP },
          head: { ref: "feature/spin", sha: HEAD },
        },
      };
    if (
      req.method === "GET" &&
      req.path.startsWith(`/repos/acme/widgets/compare/main...${HEAD}`)
    )
      return {
        status: 200,
        body: {
          merge_base_commit: { sha: MERGE_BASE },
          ahead_by: 3,
          total_commits: 3,
          commits: [],
          files: opts.compareFiles ?? [{ filename: "src/spin.ts" }],
        },
      };
    return undefined;
  };
}

function makeApp(fetchFn: typeof fetch, clock: () => number) {
  return new GitHubApp({
    appId: "12345",
    // Render stores multi-line secrets with literal "\n"; the app accepts either form.
    privateKey: privateKey.replace(/\n/g, "\\n"),
    fetch: fetchFn,
    now: clock,
  });
}

describe("GitHubApp", () => {
  describe("installation tokens", () => {
    it("authenticates as the App with an RS256 JWT and mints an installation token", async () => {
      const now = Date.parse("2026-11-23T12:00:00Z");
      const clock = () => now;
      const gh = fakeGitHub(standardRoutes({ clock }));
      const app = makeApp(gh.fetchFn, clock);

      const token = await app.installationToken("acme", "widgets");

      assert.strictEqual(token, "ghs_token1");
      const appCalls = gh.calls.filter((c) => c.auth?.startsWith("Bearer ey"));
      assert.lengthOf(appCalls, 2);
      const appJwt = appCalls[0].auth!.slice("Bearer ".length);
      const claims = jwt.verify(appJwt, publicKey, {
        algorithms: ["RS256"],
        clockTimestamp: now / 1000,
      }) as jwt.JwtPayload;
      assert.strictEqual(claims.iss, "12345");
      assert.isAtMost(claims.exp! - now / 1000, 600);
    });

    it("reuses the cached token until it nears its one-hour expiry, then mints a fresh one", async () => {
      let now = Date.parse("2026-11-23T12:00:00Z");
      const clock = () => now;
      const gh = fakeGitHub(standardRoutes({ clock }));
      const app = makeApp(gh.fetchFn, clock);

      assert.strictEqual(
        await app.installationToken("acme", "widgets"),
        "ghs_token1",
      );
      now += 30 * 60 * 1000;
      assert.strictEqual(
        await app.installationToken("acme", "widgets"),
        "ghs_token1",
      );
      now += 31 * 60 * 1000; // past the token's expiry
      assert.strictEqual(
        await app.installationToken("acme", "widgets"),
        "ghs_token2",
      );
      assert.lengthOf(
        gh.calls.filter((c) => c.method === "POST"),
        2,
        "minted exactly twice",
      );
    });

    it("answers pr_not_found when the App is not installed on the repo", async () => {
      const gh = fakeGitHub(() => undefined);
      const app = makeApp(gh.fetchFn, () => Date.now());
      const err = await app.installationToken("acme", "secret").then(
        () => null,
        (e: unknown) => e,
      );
      assert.instanceOf(err, GitHubError);
      assert.strictEqual((err as GitHubError).code, "pr_not_found");
    });
  });

  describe("resolvePullRequest", () => {
    it("resolves title, url, refs, pinned head and merge-base SHAs, and commit count", async () => {
      const clock = () => Date.now();
      const gh = fakeGitHub(standardRoutes({ clock }));
      const app = makeApp(gh.fetchFn, clock);

      const pr = await app.resolvePullRequest("acme", "widgets", 7);

      assert.deepEqual(pr, {
        title: "Make widgets spin",
        url: "https://github.com/acme/widgets/pull/7",
        baseRef: "main",
        headRef: "feature/spin",
        headSha: HEAD,
        baseSha: MERGE_BASE,
        commits: 3,
        hasNetDiff: true,
      });
      const repoCalls = gh.calls.filter((c) => c.path.startsWith("/repos/"));
      assert.isTrue(
        repoCalls
          .filter((c) => !c.path.endsWith("/installation"))
          .every((c) => c.auth === "Bearer ghs_token1"),
        "PR reads use the installation token",
      );
      assert.lengthOf(
        gh.calls.filter((c) => c.path.includes("/compare/")),
        1,
        "merge base and net diff come from one compare call",
      );
    });

    it("reports hasNetDiff false when commits exist but cancel out (change then revert)", async () => {
      const clock = () => Date.now();
      const gh = fakeGitHub(standardRoutes({ clock, compareFiles: [] }));
      const pr = await makeApp(gh.fetchFn, clock).resolvePullRequest(
        "acme",
        "widgets",
        7,
      );
      assert.strictEqual(pr.commits, 3);
      assert.isFalse(pr.hasNetDiff);
    });

    it("answers pr_not_found on a 404", async () => {
      const clock = () => Date.now();
      const gh = fakeGitHub(standardRoutes({ clock }));
      const err = await makeApp(gh.fetchFn, clock)
        .resolvePullRequest("acme", "widgets", 999)
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.instanceOf(err, GitHubError);
      assert.strictEqual((err as GitHubError).code, "pr_not_found");
    });

    it("answers pr_not_found for a PR that is no longer open", async () => {
      const clock = () => Date.now();
      const gh = fakeGitHub(standardRoutes({ clock, prState: "closed" }));
      const err = await makeApp(gh.fetchFn, clock)
        .resolvePullRequest("acme", "widgets", 7)
        .then(
          () => null,
          (e: unknown) => e,
        );
      assert.strictEqual((err as GitHubError).code, "pr_not_found");
    });

    it("reports other API failures as github_error without leaking the token", async () => {
      const clock = () => Date.now();
      const routes = standardRoutes({ clock });
      const gh = fakeGitHub((req) =>
        req.path.endsWith("/pulls/7")
          ? { status: 502, body: { message: "Bad gateway" } }
          : routes(req),
      );
      const err = (await makeApp(gh.fetchFn, clock)
        .resolvePullRequest("acme", "widgets", 7)
        .then(
          () => null,
          (e: unknown) => e,
        )) as GitHubError;
      assert.strictEqual(err.code, "github_error");
      assert.strictEqual(err.status, 502);
      assert.notInclude(JSON.stringify({ ...err, m: err.message }), "ghs_");
    });
  });

  describe("repository reads for the git cache", () => {
    it("clones over HTTPS from github.com, with no credentials in the URL", () => {
      const app = makeApp(fakeGitHub(() => undefined).fetchFn, Date.now);
      assert.strictEqual(
        app.remoteUrl("acme", "widgets"),
        "https://github.com/acme/widgets.git",
      );
    });

    it("reads the repository size in KB", async () => {
      const clock = () => Date.now();
      const routes = standardRoutes({ clock });
      const gh = fakeGitHub((req) =>
        req.path === "/repos/acme/widgets"
          ? { status: 200, body: { size: 2048 } }
          : routes(req),
      );
      assert.strictEqual(
        await makeApp(gh.fetchFn, clock).repoSizeKb("acme", "widgets"),
        2048,
      );
    });

    it("lists the PR's commits with parents across compare pages", async () => {
      const clock = () => Date.now();
      const routes = standardRoutes({ clock });
      const commits = Array.from({ length: 150 }, (_, i) => ({
        sha: i.toString(16).padStart(40, "0"),
        parents: [
          {
            sha: i === 0 ? MERGE_BASE : (i - 1).toString(16).padStart(40, "0"),
          },
        ],
      }));
      const gh = fakeGitHub((req) => {
        const m = req.path.match(
          /^\/repos\/acme\/widgets\/compare\/(\w+)\.\.\.(\w+)\?per_page=100&page=(\d+)$/,
        );
        if (!m) return routes(req);
        const page = Number(m[3]);
        return {
          status: 200,
          body: {
            merge_base_commit: { sha: MERGE_BASE },
            ahead_by: 150,
            total_commits: 150,
            commits: commits.slice((page - 1) * 100, page * 100),
          },
        };
      });
      const list = await makeApp(gh.fetchFn, clock).compareCommits(
        "acme",
        "widgets",
        MERGE_BASE,
        HEAD,
      );
      assert.lengthOf(list, 150);
      assert.deepEqual(list[0], {
        sha: commits[0].sha,
        parents: [MERGE_BASE],
      });
      assert.strictEqual(list[149].sha, commits[149].sha);
    });
  });
});
