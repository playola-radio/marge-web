import type { ExtractOutput } from "../extract.js";
import type { LlmClient } from "../llm/LlmClient.js";
import { assemble, type Assembled } from "./assemble.js";
import { outline } from "./outline.js";
import type { DocumentPr, Fallback } from "./schema.js";
import { StageFailure, type StageCache } from "./stage.js";
import { summarize } from "./summarize.js";
import { unitViews } from "./units.js";
import { writeChapters } from "./writeChapter.js";

export { MemoryStageCache, StageFailure, type StageCache } from "./stage.js";
export type { ChaptersDocument } from "./schema.js";
export { chaptersDocumentSchema, PROMPT_VERSION } from "./schema.js";
export type { Assembled } from "./assemble.js";

/** The branch's commits cancel out: nothing to narrate, so no LLM call is made. */
export class EmptyDiffError extends Error {
  constructor() {
    super("The pull request has no changes between its merge base and head");
    this.name = "EmptyDiffError";
  }
}

export type PipelineProgress =
  | { stage: "outline" }
  | { stage: "write"; completedChapters: number; totalChapters: number }
  | { stage: "summarize" };

export interface GenerateOptions {
  extract: ExtractOutput;
  llm: LlmClient;
  cache: StageCache;
  /** WriteChapter calls in flight at once (default 3). */
  concurrency?: number;
  pr?: DocumentPr;
  now?: () => Date;
  onProgress?: (progress: PipelineProgress) => Promise<void> | void;
}

/** ExtractResult → Outline → WriteChapter × N → Summarize → Assemble. */
export async function generateChapters(
  opts: GenerateOptions,
): Promise<Assembled> {
  const { result: extract, markdownSources } = opts.extract;
  if (extract.runs.length === 0) throw new EmptyDiffError();
  const units = unitViews(extract);
  const { llm, cache } = opts;
  const fallbacks: Fallback[] = [];
  const stage = async <T>(
    name: StageFailure["stage"],
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw err instanceof StageFailure ? err : new StageFailure(name, err);
    }
  };

  await opts.onProgress?.({ stage: "outline" });
  const planned = await stage("outline", () =>
    outline({ extract, units, llm, cache }),
  );
  if (planned.fallbackUsed) fallbacks.push("outline");

  const total = planned.outline.chapters.length;
  await opts.onProgress?.({
    stage: "write",
    completedChapters: 0,
    totalChapters: total,
  });
  const written = await writeChapters({
    extract,
    outline: planned.outline,
    units,
    llm,
    cache,
    concurrency: opts.concurrency,
    onChapterDone: (completed) =>
      opts.onProgress?.({
        stage: "write",
        completedChapters: completed,
        totalChapters: total,
      }),
  });
  fallbacks.push(...(written.fallbacks as Fallback[]));

  await opts.onProgress?.({ stage: "summarize" });
  const summarized = await stage("summarize", () =>
    summarize({
      extract,
      outline: planned.outline,
      chapters: written.chapters,
      llm,
      cache,
    }),
  );
  if (summarized.fallbackUsed) fallbacks.push("summarize");

  return stage("assemble", async () =>
    assemble({
      extract,
      markdownSources,
      outline: planned.outline,
      chapters: written.chapters,
      summary: summarized.summary,
      fallbacks,
      model: llm.model,
      generatedAt: (opts.now?.() ?? new Date()).toISOString(),
      pr: opts.pr,
    }),
  );
}
