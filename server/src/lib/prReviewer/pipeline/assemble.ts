import type { ExtractResult, MarkdownSource } from "../extract.js";
import type { Outline } from "./outline.js";
import {
  PROMPT_VERSION,
  type ChaptersDocument,
  type DocumentPr,
  type Fallback,
  type SummarizeOutput,
} from "./schema.js";
import type { WrittenChapter } from "./writeChapter.js";

/**
 * Stage 4 — Assemble (reference §6.2, pure code): joins the extraction and
 * the stage outputs into the extended chapters.json v1 document, and passes
 * the extraction-captured markdown sources through to publication. Never
 * reads git. A run covered zero or several times is a bug: it throws.
 */

export class AssembleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssembleError";
  }
}

export interface AssembleInput {
  extract: ExtractResult;
  markdownSources: MarkdownSource[];
  outline: Outline;
  chapters: WrittenChapter[];
  summary: SummarizeOutput;
  fallbacks: Fallback[];
  model: string;
  generatedAt: string;
  pr?: DocumentPr;
}

export interface Assembled {
  document: ChaptersDocument;
  markdownSources: MarkdownSource[];
}

export function assemble(input: AssembleInput): Assembled {
  const { extract, outline } = input;
  const chapters = outline.chapters.map((ch, i) => {
    const written = input.chapters[i];
    if (!written) throw new AssembleError(`Chapter ${i + 1} was never written`);
    return {
      key: ch.key,
      number: i + 1,
      headline: ch.headline,
      intro: written.intro,
      runIds: ch.runIds,
      steps: written.steps,
    };
  });

  // Final assertion: every run is in exactly one step or in `excluded`.
  const placed = new Map<string, number>();
  const place = (id: string) => placed.set(id, (placed.get(id) ?? 0) + 1);
  for (const ch of chapters) for (const s of ch.steps) s.runIds.forEach(place);
  for (const e of outline.excluded) place(e.runId);
  const known = new Set(extract.runs.map((r) => r.id));
  for (const id of placed.keys())
    if (!known.has(id)) throw new AssembleError(`Unknown run ${id} was placed`);
  for (const run of extract.runs) {
    const n = placed.get(run.id) ?? 0;
    if (n !== 1)
      throw new AssembleError(
        `Run ${run.id} (${run.path}) is covered ${n} times, not exactly once`,
      );
  }
  for (const ch of chapters) {
    const stepRuns = ch.steps.flatMap((s) => s.runIds).sort();
    if (stepRuns.join() !== [...ch.runIds].sort().join())
      throw new AssembleError(`Chapter "${ch.key}" steps don't match its runs`);
  }

  const document: ChaptersDocument = {
    version: 1,
    repo: extract.repo,
    branch: extract.branch,
    baseRef: extract.baseRef,
    baseSha: extract.baseSha,
    headSha: extract.headSha,
    generatedAt: input.generatedAt,
    model: input.model,
    promptVersion: PROMPT_VERSION,
    fallbacks: input.fallbacks,
    title: input.summary.title,
    summary: input.summary.summary,
    commits: extract.commits.map(({ sha, subject, author, date }) => ({
      sha,
      subject,
      author,
      date,
    })),
    files: extract.files,
    runs: extract.runs,
    chapters,
    excluded: outline.excluded,
    ...(input.pr ? { pr: input.pr } : {}),
  };
  return { document, markdownSources: input.markdownSources };
}
