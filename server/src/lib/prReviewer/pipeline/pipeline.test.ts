import { assert } from "chai";
import type { ExtractOutput, ExtractResult } from "../extract.js";
import {
  AnthropicLlmClient,
  type MessagesApi,
} from "../llm/anthropicClient.js";
import { defaultAnswer, FakeLlmClient } from "../llm/fakeClient.js";
import { FixtureRepo, lines } from "../repoFixtures.test.js";
import { assertCovered, featureExtract } from "./pipelineFixtures.test.js";
import {
  chaptersDocumentSchema,
  EmptyDiffError,
  generateChapters,
  MemoryStageCache,
  StageFailure,
} from "./index.js";
import { outlineFallback } from "./outline.js";
import { unitViews } from "./units.js";

const NOW = () => new Date("2026-11-23T12:00:00.000Z");

const INVALID = { nonsense: true };

describe("pipeline", () => {
  let up: FixtureRepo;
  let extracted: ExtractOutput;
  beforeEach(async () => {
    up = FixtureRepo.create();
    extracted = await featureExtract(up);
  });
  afterEach(() => up.remove());

  const pr = {
    number: 7,
    title: "Add a greeting",
    url: "https://github.com/acme/widgets/pull/7",
    host: "github.com",
    owner: "acme",
    repo: "widgets",
  };

  it("assembles a schema-valid chapters.json v1 document covering every run, with the markdown sources", async () => {
    const llm = new FakeLlmClient();
    const progress: unknown[] = [];
    const { document, markdownSources } = await generateChapters({
      extract: extracted,
      llm,
      cache: new MemoryStageCache(),
      pr,
      now: NOW,
      onProgress: (p) => {
        progress.push(p);
      },
    });

    chaptersDocumentSchema.parse(document);
    assertCovered(document);
    assert.deepInclude(document, {
      version: 1,
      repo: "widgets",
      branch: "feature",
      baseRef: "main",
      generatedAt: "2026-11-23T12:00:00.000Z",
      model: "fake",
      promptVersion: "1",
      fallbacks: [],
      pr,
    });
    assert.deepEqual(
      document.chapters.map((c) => c.number),
      document.chapters.map((_, i) => i + 1),
    );
    assert.deepEqual(
      document.commits.map((c) => c.subject),
      ["Add greeting", "Document greeting", "Test greeting"],
    );
    assert.notProperty(document.commits[0], "body");
    assert.deepEqual(markdownSources, [
      {
        path: "README.md",
        text: lines("# Widgets", "", "Intro.", "", "Call `greet()`."),
      },
    ]);
    const total = document.chapters.length;
    assert.deepEqual(progress[0], { stage: "outline" });
    assert.deepEqual(progress[progress.length - 1], { stage: "summarize" });
    assert.deepInclude(progress, {
      stage: "write",
      completedChapters: total,
      totalChapters: total,
    });
    assert.lengthOf(llm.callsFor("outline"), 1);
    assert.lengthOf(llm.callsFor("write"), total);
    assert.lengthOf(llm.callsFor("summarize"), 1);
  });

  it("retries an invalid response once with the validation error appended, then uses it", async () => {
    const llm = new FakeLlmClient({ script: { outline: [INVALID] } });
    const { document } = await generateChapters({
      extract: extracted,
      llm,
      cache: new MemoryStageCache(),
    });
    const calls = llm.callsFor("outline");
    assert.lengthOf(calls, 2);
    assert.include(calls[1].user, calls[0].user);
    assert.include(calls[1].user, "Your previous response was invalid:");
    assert.include(calls[1].user, "chapters");
    assert.deepEqual(document.fallbacks, []);
  });

  it("treats an outline that misses a run as invalid", async () => {
    const units = unitViews(extracted.result);
    const llm = new FakeLlmClient({
      script: {
        outline: [
          {
            chapters: [{ key: "one", headline: "One", runIds: [units[0].id] }],
            excluded: [],
          },
        ],
      },
    });
    await generateChapters({
      extract: extracted,
      llm,
      cache: new MemoryStageCache(),
    });
    const calls = llm.callsFor("outline");
    assert.lengthOf(calls, 2);
    assert.include(calls[1].user, "not placed anywhere");
  });

  it("falls back to one chapter per commit after two invalid outlines", async () => {
    const llm = new FakeLlmClient({ script: { outline: [INVALID, INVALID] } });
    const { document } = await generateChapters({
      extract: extracted,
      llm,
      cache: new MemoryStageCache(),
    });
    assert.lengthOf(llm.callsFor("outline"), 2);
    assert.deepEqual(document.fallbacks, ["outline"]);
    assert.deepEqual(
      document.chapters.map((c) => [c.key, c.headline]),
      [
        ["add-greeting", "Add greeting"],
        ["document-greeting", "Document greeting"],
        ["test-greeting", "Test greeting"],
      ],
    );
    assert.deepEqual(document.excluded, []);
    assertCovered(document);
    chaptersDocumentSchema.parse(document);
  });

  it("falls back to one step per file with empty text after two invalid chapter writes", async () => {
    const llm = new FakeLlmClient({
      script: { outline: [INVALID, INVALID], write: [INVALID, INVALID] },
    });
    const { document } = await generateChapters({
      extract: extracted,
      llm,
      cache: new MemoryStageCache(),
      concurrency: 1,
    });
    assert.deepEqual(document.fallbacks, ["outline", "write:add-greeting"]);
    const first = document.chapters[0];
    assert.equal(first.intro, "");
    const runPath = new Map(document.runs.map((r) => [r.id, r.path]));
    assert.deepEqual(
      first.steps.map((s) => [
        [...new Set(s.runIds.map((id) => runPath.get(id)))],
        s.explanation,
      ]),
      [
        [["src/a.ts"], ""],
        [["src/b.ts"], ""],
      ],
    );
    assert.notEqual(document.chapters[1].intro, "");
    assertCovered(document);
    chaptersDocumentSchema.parse(document);
  });

  it("falls back to the branch name and joined subjects after two invalid summaries", async () => {
    const llm = new FakeLlmClient({
      script: {
        summarize: [INVALID, { title: "x", summary: "word ".repeat(81) }],
      },
    });
    const { document } = await generateChapters({
      extract: extracted,
      llm,
      cache: new MemoryStageCache(),
    });
    assert.lengthOf(llm.callsFor("summarize"), 2);
    assert.deepEqual(document.fallbacks, ["summarize"]);
    assert.equal(document.title, "feature");
    assert.equal(
      document.summary,
      "Add greeting; Document greeting; Test greeting",
    );
  });

  it("aborts on a network error without falling back", async () => {
    const llm = new FakeLlmClient({
      script: { outline: [new Error("ECONNRESET")] },
    });
    let caught: unknown;
    try {
      await generateChapters({
        extract: extracted,
        llm,
        cache: new MemoryStageCache(),
      });
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, StageFailure);
    assert.equal((caught as StageFailure).stage, "outline");
    assert.include((caught as Error).message, "ECONNRESET");
    assert.lengthOf(llm.calls, 1);
  });

  it("names the chapter a failed write was for", async () => {
    const llm = new FakeLlmClient({
      script: {
        outline: [INVALID, INVALID],
        write: [
          { intro: "ok", steps: [] },
          { intro: "ok", steps: [] },
          new Error("boom"),
        ],
      },
    });
    let caught: unknown;
    try {
      await generateChapters({
        extract: extracted,
        llm,
        cache: new MemoryStageCache(),
        concurrency: 1,
      });
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, StageFailure);
    assert.equal((caught as StageFailure).stage, "write");
    assert.equal((caught as StageFailure).chapterNumber, 2);
  });

  it("lets chapter writes already in flight finish before failing the attempt", async () => {
    let slowFinished = false;
    const llm = new FakeLlmClient({
      script: {
        outline: [INVALID, INVALID],
        write: [
          new Error("boom"),
          async (req) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            slowFinished = true;
            return defaultAnswer("write", req.input);
          },
        ],
      },
    });
    let caught: unknown;
    try {
      await generateChapters({
        extract: extracted,
        llm,
        cache: new MemoryStageCache(),
        concurrency: 2,
      });
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, StageFailure);
    assert.isTrue(slowFinished);
    assert.lengthOf(llm.callsFor("write"), 2);
  });

  it("after a crash, reassembles a fallback stage from the stage cache with fallbacks[] intact", async () => {
    const cache = new MemoryStageCache();
    const crashing = new FakeLlmClient({
      script: {
        outline: [INVALID, INVALID],
        write: [new Error("socket hang up")],
      },
    });
    try {
      await generateChapters({
        extract: extracted,
        llm: crashing,
        cache,
        concurrency: 1,
      });
      assert.fail("expected the first attempt to crash");
    } catch (err) {
      assert.instanceOf(err, StageFailure);
    }

    const resumed = new FakeLlmClient();
    const { document } = await generateChapters({
      extract: extracted,
      llm: resumed,
      cache,
    });
    assert.lengthOf(resumed.callsFor("outline"), 0);
    assert.deepEqual(document.fallbacks, ["outline"]);
    assert.deepEqual(
      document.chapters.map((c) => c.key),
      ["add-greeting", "document-greeting", "test-greeting"],
    );
    assertCovered(document);
  });

  it("makes zero LLM calls when the same revision is generated again", async () => {
    const cache = new MemoryStageCache();
    const first = await generateChapters({
      extract: extracted,
      llm: new FakeLlmClient(),
      cache,
      now: NOW,
    });
    const again = new FakeLlmClient();
    const second = await generateChapters({
      extract: extracted,
      llm: again,
      cache,
      now: NOW,
    });
    assert.lengthOf(again.calls, 0);
    assert.deepEqual(second.document, first.document);
  });

  describe("with the mocked Anthropic client", () => {
    /** A messages API that answers each request from `answer(toolName, n)`. */
    function scripted(answer: (tool: string, n: number) => unknown) {
      const requests: { tool: string }[] = [];
      const messages: MessagesApi = {
        async create(body) {
          const tool = (body.tools as { name: string }[])[0].name;
          const n = requests.filter((r) => r.tool === tool).length + 1;
          requests.push({ tool });
          return {
            content: [
              { type: "tool_use", id: "t", name: tool, input: answer(tool, n) },
            ],
          };
        },
      };
      return { messages, requests };
    }

    function validOutline(result: ExtractResult) {
      return {
        chapters: [
          {
            key: "all",
            headline: "Everything",
            runIds: unitViews(result).map((u) => u.id),
          },
        ],
        excluded: [],
      };
    }

    function validWrite(result: ExtractResult) {
      return {
        intro: "All of it.",
        steps: [
          {
            runIds: unitViews(result).map((u) => u.id),
            explanation: "It all.",
          },
        ],
      };
    }

    it("makes exactly two requests for a stage whose first response is invalid, then succeeds", async () => {
      const { messages, requests } = scripted((tool, n) => {
        if (tool === "emit_outline")
          return n === 1 ? INVALID : validOutline(extracted.result);
        if (tool === "emit_write") return validWrite(extracted.result);
        return { title: "Greeting", summary: "Adds a greeting." };
      });
      const llm = new AnthropicLlmClient({
        messages,
        model: "claude-opus-5-5",
      });
      const { document } = await generateChapters({
        extract: extracted,
        llm,
        cache: new MemoryStageCache(),
      });
      assert.lengthOf(
        requests.filter((r) => r.tool === "emit_outline"),
        2,
      );
      assert.lengthOf(requests, 4);
      assert.deepEqual(document.fallbacks, []);
      assert.equal(document.chapters[0].headline, "Everything");
      assert.equal(document.model, "claude-opus-5-5");
    });

    it("makes exactly two requests for two invalid responses and yields the stage's fallback", async () => {
      const { messages, requests } = scripted((tool) => {
        if (tool === "emit_outline") return validOutline(extracted.result);
        if (tool === "emit_write") return validWrite(extracted.result);
        return INVALID;
      });
      const llm = new AnthropicLlmClient({
        messages,
        model: "claude-opus-5-5",
      });
      const { document } = await generateChapters({
        extract: extracted,
        llm,
        cache: new MemoryStageCache(),
      });
      assert.lengthOf(
        requests.filter((r) => r.tool === "emit_summarize"),
        2,
      );
      assert.deepEqual(document.fallbacks, ["summarize"]);
      assert.equal(document.title, "feature");
    });
  });
});

describe("generateChapters on an empty diff", () => {
  it("stops before any LLM call", async () => {
    const llm = new FakeLlmClient();
    const empty: ExtractOutput = {
      result: {
        baseRef: "main",
        baseSha: "b".repeat(40),
        headSha: "c".repeat(40),
        branch: "feature",
        repo: "widgets",
        commits: [],
        files: [],
        runs: [],
        ownerFallbacks: [],
      },
      markdownSources: [],
    };
    let caught: unknown;
    try {
      await generateChapters({
        extract: empty,
        llm,
        cache: new MemoryStageCache(),
      });
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, EmptyDiffError);
    assert.lengthOf(llm.calls, 0);
  });
});

describe("outlineFallback", () => {
  function result(subjects: string[]): ExtractResult {
    const commits = subjects.map((subject, i) => ({
      sha: `${i}`.padStart(40, "a"),
      subject,
      body: "",
      author: "A",
      date: "2026-01-01T00:00:00Z",
    }));
    const runs = commits.map((c, i) => ({
      id: `${i}`.padStart(12, "0"),
      path: `f${i}.bin`,
      commitSha: c.sha,
      added: 0,
      removed: 0,
    }));
    return {
      baseRef: "main",
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
      branch: "feature",
      repo: "widgets",
      commits,
      files: runs.map((r) => ({
        path: r.path,
        status: "added" as const,
        binary: true,
        hunks: [],
      })),
      runs,
      ownerFallbacks: [],
    };
  }

  it("merges commits past the 12th into chapter 12, de-duplicates keys and names empty subjects", () => {
    const subjects = Array.from({ length: 14 }, (_, i) =>
      i === 1 ? "Fix" : i === 2 ? "" : i === 3 ? "Fix" : `Step ${i}`,
    );
    const r = result(subjects);
    const out = outlineFallback(r, unitViews(r));
    assert.lengthOf(out.chapters, 12);
    assert.equal(out.chapters[1].key, "fix");
    assert.equal(out.chapters[3].key, "fix-2");
    assert.equal(
      out.chapters[2].headline,
      `Commit ${r.commits[2].sha.slice(0, 7)}`,
    );
    assert.equal(out.chapters[11].headline, "Step 11 (and 2 more commits)");
    assert.lengthOf(out.chapters[11].runIds, 3);
    assert.deepEqual(out.excluded, []);
  });

  it("never reuses a key when a subject already ends in a number", () => {
    const r = result(["Fix bug", "Fix bug", "Fix bug 2"]);
    const keys = outlineFallback(r, unitViews(r)).chapters.map((c) => c.key);
    assert.deepEqual(keys, ["fix-bug", "fix-bug-2", "fix-bug-2-2"]);
  });
});
