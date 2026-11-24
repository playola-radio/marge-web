import { assert } from "chai";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../repoFixtures.test.js";
import { outlineSchema, summarizeSchema } from "../pipeline/schema.js";
import { createLlmClient, FakeLlmClient } from "./index.js";
import { LlmRequestError } from "./LlmClient.js";
import { defaultAnswer } from "./fakeClient.js";

const runs = (...paths: string[]) =>
  paths.map((path, i) => ({ id: `r${i + 1}`, path }));

const summarize = (llm: FakeLlmClient) =>
  llm.structured({
    stage: "summarize",
    system: "",
    user: "",
    input: { branch: "feature/x", chapters: [{ headline: "Changes" }] },
    schema: summarizeSchema,
  });

describe("FakeLlmClient", () => {
  describe("default outline", () => {
    it("leaves lockfiles out of the chapters, with a reason", () => {
      const out = defaultAnswer("outline", {
        runs: runs("server/a.ts", "package-lock.json", "web/yarn.lock"),
      }) as { chapters: { runIds: string[] }[]; excluded: { runId: string }[] };
      assert.deepEqual(
        out.excluded.map((e) => e.runId),
        ["r2", "r3"],
      );
      assert.deepEqual(
        out.chapters.flatMap((c) => c.runIds),
        ["r1"],
      );
      outlineSchema.parse(out);
    });

    it("keeps lockfiles in a chapter when they are all the pull request changes", () => {
      const out = defaultAnswer("outline", {
        runs: runs("package-lock.json"),
      }) as { chapters: { runIds: string[] }[]; excluded: unknown[] };
      assert.deepEqual(out.excluded, []);
      assert.deepEqual(out.chapters[0].runIds, ["r1"]);
    });
  });

  describe("narration from the commits", () => {
    it("makes one chapter per commit, headed by its subject, oldest first", () => {
      const out = defaultAnswer("outline", {
        commits: [
          { sha: "aaaaaaa", subject: "Count plays", body: "" },
          { sha: "bbbbbbb", subject: "Serve them", body: "" },
        ],
        runs: [
          { id: "r1", path: "api.ts", owners: ["bbbbbbb"] },
          { id: "r2", path: "plays.ts", owners: ["aaaaaaa"] },
          { id: "r3", path: "plays.test.ts", owners: ["aaaaaaa"] },
        ],
      }) as { chapters: { headline: string; runIds: string[] }[] };
      assert.deepEqual(
        out.chapters.map((c) => [c.headline, c.runIds]),
        [
          ["Count plays", ["r2", "r3"]],
          ["Serve them", ["r1"]],
        ],
      );
    });

    it("introduces a chapter with its commit's message body", () => {
      const out = defaultAnswer("write", {
        headline: "Count plays",
        runs: runs("plays.ts"),
        commits: [{ sha: "a", subject: "Count plays", body: "One query." }],
      }) as { intro: string };
      assert.strictEqual(out.intro, "One query.");
    });

    it("titles the pull request from its branch and summarises its commits", () => {
      const out = defaultAnswer("summarize", {
        branch: "feature/weekly-top-songs",
        subjects: ["Count plays", "Serve them"],
        chapters: [],
      });
      assert.deepEqual(out, {
        title: "Weekly top songs",
        summary: "Count plays, then serve them.",
      });
    });
  });

  describe("demo switches", () => {
    it("fails summarize while the outage file named in env exists, and answers once it is gone", async () => {
      const dir = tempDir("fake-llm");
      try {
        const outageFile = join(dir, "outage");
        const llm = createLlmClient({
          PR_REVIEWER_LLM: "fake",
          PR_REVIEWER_FAKE_LLM_OUTAGE_FILE: outageFile,
        }) as FakeLlmClient;
        writeFileSync(outageFile, "");
        const err = await summarize(llm).then(
          () => null,
          (e: unknown) => e,
        );
        assert.instanceOf(err, LlmRequestError);
        rmSync(outageFile);
        const ok = await summarize(llm);
        assert.isTrue(ok.ok && ok.value.title === "X");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("waits delayMs before answering", async () => {
      const llm = new FakeLlmClient({ delayMs: 50 });
      const start = Date.now();
      await summarize(llm);
      assert.isAtLeast(Date.now() - start, 45);
    });
  });
});
