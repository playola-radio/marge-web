import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "./fakeGitHub.js";
import { GitHubApp, type GitHubSource } from "./github.js";

/**
 * Picks GitHub from env, like createLlmClient: `PR_REVIEWER_GITHUB=fake` for
 * the offline fake serving the demo pull requests (checked first, so the
 * App's credentials are never read), otherwise the GitHub App when
 * `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set. Null when neither is.
 */
export function createGitHubSource(
  env: NodeJS.ProcessEnv,
): GitHubSource | null {
  if (env.PR_REVIEWER_GITHUB === "fake")
    return new FakeGitHub(join(tmpdir(), "marge-pr-reviewer-github"));
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)
    return new GitHubApp({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
    });
  return null;
}
