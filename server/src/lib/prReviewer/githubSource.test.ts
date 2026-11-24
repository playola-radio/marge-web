import { assert } from "chai";
import { createGitHubSource } from "./githubSource.js";
import { FakeGitHub } from "./fakeGitHub.js";
import { GitHubApp } from "./github.js";

describe("createGitHubSource", () => {
  it("picks the offline fake for PR_REVIEWER_GITHUB=fake without reading the App's credentials", () => {
    const env: NodeJS.ProcessEnv = { PR_REVIEWER_GITHUB: "fake" };
    for (const key of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"])
      Object.defineProperty(env, key, {
        enumerable: true,
        get() {
          throw new Error(`${key} was read`);
        },
      });
    assert.instanceOf(createGitHubSource(env), FakeGitHub);
  });

  it("picks the GitHub App when its ID and private key are set", () => {
    assert.instanceOf(
      createGitHubSource({
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "pem",
      }),
      GitHubApp,
    );
  });

  it("is null when neither is configured", () => {
    assert.isNull(createGitHubSource({}));
    assert.isNull(createGitHubSource({ GITHUB_APP_ID: "123" }));
  });
});
