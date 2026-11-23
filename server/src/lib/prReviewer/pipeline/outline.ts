import type { ExtractResult } from "../extract.js";
import type { LlmClient } from "../llm/LlmClient.js";
import { MAX_CHAPTERS, outlineSchema, type OutlineOutput } from "./schema.js";
import { runLlmStage, type StageCache } from "./stage.js";
import { checkCoverage, renderLine, type UnitView } from "./units.js";

/**
 * Stage 1 — Outline (reference §6.2): one call that groups the units into
 * ordered chapters, leaving generated/vendored changes out. The LLM works on
 * unit IDs (it calls them runs); the result is expanded back to run IDs.
 */

export interface OutlineChapter {
  key: string;
  headline: string;
  unitIds: string[];
  runIds: string[];
}

export interface Outline {
  chapters: OutlineChapter[];
  excluded: { runId: string; reason: string }[];
}

const SYSTEM = [
  "You turn a pull request's changes into an ordered narrative of chapters for a code reviewer.",
  "Group the runs (contiguous changes) into 1 to 12 chapters, each telling one part of the story.",
  "Chapters may regroup runs freely across commits and files; the commit history is a hint, not a constraint.",
  "Order chapters so definitions come before their uses.",
  "Put generated, lock and vendored files in `excluded` with a short reason.",
  "Every run ID must appear exactly once: in one chapter or in `excluded`.",
  "Each chapter gets a short unique kebab-case `key` and a plain-language `headline`.",
].join("\n");

export function outlineInput(extract: ExtractResult, units: UnitView[]) {
  return {
    branch: extract.branch,
    commits: extract.commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      subject: c.subject,
      body: c.body,
    })),
    runs: units.map((u) => ({
      id: u.id,
      path: u.path,
      owners: u.owners.map((s) => s.slice(0, 7)),
      added: u.added,
      removed: u.removed,
      hunk: u.hunkHeader,
      ...(u.note ? { note: u.note } : {}),
      firstLines: u.changed.slice(0, 3).map(renderLine),
    })),
  };
}

function render(input: ReturnType<typeof outlineInput>): string {
  const commits = input.commits
    .map(
      (c) =>
        `- ${c.sha} ${c.subject}${c.body ? `\n  ${c.body.replace(/\n/g, "\n  ")}` : ""}`,
    )
    .join("\n");
  const runs = input.runs
    .map((r) =>
      [
        `- id ${r.id} · ${r.path} · commits ${r.owners.join(", ")} · +${r.added} −${r.removed}`,
        r.hunk ? `  ${r.hunk}` : `  (${r.note})`,
        ...r.firstLines.map((l) => `  ${l}`),
      ].join("\n"),
    )
    .join("\n");
  return `Branch: ${input.branch}\n\nCommits (oldest first):\n${commits}\n\nRuns:\n${runs}`;
}

export function checkOutline(
  value: OutlineOutput,
  unitIds: string[],
): string | null {
  if (value.chapters.length < 1 || value.chapters.length > MAX_CHAPTERS)
    return `there must be 1 to ${MAX_CHAPTERS} chapters, not ${value.chapters.length}`;
  const keys = new Set<string>();
  for (const ch of value.chapters) {
    if (ch.runIds.length === 0) return `chapter "${ch.key}" has no runs`;
    if (keys.has(ch.key)) return `chapter key "${ch.key}" is used twice`;
    keys.add(ch.key);
  }
  return checkCoverage(unitIds, [
    ...value.chapters.map((ch) => ({
      label: `chapter "${ch.key}"`,
      ids: ch.runIds,
    })),
    { label: "excluded", ids: value.excluded.map((e) => e.runId) },
  ]);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

/** One chapter per commit, units by their first run's owner; nothing excluded. */
export function outlineFallback(
  extract: ExtractResult,
  units: UnitView[],
): OutlineOutput {
  const runs = new Map(extract.runs.map((r) => [r.id, r]));
  const byCommit = new Map<string, string[]>();
  for (const u of units) {
    const owner = runs.get(u.runIds[0])!.commitSha;
    byCommit.set(owner, [...(byCommit.get(owner) ?? []), u.id]);
  }
  const ordered = extract.commits.filter((c) => byCommit.has(c.sha));
  // Units owned by a commit outside the list (it can't happen after extract's
  // owner fallback, but never drop a unit) join the last chapter.
  const orphans = [...byCommit.entries()]
    .filter(([sha]) => !ordered.some((c) => c.sha === sha))
    .flatMap(([, ids]) => ids);

  const chapters: OutlineOutput["chapters"] = [];
  const used = new Map<string, number>();
  ordered.forEach((commit, i) => {
    const ids = byCommit.get(commit.sha)!;
    if (i >= MAX_CHAPTERS) {
      chapters[MAX_CHAPTERS - 1].runIds.push(...ids);
      return;
    }
    const headline =
      commit.subject.trim() || `Commit ${commit.sha.slice(0, 7)}`;
    const base = slug(headline) || `commit-${commit.sha.slice(0, 7)}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    chapters.push({
      key: n === 1 ? base : `${base}-${n}`,
      headline,
      runIds: [...ids],
    });
  });
  if (ordered.length > MAX_CHAPTERS)
    chapters[MAX_CHAPTERS - 1].headline +=
      ` (and ${ordered.length - MAX_CHAPTERS} more commits)`;
  if (orphans.length) {
    if (chapters.length) chapters[chapters.length - 1].runIds.push(...orphans);
    else
      chapters.push({ key: "changes", headline: "Changes", runIds: orphans });
  }
  return { chapters, excluded: [] };
}

export function expandOutline(
  value: OutlineOutput,
  units: UnitView[],
): Outline {
  const runIdsOf = new Map(units.map((u) => [u.id, u.runIds]));
  return {
    chapters: value.chapters.map((ch) => ({
      key: ch.key,
      headline: ch.headline,
      unitIds: ch.runIds,
      runIds: ch.runIds.flatMap((id) => runIdsOf.get(id)!),
    })),
    excluded: value.excluded.flatMap((e) =>
      runIdsOf.get(e.runId)!.map((runId) => ({ runId, reason: e.reason })),
    ),
  };
}

export async function outline(opts: {
  extract: ExtractResult;
  units: UnitView[];
  llm: LlmClient;
  cache: StageCache;
}): Promise<{ outline: Outline; fallbackUsed: boolean }> {
  const input = outlineInput(opts.extract, opts.units);
  const unitIds = opts.units.map((u) => u.id);
  const result = await runLlmStage({
    stage: "outline",
    llm: opts.llm,
    cache: opts.cache,
    system: SYSTEM,
    user: render(input),
    input,
    schema: outlineSchema,
    check: (v) => checkOutline(v, unitIds),
    fallback: () => outlineFallback(opts.extract, opts.units),
  });
  return {
    outline: expandOutline(result.output, opts.units),
    fallbackUsed: result.fallbackUsed,
  };
}
