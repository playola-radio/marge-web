import {
  unitsOf,
  type DiffLine,
  type ExtractResult,
  type FileDiff,
} from "../extract.js";

/** A unit (touching runs in one hunk) with what the prompts show of it. */
export interface UnitView {
  id: string;
  path: string;
  runIds: string[];
  /** Owning commits of its runs, in order, without repeats. */
  owners: string[];
  added: number;
  removed: number;
  /** The enclosing hunk header ("" for a content-less unit). */
  hunkHeader: string;
  /** For a content-less unit: what changed (binary, rename, mode-only…). */
  note?: string;
  changed: DiffLine[];
  /** The unit's lines with up to 3 lines of hunk context either side. */
  context: DiffLine[];
}

const CONTEXT = 3;

function contentlessNote(file: FileDiff): string {
  if (file.binary) return `binary file ${file.status}`;
  if (file.status === "renamed") return `renamed from ${file.oldPath}`;
  if (file.status === "added") return "empty file added";
  if (file.status === "deleted") return "empty file deleted";
  return "file mode or type changed";
}

export function unitViews(result: ExtractResult): UnitView[] {
  const runs = new Map(result.runs.map((r) => [r.id, r]));
  const where = new Map<
    string,
    { file: FileDiff; lines: DiffLine[]; first: number; last: number }
  >();
  for (const file of result.files)
    for (const hunk of file.hunks)
      hunk.lines.forEach((line, i) => {
        if (!line.runId) return;
        const at = where.get(line.runId);
        if (at) at.last = i;
        else
          where.set(line.runId, { file, lines: hunk.lines, first: i, last: i });
      });
  const hunkHeader = new Map<DiffLine[], string>();
  for (const file of result.files)
    for (const hunk of file.hunks) hunkHeader.set(hunk.lines, hunk.header);
  const fileOf = new Map(result.files.map((f) => [f.path, f]));

  return unitsOf(result).map((unit) => {
    const unitRuns = unit.runIds.map((id) => runs.get(id)!);
    const owners = [...new Set(unitRuns.map((r) => r.commitSha))];
    const added = unitRuns.reduce((n, r) => n + r.added, 0);
    const removed = unitRuns.reduce((n, r) => n + r.removed, 0);
    const locs = unit.runIds.map((id) => where.get(id)).filter((l) => !!l);
    if (locs.length === 0) {
      const file = fileOf.get(unit.path)!;
      return {
        ...unit,
        owners,
        added,
        removed,
        hunkHeader: "",
        note: contentlessNote(file),
        changed: [],
        context: [],
      };
    }
    const lines = locs[0]!.lines;
    const first = Math.min(...locs.map((l) => l!.first));
    const last = Math.max(...locs.map((l) => l!.last));
    return {
      ...unit,
      owners,
      added,
      removed,
      hunkHeader: hunkHeader.get(lines) ?? "",
      changed: lines.slice(first, last + 1).filter((l) => l.kind !== " "),
      context: lines.slice(Math.max(0, first - CONTEXT), last + CONTEXT + 1),
    };
  });
}

/** One diff line as a prompt shows it. */
export function renderLine(line: DiffLine): string {
  return `${line.kind}${line.text}`;
}

/**
 * Checks that every unit ID appears exactly once across `groups`, with none
 * unknown; returns the problem, or null.
 */
export function checkCoverage(
  expected: string[],
  groups: { label: string; ids: string[] }[],
): string | null {
  const known = new Set(expected);
  const seen = new Map<string, string>();
  for (const { label, ids } of groups)
    for (const id of ids) {
      if (!known.has(id)) return `${label} lists unknown run ID "${id}"`;
      const before = seen.get(id);
      if (before)
        return `run ID "${id}" appears more than once (${before} and ${label})`;
      seen.set(id, label);
    }
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length)
    return `these run IDs are not placed anywhere: ${missing.join(", ")}`;
  return null;
}
