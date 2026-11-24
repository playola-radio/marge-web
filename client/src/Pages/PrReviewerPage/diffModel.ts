import type {
  ChaptersDocument,
  DiffFile,
  DiffHunk,
  DiffLine,
  Step,
} from "../../Services/PrReviewerService";

/**
 * Pure view-model helpers for the chapters page (reference: chapters-mvp §8).
 * Nothing here touches the DOM.
 */

/** Where the outline put a run: a chapter step, or "not in a chapter". */
export type Placement =
  | { kind: "chapter"; chapterIdx: number; stepIdx: number; number: number }
  | { kind: "excluded" };

export type Role = "this" | "earlier" | "later" | "excluded";

export type LineRole = { role: Role; chapter?: number };

export type RoleOf = (runId: string | undefined) => LineRole | null;

export type DocIndex = {
  placements: Map<string, Placement>;
  runsById: Map<string, ChaptersDocument["runs"][number]>;
  filesByPath: Map<string, DiffFile>;
};

export function indexDocument(doc: ChaptersDocument): DocIndex {
  const placements = new Map<string, Placement>();
  doc.chapters.forEach((chapter, chapterIdx) =>
    chapter.steps.forEach((step, stepIdx) =>
      step.runIds.forEach((runId) =>
        placements.set(runId, {
          kind: "chapter",
          chapterIdx,
          stepIdx,
          number: chapter.number,
        }),
      ),
    ),
  );
  for (const { runId } of doc.excluded) {
    placements.set(runId, { kind: "excluded" });
  }
  return {
    placements,
    runsById: new Map(doc.runs.map((r) => [r.id, r])),
    filesByPath: new Map(doc.files.map((f) => [f.path, f])),
  };
}

/**
 * The role of a changed line relative to one step (reference §8 table):
 * this step's runs, an earlier or later chapter/step, or excluded.
 * Unchanged lines (no runId) have no role.
 */
export function roleOfForStep(
  index: DocIndex,
  chapterIdx: number,
  stepIdx: number,
): RoleOf {
  return (runId) => {
    if (!runId) return null;
    const p = index.placements.get(runId);
    if (!p) return null;
    if (p.kind === "excluded") return { role: "excluded" };
    if (p.chapterIdx === chapterIdx && p.stepIdx === stepIdx) {
      return { role: "this", chapter: p.number };
    }
    const earlier =
      p.chapterIdx < chapterIdx ||
      (p.chapterIdx === chapterIdx && p.stepIdx < stepIdx);
    return { role: earlier ? "earlier" : "later", chapter: p.number };
  };
}

/** Roles for the plain diff of one excluded run (the "not in a chapter" panel). */
export function roleOfForRun(focusRunId: string): RoleOf {
  return (runId) => (runId && runId === focusRunId ? { role: "this" } : null);
}

/** One file's share of a step: consecutive runs in one file share a block. */
export type StepBlock = {
  path: string;
  file: DiffFile | undefined;
  runIds: string[];
  hunks: DiffHunk[];
};

export function stepBlocks(index: DocIndex, step: Step): StepBlock[] {
  const blocks: StepBlock[] = [];
  for (const runId of step.runIds) {
    const path = index.runsById.get(runId)?.path;
    if (path === undefined) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.path === path) last.runIds.push(runId);
    else
      blocks.push({
        path,
        file: index.filesByPath.get(path),
        runIds: [runId],
        hunks: [],
      });
  }
  for (const block of blocks) {
    const ids = new Set(block.runIds);
    block.hunks = (block.file?.hunks ?? []).filter((h) =>
      h.lines.some((l) => l.runId && ids.has(l.runId)),
    );
  }
  return blocks;
}

export const WINDOW = 3;
export const MAX_JOIN_GAP = 6;

/** A visible stretch of a hunk's lines, or a collapsed bar over hidden ones. [start, end) indices. */
export type Segment = { kind: "lines" | "bar"; start: number; end: number };

/**
 * Splits a hunk into the focus runs' ±3-line windows and collapsed bars
 * (reference §8). Windows join across a gap of ≤ 6 lines.
 */
export function segmentHunk(hunk: DiffHunk, focus: Set<string>): Segment[] {
  const n = hunk.lines.length;
  const windows: [number, number][] = [];
  hunk.lines.forEach((line, i) => {
    if (!line.runId || !focus.has(line.runId)) return;
    const start = Math.max(0, i - WINDOW);
    const end = Math.min(n, i + WINDOW + 1);
    const last = windows[windows.length - 1];
    if (last && start - last[1] <= MAX_JOIN_GAP)
      last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  });
  if (windows.length === 0)
    return n ? [{ kind: "lines", start: 0, end: n }] : [];
  const segments: Segment[] = [];
  let at = 0;
  for (const [start, end] of windows) {
    if (start > at) segments.push({ kind: "bar", start: at, end: start });
    segments.push({ kind: "lines", start, end });
    at = end;
  }
  if (at < n) segments.push({ kind: "bar", start: at, end: n });
  return segments;
}

/** "N lines · M from ch K · M not in a chapter" for a collapsed bar. */
export function barLabel(lines: DiffLine[], roleOf: RoleOf): string {
  const byChapter = new Map<number, number>();
  let excluded = 0;
  for (const line of lines) {
    const r = roleOf(line.runId);
    if (!r) continue;
    if (r.role === "excluded") excluded += 1;
    else if (r.chapter !== undefined) {
      byChapter.set(r.chapter, (byChapter.get(r.chapter) ?? 0) + 1);
    }
  }
  const parts = [`${lines.length} ${lines.length === 1 ? "line" : "lines"}`];
  for (const [chapter, count] of [...byChapter].sort((a, b) => a[0] - b[0])) {
    parts.push(`${count} from ch ${chapter}`);
  }
  if (excluded) parts.push(`${excluded} not in a chapter`);
  return parts.join(" · ");
}

/** One row of a split diff: base on the left, head on the right. */
export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/** Pairs removals with additions inside each change block, GitHub-style. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === " ") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind !== " ") {
      (lines[i].kind === "-" ? dels : adds).push(lines[i]);
      i += 1;
    }
    for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

export type ChapterStats = {
  files: string[];
  added: number;
  removed: number;
  commits: string[];
};

/** File list, +/− counts and owner commits for a chapter's runs. */
export function runStats(index: DocIndex, runIds: string[]): ChapterStats {
  const files: string[] = [];
  const commits: string[] = [];
  let added = 0;
  let removed = 0;
  for (const id of runIds) {
    const run = index.runsById.get(id);
    if (!run) continue;
    if (!files.includes(run.path)) files.push(run.path);
    if (!commits.includes(run.commitSha)) commits.push(run.commitSha);
    added += run.added;
    removed += run.removed;
  }
  return { files, added, removed, commits };
}

export const shortSha = (sha: string) => sha.slice(0, 7);

/** Markdown blocks render as markdown (markdown reference §1). */
export function isMarkdownBlock(block: StepBlock): boolean {
  return (
    /\.(md|markdown)$/i.test(block.path) &&
    !!block.file &&
    block.file.status !== "deleted" &&
    !block.file.binary &&
    block.hunks.length > 0
  );
}
