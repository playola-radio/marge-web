import type { ExtractResult } from "../extract.js";
import type { LlmClient } from "../llm/LlmClient.js";
import type { Outline, OutlineChapter } from "./outline.js";
import { writeSchema, type WriteOutput } from "./schema.js";
import { runLlmStage, StageFailure, type StageCache } from "./stage.js";
import { checkCoverage, renderLine, type UnitView } from "./units.js";

/**
 * Stage 2 — WriteChapter (reference §6.2): one call per chapter, a bounded
 * number in flight, each writing the chapter's intro and its steps (one
 * sentence each). Validated on unit IDs, then expanded to run IDs.
 */

export const DEFAULT_WRITE_CONCURRENCY = 3;

export interface WrittenChapter {
  intro: string;
  steps: { runIds: string[]; explanation: string }[];
}

const SYSTEM = [
  "You write one chapter of a narrated code review of a pull request.",
  "Write a 1–2 sentence `intro` for the chapter, then split its runs into ordered `steps`.",
  "Each step is one sentence of `explanation` plus the run IDs it explains; closely related runs (e.g. source and its test) may share a step, across files.",
  "Every run ID of this chapter must appear in exactly one step, and no other IDs.",
].join("\n");

export function writeInput(
  extract: ExtractResult,
  chapter: OutlineChapter,
  outline: Outline,
  units: UnitView[],
) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const chapterUnits = chapter.unitIds.map((id) => byId.get(id)!);
  const owners = new Set(chapterUnits.flatMap((u) => u.owners));
  return {
    headline: chapter.headline,
    headlines: outline.chapters.map((c) => c.headline),
    runs: chapterUnits.map((u) => ({
      id: u.id,
      path: u.path,
      hunk: u.hunkHeader,
      ...(u.note ? { note: u.note } : {}),
      lines: u.context.map(renderLine),
    })),
    commits: extract.commits
      .filter((c) => owners.has(c.sha))
      .map((c) => ({
        sha: c.sha.slice(0, 7),
        subject: c.subject,
        body: c.body,
      })),
  };
}

function render(input: ReturnType<typeof writeInput>): string {
  const arc = input.headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");
  const commits = input.commits
    .map(
      (c) =>
        `- ${c.sha} ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, "\n  ")}` : ""}`,
    )
    .join("\n");
  const runs = input.runs
    .map((r) =>
      [`Run ${r.id} · ${r.path}`, r.hunk || `(${r.note})`, ...r.lines].join(
        "\n",
      ),
    )
    .join("\n\n");
  return (
    `This chapter: ${input.headline}\n\nAll chapters, in order:\n${arc}\n\n` +
    `Commit messages:\n${commits}\n\nRuns:\n${runs}`
  );
}

/** One step per file (units in file order), no explanation and no intro. */
export function writeFallback(
  chapter: OutlineChapter,
  units: UnitView[],
): WriteOutput {
  const inChapter = new Set(chapter.unitIds);
  const steps: WriteOutput["steps"] = [];
  let path: string | null = null;
  // `units` is in file (diff) order, so a file's units are consecutive.
  for (const u of units) {
    if (!inChapter.has(u.id)) continue;
    if (u.path !== path) {
      steps.push({ runIds: [], explanation: "" });
      path = u.path;
    }
    steps[steps.length - 1].runIds.push(u.id);
  }
  return { intro: "", steps };
}

export function expandWrite(
  value: WriteOutput,
  units: UnitView[],
): WrittenChapter {
  const runIdsOf = new Map(units.map((u) => [u.id, u.runIds]));
  return {
    intro: value.intro,
    steps: value.steps.map((s) => ({
      runIds: s.runIds.flatMap((id) => runIdsOf.get(id)!),
      explanation: s.explanation,
    })),
  };
}

export async function writeChapters(opts: {
  extract: ExtractResult;
  outline: Outline;
  units: UnitView[];
  llm: LlmClient;
  cache: StageCache;
  concurrency?: number;
  onChapterDone?: (completed: number, total: number) => Promise<void> | void;
}): Promise<{ chapters: WrittenChapter[]; fallbacks: string[] }> {
  const { outline, units } = opts;
  const total = outline.chapters.length;
  const written: WrittenChapter[] = new Array(total);
  const fellBack: boolean[] = new Array(total).fill(false);
  let next = 0;
  let completed = 0;
  let failed = false;

  const writeOne = async (i: number) => {
    const chapter = outline.chapters[i];
    const input = writeInput(opts.extract, chapter, outline, units);
    try {
      const result = await runLlmStage({
        stage: "write",
        llm: opts.llm,
        cache: opts.cache,
        system: SYSTEM,
        user: render(input),
        input,
        schema: writeSchema,
        check: (v) =>
          v.steps.length === 0
            ? "there must be at least one step"
            : checkCoverage(
                chapter.unitIds,
                v.steps.map((s, j) => ({
                  label: `step ${j + 1}`,
                  ids: s.runIds,
                })),
              ),
        fallback: () => writeFallback(chapter, units),
      });
      written[i] = expandWrite(result.output, units);
      fellBack[i] = result.fallbackUsed;
    } catch (err) {
      throw new StageFailure("write", err, i + 1);
    }
    completed += 1;
    await opts.onChapterDone?.(completed, total);
  };

  const worker = async () => {
    while (!failed && next < total) {
      const i = next;
      next += 1;
      try {
        await writeOne(i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const width = Math.max(
    1,
    Math.min(opts.concurrency ?? DEFAULT_WRITE_CONCURRENCY, total),
  );
  await Promise.all(Array.from({ length: width }, worker));
  return {
    chapters: written,
    fallbacks: outline.chapters
      .filter((_, i) => fellBack[i])
      .map((c) => `write:${c.key}`),
  };
}
