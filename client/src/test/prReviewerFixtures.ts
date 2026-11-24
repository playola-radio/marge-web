import serverDocument from "../../../server/src/api/prReviewer/fixtures/chaptersDocument.json";
import type {
  ChaptersDocument,
  CurrentPr,
  DiffLine,
  LatestResponse,
  Run,
} from "../Services/PrReviewerService";

/**
 * The schema-valid chapters document PR 4's server tests serve
 * (server/src/api/prReviewer/fixtures/chaptersDocument.json), shared so the
 * page is tested against exactly what the API returns.
 */
export function fixtureDocument(): ChaptersDocument {
  return structuredClone(serverDocument) as unknown as ChaptersDocument;
}

export const HEAD_A = "ef9d1d7a8c0b4a5d9e2f3a4b5c6d7e8f9a0b1c2d";
export const BASE_A = "2f26b5d1c3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8";
export const HEAD_B = "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00";
export const BASE_B = "3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e";

export const RUN_A = "0d4f8a1e-6c2b-4b4e-9a1a-2f6f1f1f9b3c";
export const RUN_B = "7e1c2b3a-4d5e-4f60-8172-839405162738";

export function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN_A,
    org: "playola-radio",
    repo: "playola",
    prNumber: 123,
    headSha: HEAD_A,
    baseSha: BASE_A,
    pipelineVersion: "1",
    status: "ready",
    progress: null,
    failure: null,
    failureDetail: null,
    pr: {
      title: "Fix flaky tests by cutting slow git setup work",
      url: "https://github.com/playola-radio/playola/pull/123",
      baseRef: "main",
      headRef: "brian-keane/chapters-flaky-test-fix",
      commits: 2,
    },
    createdAt: "2026-11-22T17:30:00.000Z",
    updatedAt: "2026-11-22T17:31:12.000Z",
    ...overrides,
  };
}

export function makePr(overrides: Partial<CurrentPr> = {}): CurrentPr {
  return {
    title: "Fix flaky tests by cutting slow git setup work",
    url: "https://github.com/playola-radio/playola/pull/123",
    baseRef: "main",
    headRef: "brian-keane/chapters-flaky-test-fix",
    commits: 2,
    currentHeadSha: HEAD_A,
    currentBaseSha: BASE_A,
    ...overrides,
  };
}

export function latest(
  run: Run | null,
  pr: Partial<CurrentPr> = {},
  newerRun?: Run,
): LatestResponse {
  return { pr: makePr(pr), run, ...(newerRun ? { newerRun } : {}) };
}

/** The README.md text at the fixture's head, for the rendered markdown view. */
export const README_TEXT = [
  "# Playola",
  "",
  "## Testing",
  "",
  "Run `npm test`. Flaky calls retry up to **three** times:",
  "",
  "- see `src/retry.ts`",
  "",
].join("\n");

/* ---- Synthetic documents for renderer tests ---- */

const ctx = (oldNo: number, newNo: number, text: string) =>
  ({ kind: " ", oldNo, newNo, text }) as DiffLine;
const add = (newNo: number, runId: string, text: string) =>
  ({ kind: "+", newNo, text, runId }) as DiffLine;
const del = (oldNo: number, runId: string, text: string) =>
  ({ kind: "-", oldNo, text, runId }) as DiffLine;

/**
 * Two chapters and an excluded run sharing one file, `src/mixed.ts`:
 * one hunk where chapter 1 adds line 2, chapter 2 adds line 3, the excluded
 * run changes line 4, and a second change by chapter 2 sits 20 lines further
 * down (so chapter 1's window collapses it behind a bar).
 */
export function mixedDocument(): ChaptersDocument {
  const lines: DiffLine[] = [
    ctx(1, 1, "const a = 1;"),
    add(2, "run-c1", "const b = 2;"),
    add(3, "run-c2a", "const c = 3;"),
    del(2, "run-x", 'const v = "1";'),
    add(4, "run-x", 'const v = "2";'),
  ];
  for (let i = 0; i < 20; i += 1) lines.push(ctx(3 + i, 5 + i, `filler ${i}`));
  lines.push(add(25, "run-c2b", "export const late = true;"));
  lines.push(ctx(23, 26, "// end"));
  return {
    ...fixtureDocument(),
    files: [
      {
        path: "src/mixed.ts",
        status: "modified",
        binary: false,
        hunks: [
          {
            header: "@@ -1,23 +1,26 @@",
            oldStart: 1,
            oldLines: 23,
            newStart: 1,
            newLines: 26,
            lines,
          },
        ],
      },
    ],
    runs: [
      {
        id: "run-c1",
        path: "src/mixed.ts",
        commitSha: "1".repeat(40),
        added: 1,
        removed: 0,
      },
      {
        id: "run-c2a",
        path: "src/mixed.ts",
        commitSha: "2".repeat(40),
        added: 1,
        removed: 0,
      },
      {
        id: "run-x",
        path: "src/mixed.ts",
        commitSha: "1".repeat(40),
        added: 1,
        removed: 1,
      },
      {
        id: "run-c2b",
        path: "src/mixed.ts",
        commitSha: "2".repeat(40),
        added: 1,
        removed: 0,
      },
    ],
    chapters: [
      {
        key: "first",
        number: 1,
        headline: "Add b",
        intro: "Adds b.",
        runIds: ["run-c1"],
        steps: [{ runIds: ["run-c1"], explanation: "b is two." }],
      },
      {
        key: "second",
        number: 2,
        headline: "Add c and late",
        intro: "Adds c and the late flag.",
        runIds: ["run-c2a", "run-c2b"],
        steps: [{ runIds: ["run-c2a", "run-c2b"], explanation: "c and late." }],
      },
    ],
    excluded: [{ runId: "run-x", reason: "Version bump" }],
  };
}
