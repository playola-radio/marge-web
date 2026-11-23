import { createHash } from "node:crypto";
import type { Git } from "./gitCache.js";

/**
 * Extract (reference §5): the pinned base → head diff as files → hunks →
 * lines, each changed line attributed to the commit that wrote it (blame for
 * added lines, reverse blame for removed ones), grouped into runs. Reads git
 * objects only — never a work tree — and, after one batch hydration of a
 * partial clone, never touches the network.
 */

export interface ExtractCommit {
  sha: string;
  subject: string;
  body: string;
  author: string;
  date: string;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  kind: " " | "+" | "-";
  oldNo?: number;
  newNo?: number;
  text: string;
  runId?: string;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

export interface Run {
  id: string;
  path: string;
  commitSha: string;
  added: number;
  removed: number;
  oldRange?: [number, number];
  newRange?: [number, number];
}

/** A changed line whose blame disagreed with the diff and inherited an owner. */
export interface OwnerFallback {
  path: string;
  kind: "+" | "-";
  oldNo?: number;
  newNo?: number;
  text: string;
  owner: string;
  /** boundary: blame says unchanged; survived: reverse blame says it still exists; outside: owner isn't a branch commit; no-blame: the file can't be blamed. */
  reason: "boundary" | "survived" | "outside" | "no-blame";
}

export interface ExtractResult {
  baseRef: string;
  baseSha: string;
  headSha: string;
  branch: string;
  repo: string;
  commits: ExtractCommit[];
  files: FileDiff[];
  runs: Run[];
  ownerFallbacks: OwnerFallback[];
}

/** Full head text of a changed markdown file, for the rendered-markdown view. */
export interface MarkdownSource {
  path: string;
  text: string;
}

export interface ExtractOutput {
  result: ExtractResult;
  markdownSources: MarkdownSource[];
}

/** Touching runs in one hunk, placed by the LLM stages as one; named by its first run. */
export interface Unit {
  id: string;
  path: string;
  runIds: string[];
}

export const MARKDOWN_MAX_BYTES = 1024 * 1024;
const MARKDOWN_PATH = /\.(md|markdown)$/i;
const ZERO_SHA = /^0+$/;
const GITLINK_MODE = "160000";

export interface ExtractOptions {
  git: Git;
  /** The (bare) repository holding both pinned commits. */
  gitDir: string;
  baseSha: string;
  headSha: string;
  baseRef: string;
  branch: string;
  repo: string;
  /** Token for the one hydration fetch a partial clone needs. */
  auth?: () => Promise<string>;
  /** Aborts the hydration fetch (see `CacheLease.withSizeCap`). */
  signal?: AbortSignal;
}

interface RawEntry {
  oldMode: string;
  newMode: string;
  newSha: string;
  status: string;
  path: string;
  oldPath?: string;
}

interface Owner {
  sha: string | null;
  reason?: OwnerFallback["reason"];
}

export async function extract(opts: ExtractOptions): Promise<ExtractOutput> {
  const { git, gitDir: cwd, baseSha, headSha } = opts;
  const range = `${baseSha}..${headSha}`;
  const run = (args: string[]) => git.run(args, { cwd });

  await hydrate(opts);

  const commits = parseCommits(
    await run([
      "log",
      "--reverse",
      "--no-merges",
      "--format=%H%x00%an%x00%aI%x00%s%x00%b%x00",
      range,
    ]),
  );
  const commitShas = new Set(commits.map((c) => c.sha));
  const children = new Map<string, string[]>();
  for (const line of (
    await run(["rev-list", "--reverse", "--parents", range])
  ).split("\n")) {
    const [sha, ...parents] = line.trim().split(" ");
    if (!sha) continue;
    for (const p of parents) children.set(p, [...(children.get(p) ?? []), sha]);
  }

  const diffArgs = [
    "diff",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
  ];
  const raw = parseRaw(
    await run([...diffArgs, "--raw", "-z", "--no-abbrev", baseSha, headSha]),
  );
  const patches = parsePatch(await run([...diffArgs, "-U3", baseSha, headSha]));
  if (patches.length !== raw.length)
    throw new Error(
      `Diff parse mismatch: ${raw.length} files but ${patches.length} patches`,
    );

  const lastTouchCache = new Map<string, string>();
  const lastTouch = async (entry: RawEntry): Promise<string> => {
    const key = entry.path;
    const cached = lastTouchCache.get(key);
    if (cached) return cached;
    const paths = entry.oldPath ? [entry.path, entry.oldPath] : [entry.path];
    const out = (
      await run([
        "log",
        "-1",
        "--no-merges",
        "--format=%H",
        range,
        "--",
        ...paths,
      ])
    ).trim();
    const sha = out || commits[commits.length - 1]?.sha || headSha;
    lastTouchCache.set(key, sha);
    return sha;
  };

  const files: FileDiff[] = [];
  const runs: Run[] = [];
  const ownerFallbacks: OwnerFallback[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    const patch = patches[i];
    const file: FileDiff = {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: statusOf(entry.status),
      binary: patch.binary,
      hunks: patch.hunks,
    };
    files.push(file);

    if (file.binary || file.hunks.length === 0) {
      // Binary, pure rename, mode-only or empty file: one content-less run,
      // so nothing is silently hidden.
      runs.push({
        id: runId(file.path, undefined, undefined, []),
        path: file.path,
        commitSha: await lastTouch(entry),
        added: 0,
        removed: 0,
      });
      continue;
    }

    const blameable =
      entry.oldMode !== GITLINK_MODE && entry.newMode !== GITLINK_MODE;
    const hasAdded = file.hunks.some((h) =>
      h.lines.some((l) => l.kind === "+"),
    );
    const hasRemoved = file.hunks.some((h) =>
      h.lines.some((l) => l.kind === "-"),
    );
    const forward =
      blameable && hasAdded
        ? parseBlame(
            await run(["blame", "-w", "--porcelain", range, "--", entry.path]),
          )
        : null;
    const reverse =
      blameable && hasRemoved
        ? parseBlame(
            await run([
              "blame",
              "-w",
              "--reverse",
              "--porcelain",
              range,
              "--",
              entry.oldPath ?? entry.path,
            ]),
          )
        : null;

    const ownerOf = (line: DiffLine): Owner => {
      if (line.kind === "+") {
        if (!forward) return { sha: null, reason: "no-blame" };
        const sha = forward.lines.get(line.newNo!);
        if (!sha || forward.boundary.has(sha))
          return { sha: null, reason: "boundary" };
        return commitShas.has(sha) ? { sha } : { sha: null, reason: "outside" };
      }
      if (!reverse) return { sha: null, reason: "no-blame" };
      // Reverse blame gives the last commit in which the base line still
      // existed; the line's owner is that commit's child — the one deleting it.
      const lastSeen = reverse.lines.get(line.oldNo!);
      if (!lastSeen) return { sha: null, reason: "no-blame" };
      if (lastSeen === headSha) return { sha: null, reason: "survived" };
      const child = (children.get(lastSeen) ?? []).find((c) =>
        commitShas.has(c),
      );
      return child ? { sha: child } : { sha: null, reason: "outside" };
    };

    for (const hunk of file.hunks) {
      const changed = hunk.lines.filter((l) => l.kind !== " ");
      const found = changed.map(ownerOf);
      const resolved: string[] = [];
      for (let j = 0; j < changed.length; j += 1) {
        if (found[j].sha) {
          resolved.push(found[j].sha!);
          continue;
        }
        // Disagreement: nearest preceding changed line in the hunk, else the
        // nearest following, else the last commit that touched the file.
        let owner: string | null = null;
        for (let k = j - 1; k >= 0 && !owner; k -= 1) owner = found[k].sha;
        for (let k = j + 1; k < changed.length && !owner; k += 1)
          owner = found[k].sha;
        owner ??= await lastTouch(entry);
        resolved.push(owner);
        const line = changed[j];
        ownerFallbacks.push({
          path: file.path,
          kind: line.kind as "+" | "-",
          ...(line.oldNo !== undefined ? { oldNo: line.oldNo } : {}),
          ...(line.newNo !== undefined ? { newNo: line.newNo } : {}),
          text: line.text,
          owner,
          reason: found[j].reason!,
        });
      }
      const ownerByLine = new Map(changed.map((l, j) => [l, resolved[j]]));
      runs.push(...splitRuns(file.path, hunk, ownerByLine));
    }
  }

  const markdownSources = await readMarkdown(git, cwd, raw, files);

  return {
    result: {
      baseRef: opts.baseRef,
      baseSha,
      headSha,
      branch: opts.branch,
      repo: opts.repo,
      commits,
      files,
      runs,
      ownerFallbacks,
    },
    markdownSources,
  };
}

/** Groups the runs of an extract into units (glossary: touching runs in one hunk). */
export function unitsOf(result: ExtractResult): Unit[] {
  const units: Unit[] = [];
  for (const file of result.files) {
    if (file.hunks.length === 0) {
      for (const r of result.runs.filter((r) => r.path === file.path))
        units.push({ id: r.id, path: file.path, runIds: [r.id] });
      continue;
    }
    for (const hunk of file.hunks) {
      let current: Unit | null = null;
      for (const line of hunk.lines) {
        if (line.kind === " " || !line.runId) {
          current = null;
          continue;
        }
        if (!current) {
          current = { id: line.runId, path: file.path, runIds: [line.runId] };
          units.push(current);
        } else if (current.runIds[current.runIds.length - 1] !== line.runId) {
          current.runIds.push(line.runId);
        }
      }
    }
  }
  return units;
}

/**
 * Partial clones start without blobs. Before any blame or object read, fetch
 * — in one authenticated batch — both sides of every file change the branch's
 * commits make, so no read ever falls back to a per-blob network fetch.
 */
async function hydrate(opts: ExtractOptions): Promise<void> {
  const { git, gitDir: cwd } = opts;
  let promisor = "";
  try {
    promisor = (
      await git.run(["config", "--get", "remote.origin.promisor"], { cwd })
    ).trim();
  } catch {
    return; // not a partial clone
  }
  if (promisor !== "true") return;

  const log = await git.run(
    [
      "log",
      "--format=",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--diff-merges=separate",
      `${opts.baseSha}..${opts.headSha}`,
    ],
    { cwd },
  );
  const blobs = new Set<string>();
  for (const line of log.split("\n")) {
    const m = line.match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) /);
    if (!m) continue;
    if (m[1] !== GITLINK_MODE && !ZERO_SHA.test(m[3])) blobs.add(m[3]);
    if (m[2] !== GITLINK_MODE && !ZERO_SHA.test(m[4])) blobs.add(m[4]);
  }
  if (blobs.size === 0) return;
  const check = await git.run(["cat-file", "--batch-check"], {
    cwd,
    input: [...blobs].join("\n") + "\n",
  });
  const missing = check
    .split("\n")
    .filter((l) => l.endsWith(" missing"))
    .map((l) => l.split(" ")[0]);
  if (missing.length === 0) return;
  await git.run(
    [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-auto-gc",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
      "origin",
    ],
    {
      cwd,
      auth: opts.auth,
      signal: opts.signal,
      input: missing.join("\n") + "\n",
    },
  );
}

async function readMarkdown(
  git: Git,
  cwd: string,
  raw: RawEntry[],
  files: FileDiff[],
): Promise<MarkdownSource[]> {
  const sources: MarkdownSource[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (
      file.status === "deleted" ||
      file.binary ||
      !MARKDOWN_PATH.test(file.path)
    )
      continue;
    const sha = raw[i].newSha;
    if (raw[i].newMode === GITLINK_MODE || ZERO_SHA.test(sha)) continue;
    const size = Number(
      (await git.run(["cat-file", "-s", sha], { cwd })).trim(),
    );
    if (size > MARKDOWN_MAX_BYTES) continue;
    const bytes = await git.runRaw(["cat-file", "blob", sha], { cwd });
    if (bytes.includes(0)) continue;
    sources.push({ path: file.path, text: bytes.toString("utf8") });
  }
  return sources;
}

function splitRuns(
  path: string,
  hunk: Hunk,
  ownerByLine: Map<DiffLine, string>,
): Run[] {
  const runs: Run[] = [];
  let group: DiffLine[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const removed = group.filter((l) => l.kind === "-");
    const added = group.filter((l) => l.kind === "+");
    const oldRange: [number, number] | undefined = removed.length
      ? [removed[0].oldNo!, removed[removed.length - 1].oldNo!]
      : undefined;
    const newRange: [number, number] | undefined = added.length
      ? [added[0].newNo!, added[added.length - 1].newNo!]
      : undefined;
    const id = runId(path, oldRange, newRange, group);
    for (const l of group) l.runId = id;
    runs.push({
      id,
      path,
      commitSha: ownerByLine.get(group[0])!,
      added: added.length,
      removed: removed.length,
      ...(oldRange ? { oldRange } : {}),
      ...(newRange ? { newRange } : {}),
    });
    group = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === " ") {
      flush();
      continue;
    }
    if (group.length && ownerByLine.get(group[0]) !== ownerByLine.get(line))
      flush();
    group.push(line);
  }
  flush();
  return runs;
}

/** First 12 hex of sha256(path, oldRange, newRange, changed lines with their +/- kind). */
function runId(
  path: string,
  oldRange: [number, number] | undefined,
  newRange: [number, number] | undefined,
  changed: DiffLine[],
): string {
  const range = (r?: [number, number]) => (r ? `${r[0]}-${r[1]}` : "");
  return createHash("sha256")
    .update(
      [
        path,
        range(oldRange),
        range(newRange),
        changed.map((l) => `${l.kind}${l.text}`).join("\n"),
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 12);
}

function statusOf(letter: string): FileStatus {
  switch (letter[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

function parseCommits(out: string): ExtractCommit[] {
  const fields = out.split("\0");
  const commits: ExtractCommit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    commits.push({
      sha: fields[i].replace(/^\n/, ""),
      author: fields[i + 1],
      date: fields[i + 2],
      subject: fields[i + 3],
      body: fields[i + 4].trim(),
    });
  }
  return commits;
}

function parseRaw(out: string): RawEntry[] {
  const parts = out.split("\0");
  const entries: RawEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i];
    if (!meta.startsWith(":")) {
      i += 1;
      continue;
    }
    const [oldMode, newMode, , newSha, status] = meta.slice(1).split(" ");
    if (status.startsWith("R")) {
      entries.push({
        oldMode,
        newMode,
        newSha,
        status,
        oldPath: parts[i + 1],
        path: parts[i + 2],
      });
      i += 3;
    } else if (status === "T") {
      // A type change (file ↔ symlink ↔ submodule) is patched as a deletion
      // then a creation, so it becomes those two entries.
      const path = parts[i + 1];
      entries.push({
        oldMode,
        newMode: "000000",
        newSha: "0",
        status: "D",
        path,
      });
      entries.push({ oldMode: "000000", newMode, newSha, status: "A", path });
      i += 2;
    } else {
      entries.push({
        oldMode,
        newMode,
        newSha,
        status,
        path: parts[i + 1],
      });
      i += 2;
    }
  }
  return entries;
}

interface Patch {
  binary: boolean;
  hunks: Hunk[];
}

function parsePatch(out: string): Patch[] {
  const patches: Patch[] = [];
  let current: Patch | null = null;
  let hunk: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;
  const lines = out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const kind = line[0];
      if (kind === "\\") continue; // "\ No newline at end of file"
      const text = line.slice(1);
      if (kind === "+") {
        hunk.lines.push({ kind: "+", newNo, text });
        newNo += 1;
        newLeft -= 1;
      } else if (kind === "-") {
        hunk.lines.push({ kind: "-", oldNo, text });
        oldNo += 1;
        oldLeft -= 1;
      } else {
        hunk.lines.push({ kind: " ", oldNo, newNo, text });
        oldNo += 1;
        newNo += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    hunk = null;
    if (line.startsWith("diff --git ")) {
      current = { binary: false, hunks: [] };
      patches.push(current);
      continue;
    }
    if (!current) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (
      current.hunks.length === 0 &&
      (line.startsWith("Binary files ") || line === "GIT binary patch")
    )
      current.binary = true;
  }
  return patches;
}

interface Blame {
  /** Final line number → commit. */
  lines: Map<number, string>;
  boundary: Set<string>;
}

function parseBlame(out: string): Blame {
  const lines = new Map<number, string>();
  const boundary = new Set<string>();
  let sha = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("\t")) continue;
    const header = line.match(
      /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)(?: \d+)?$/,
    );
    if (header) {
      sha = header[1];
      lines.set(Number(header[2]), sha);
    } else if (line === "boundary") {
      boundary.add(sha);
    }
  }
  return { lines, boundary };
}
