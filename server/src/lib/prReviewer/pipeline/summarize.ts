import type { ExtractResult } from "../extract.js";
import type { LlmClient } from "../llm/LlmClient.js";
import type { Outline } from "./outline.js";
import {
  SUMMARY_MAX_WORDS,
  summarizeSchema,
  type SummarizeOutput,
} from "./schema.js";
import { runLlmStage, type StageCache } from "./stage.js";
import type { WrittenChapter } from "./writeChapter.js";

/**
 * Stage 3 — Summarize (reference §6.2): one call after the chapters are
 * written, giving the page title and the "What this PR does" paragraph.
 */

const SYSTEM = [
  "You title and summarise a pull request for a code reviewer, from its chapters.",
  `Write a short \`title\` for the page heading and a \`summary\` paragraph of at most ${SUMMARY_MAX_WORDS} words saying what the pull request does.`,
].join("\n");

export function summarizeInput(
  extract: ExtractResult,
  outline: Outline,
  chapters: WrittenChapter[],
) {
  return {
    branch: extract.branch,
    subjects: extract.commits.map((c) => c.subject),
    chapters: outline.chapters.map((c, i) => ({
      headline: c.headline,
      intro: chapters[i].intro,
    })),
  };
}

function render(input: ReturnType<typeof summarizeInput>): string {
  return (
    `Branch: ${input.branch}\n\nCommit subjects:\n` +
    input.subjects.map((s) => `- ${s}`).join("\n") +
    "\n\nChapters:\n" +
    input.chapters
      .map((c, i) => `${i + 1}. ${c.headline}${c.intro ? ` — ${c.intro}` : ""}`)
      .join("\n")
  );
}

export function checkSummary(value: SummarizeOutput): string | null {
  const words = value.summary.trim().split(/\s+/).length;
  return words > SUMMARY_MAX_WORDS
    ? `the summary has ${words} words; at most ${SUMMARY_MAX_WORDS} are allowed`
    : null;
}

/** Title = branch name; summary = the commit subjects joined. */
export function summarizeFallback(extract: ExtractResult): SummarizeOutput {
  return {
    title: extract.branch,
    summary: extract.commits
      .map((c) => c.subject.trim())
      .filter(Boolean)
      .join("; "),
  };
}

export async function summarize(opts: {
  extract: ExtractResult;
  outline: Outline;
  chapters: WrittenChapter[];
  llm: LlmClient;
  cache: StageCache;
}): Promise<{ summary: SummarizeOutput; fallbackUsed: boolean }> {
  const input = summarizeInput(opts.extract, opts.outline, opts.chapters);
  const result = await runLlmStage({
    stage: "summarize",
    llm: opts.llm,
    cache: opts.cache,
    system: SYSTEM,
    user: render(input),
    input,
    schema: summarizeSchema,
    check: checkSummary,
    fallback: () => summarizeFallback(opts.extract),
  });
  return { summary: result.output, fallbackUsed: result.fallbackUsed };
}
