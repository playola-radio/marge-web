import {
  barLabel,
  indexDocument,
  isMarkdownBlock,
  roleOfForStep,
  runStats,
  segmentHunk,
  splitRows,
  stepBlocks,
} from "./diffModel";
import { fixtureDocument, mixedDocument } from "../../test/prReviewerFixtures";
import type { DiffHunk, DiffLine } from "../../Services/PrReviewerService";

describe("roleOfForStep", () => {
  const index = indexDocument(mixedDocument());

  test("marks this step's, later chapters' and excluded runs", () => {
    const roleOf = roleOfForStep(index, 0, 0);
    expect(roleOf("run-c1")).toEqual({ role: "this", chapter: 1 });
    expect(roleOf("run-c2a")).toEqual({ role: "later", chapter: 2 });
    expect(roleOf("run-x")).toEqual({ role: "excluded" });
    expect(roleOf(undefined)).toBeNull();
  });

  test("an earlier chapter's run is earlier", () => {
    expect(roleOfForStep(index, 1, 0)("run-c1")).toEqual({
      role: "earlier",
      chapter: 1,
    });
  });

  test("within one chapter, earlier and later steps are ordered by step", () => {
    const doc = fixtureDocument();
    const idx = indexDocument(doc);
    expect(roleOfForStep(idx, 0, 0)("run-setup-shared")).toEqual({
      role: "later",
      chapter: 1,
    });
    expect(roleOfForStep(idx, 0, 1)("run-setup-timeout")).toEqual({
      role: "earlier",
      chapter: 1,
    });
  });
});

describe("stepBlocks", () => {
  test("consecutive runs in one file share a block, with the hunks they touch", () => {
    const doc = mixedDocument();
    const blocks = stepBlocks(indexDocument(doc), doc.chapters[1].steps[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].path).toBe("src/mixed.ts");
    expect(blocks[0].runIds).toEqual(["run-c2a", "run-c2b"]);
    expect(blocks[0].hunks).toHaveLength(1);
  });

  test("markdown blocks are .md/.markdown files that are not deleted or binary", () => {
    const doc = fixtureDocument();
    const index = indexDocument(doc);
    const [readme] = stepBlocks(index, doc.chapters[1].steps[1]);
    expect(isMarkdownBlock(readme)).toBe(true);
    const [code] = stepBlocks(index, doc.chapters[1].steps[0]);
    expect(isMarkdownBlock(code)).toBe(false);
    expect(
      isMarkdownBlock({
        ...readme,
        file: { ...readme.file!, status: "deleted" },
      }),
    ).toBe(false);
  });
});

describe("segmentHunk", () => {
  const ctx = (n: number): DiffLine => ({
    kind: " ",
    oldNo: n,
    newNo: n,
    text: "",
  });
  const hunkWith = (
    len: number,
    changed: Record<number, string>,
  ): DiffHunk => ({
    header: "@@",
    oldStart: 1,
    oldLines: len,
    newStart: 1,
    newLines: len,
    lines: Array.from({ length: len }, (_, i) =>
      changed[i]
        ? { kind: "+", newNo: i + 1, text: "", runId: changed[i] }
        : ctx(i + 1),
    ),
  });

  test("shows the focus run ±3 lines and bars the rest", () => {
    const segments = segmentHunk(hunkWith(30, { 10: "a" }), new Set(["a"]));
    expect(segments).toEqual([
      { kind: "bar", start: 0, end: 7 },
      { kind: "lines", start: 7, end: 14 },
      { kind: "bar", start: 14, end: 30 },
    ]);
  });

  test("windows join across a gap of six lines or fewer", () => {
    // windows [2,9) and [15,22): gap of 6 → joined
    expect(
      segmentHunk(hunkWith(22, { 5: "a", 18: "a" }), new Set(["a"])),
    ).toEqual([
      { kind: "bar", start: 0, end: 2 },
      { kind: "lines", start: 2, end: 22 },
    ]);
  });

  test("windows stay apart across a gap of seven lines", () => {
    // windows [2,9) and [16,23): gap of 7 → a bar between
    const segments = segmentHunk(
      hunkWith(23, { 5: "a", 19: "a" }),
      new Set(["a"]),
    );
    expect(segments).toEqual([
      { kind: "bar", start: 0, end: 2 },
      { kind: "lines", start: 2, end: 9 },
      { kind: "bar", start: 9, end: 16 },
      { kind: "lines", start: 16, end: 23 },
    ]);
  });
});

test("barLabel counts the hidden lines and their chapters", () => {
  const doc = mixedDocument();
  const roleOf = roleOfForStep(indexDocument(doc), 0, 0);
  const lines = doc.files[0].hunks[0].lines.slice(8);
  expect(barLabel(lines, roleOf)).toBe("19 lines · 1 from ch 2");
  expect(barLabel(doc.files[0].hunks[0].lines.slice(2, 5), roleOf)).toBe(
    "3 lines · 1 from ch 2 · 2 not in a chapter",
  );
});

test("splitRows pairs removals with additions and repeats context on both sides", () => {
  const lines = fixtureDocument().files[0].hunks[0].lines;
  const rows = splitRows(lines);
  expect(
    rows.map((r) => [r.left?.oldNo ?? null, r.right?.newNo ?? null]),
  ).toEqual([
    [1, 1],
    [2, 2],
    [null, 3],
    [3, 4],
    [4, 5],
  ]);
});

test("runStats sums files, counts and owner commits", () => {
  const doc = fixtureDocument();
  expect(runStats(indexDocument(doc), doc.chapters[0].runIds)).toEqual({
    files: ["src/setup.ts"],
    added: 2,
    removed: 1,
    commits: ["1".repeat(40)],
  });
});
