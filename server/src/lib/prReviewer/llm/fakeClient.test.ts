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

  describe("demo switches", () => {
    let dir: string;
    beforeEach(() => {
      dir = tempDir("fake-llm");
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("fails summarize while the outage file exists, and answers once it is gone", async () => {
      const outageFile = join(dir, "outage");
      const llm = new FakeLlmClient({ outageFile });
      writeFileSync(outageFile, "");
      const err = await summarize(llm).then(
        () => null,
        (e: unknown) => e,
      );
      assert.instanceOf(err, LlmRequestError);
      rmSync(outageFile);
      const ok = await summarize(llm);
      assert.isTrue(ok.ok && ok.value.title === "feature/x");
    });

    it("waits delayMs before answering", async () => {
      const llm = new FakeLlmClient({ delayMs: 50 });
      const start = Date.now();
      await summarize(llm);
      assert.isAtLeast(Date.now() - start, 45);
    });
  });

  it("createLlmClient reads the demo switches from env", async () => {
    const outageFile = join(tempDir("fake-llm"), "outage");
    try {
      writeFileSync(outageFile, "");
      const llm = createLlmClient({
        PR_REVIEWER_LLM: "fake",
        PR_REVIEWER_FAKE_LLM_OUTAGE_FILE: outageFile,
        PR_REVIEWER_FAKE_LLM_DELAY_MS: "1",
      }) as FakeLlmClient;
      const err = await summarize(llm).then(
        () => null,
        (e: unknown) => e,
      );
      assert.instanceOf(err, LlmRequestError);
    } finally {
      rmSync(join(outageFile, ".."), { recursive: true, force: true });
    }
  });
});
