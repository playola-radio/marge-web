import { assert } from "chai";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Sequelize } from "sequelize";
import { startPrReviewer } from "./index.js";

const serverDir = fileURLToPath(new URL("../../..", import.meta.url));

async function freePort(): Promise<number> {
  const srv = createServer().listen(0);
  await once(srv, "listening");
  const { port } = srv.address() as { port: number };
  srv.close();
  return port;
}

const github = {
  installationToken: async () => "t",
  repoSizeKb: async () => 1,
  compareCommits: async () => [],
};

describe("PR reviewer startup", () => {
  it("stays off, logging one line, without a database or credentials", () => {
    const logs: string[] = [];
    const reviewer = startPrReviewer({}, { log: (m) => logs.push(m) });
    assert.isNull(reviewer);
    assert.deepEqual(logs, [
      "pr_reviewer_off missing DATABASE_URL, ANTHROPIC_API_KEY, GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY",
    ]);
  });

  it("stays off when only some of the reviewer's settings are present", () => {
    const logs: string[] = [];
    const sequelize = new Sequelize("postgres://unused@127.0.0.1:1/none", {
      dialect: "postgres",
      logging: false,
    });
    const reviewer = startPrReviewer(
      { ANTHROPIC_API_KEY: "sk-test" },
      { log: (m) => logs.push(m), sequelize },
    );
    assert.isNull(reviewer);
    assert.deepEqual(logs, [
      "pr_reviewer_off missing GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY",
    ]);
  });

  it("boots the server with KV_BACKEND=memory, no DATABASE_URL and no reviewer credentials, runner off", async function () {
    this.timeout(20_000);
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "PR_REVIEWER_LLM",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
    ])
      delete env[key];
    Object.assign(env, {
      BASE_URL: `http://localhost:${port}`,
      KV_BACKEND: "memory",
      PORT: String(port),
    });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server.ts"],
      {
        cwd: serverDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    try {
      for (let i = 0; i < 150 && !out.includes("listening on"); i += 1)
        await new Promise((r) => setTimeout(r, 100));
      assert.include(out, `marge-web listening on :${port}`);
      assert.include(out, "pr_reviewer_off missing DATABASE_URL");
      assert.notInclude(out, "startup_failed");
      const res = await fetch(`http://localhost:${port}/healthz`);
      assert.equal(res.status, 200);
    } finally {
      child.kill();
      await once(child, "exit");
    }
  });

  const dbUrl = process.env.DATABASE_URL;
  (dbUrl ? it : it.skip)(
    "starts the runner with a database, the fake LLM and a GitHub stand-in",
    async () => {
      const sequelize = new Sequelize(dbUrl as string, {
        dialect: "postgres",
        logging: false,
      });
      const logs: string[] = [];
      const reviewer = startPrReviewer(
        { PR_REVIEWER_LLM: "fake" },
        { log: (m) => logs.push(m), sequelize, github },
      );
      try {
        assert.isNotNull(reviewer);
        assert.include(logs, "pr_reviewer_on model=fake");
      } finally {
        await reviewer?.runner.stop();
        await sequelize.close();
      }
    },
  );
});
