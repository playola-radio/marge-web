import { markdownView, type MdEntry } from "./markdownBlocks";
import type { RoleOf, StepBlock } from "./diffModel";
import type { DiffLine } from "../../Services/PrReviewerService";

/**
 * Builds a one-hunk markdown StepBlock from the old and new texts, with each
 * changed line's runId supplied by `owner(kind, lineNo)`.
 */
function blockFor(lines: DiffLine[], runIds: string[] = ["r-this"]): StepBlock {
  return {
    path: "README.md",
    file: {
      path: "README.md",
      status: "modified",
      binary: false,
      hunks: [
        {
          header: "@@",
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 0,
          lines,
        },
      ],
    },
    runIds,
    hunks: [
      {
        header: "@@",
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 0,
        lines,
      },
    ],
  };
}

const roleOf: RoleOf = (runId) => {
  if (!runId) return null;
  if (runId === "r-this") return { role: "this", chapter: 1 };
  if (runId === "r-later") return { role: "later", chapter: 3 };
  if (runId === "r-earlier") return { role: "earlier", chapter: 1 };
  if (runId === "r-x") return { role: "excluded" };
  return null;
};

/** Context lines for every new-side line of `text`, except those in `changed`. */
function linesFor(
  text: string,
  changed: Record<number, { runId: string }>,
  deletions: Record<number, { runId: string; count: number }> = {},
): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 1;
  text.split("\n").forEach((t, i) => {
    const newNo = i + 1;
    const del = deletions[newNo];
    if (del) {
      for (let k = 0; k < del.count; k += 1) {
        out.push({ kind: "-", oldNo: oldNo++, text: "gone", runId: del.runId });
      }
    }
    const c = changed[newNo];
    if (c) out.push({ kind: "+", newNo, text: t, runId: c.runId });
    else out.push({ kind: " ", oldNo: oldNo++, newNo, text: t });
  });
  return out;
}

const blocks = (entries: MdEntry[]) =>
  entries.filter((e) => e.kind === "block");

describe("innermost token per changed line", () => {
  test("a changed list item is marked, not the whole list", () => {
    const text = "- one\n- two\n- three";
    const view = markdownView(
      text,
      blockFor(linesFor(text, { 2: { runId: "r-this" } })),
      roleOf,
    );
    const html = blocks(view.entries)
      .map((b) => b.html)
      .join("");
    expect(html).toMatch(/<li class="md-this">two<\/li>/);
    expect(html).toMatch(/<ul>/);
    expect(html).toMatch(/<li>one<\/li>/);
  });

  test("a changed table row is marked", () => {
    const text = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
    const view = markdownView(
      text,
      blockFor(linesFor(text, { 4: { runId: "r-this" } })),
      roleOf,
    );
    const html = blocks(view.entries)
      .map((b) => b.html)
      .join("");
    expect(html).toMatch(/<tr class="md-this">\s*<td>3<\/td>/);
    expect(html).toMatch(/<tr>\s*<td>1<\/td>/);
  });

  test("another chapter's row in a hunk this step doesn't touch is still marked", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| ${i + 1} | x |`);
    const text = ["| a | b |", "| - | - |", ...rows].join("\n");
    const lines = linesFor(text, {
      3: { runId: "r-this" },
      30: { runId: "r-later" },
    });
    const hunk = (from: number, to: number) => ({
      header: "@@",
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 0,
      lines: lines.slice(from, to),
    });
    const block = blockFor([]);
    block.file!.hunks = [hunk(0, 8), hunk(24, lines.length)];
    block.hunks = [block.file!.hunks[0]];
    const html = blocks(markdownView(text, block, roleOf).entries)
      .map((b) => b.html)
      .join("");
    expect(html).toMatch(/<tr class="md-this">\s*<td>1<\/td>/);
    expect(html).toMatch(/<tr class="md-later">\s*<td>28<\/td>/);
  });

  test("a nested list item is marked, not its parent", () => {
    const text = "- one\n  - inner\n- two";
    const view = markdownView(
      text,
      blockFor(linesFor(text, { 2: { runId: "r-this" } })),
      roleOf,
    );
    const html = blocks(view.entries)
      .map((b) => b.html)
      .join("");
    expect(html).toMatch(/<li class="md-this">inner<\/li>/);
    expect(html).toMatch(/<li>one\n?<ul>/);
  });

  test("a fence opened above the hunk renders as a fence", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```";
    const lines = linesFor(text, { 3: { runId: "r-this" } }).slice(1);
    const view = markdownView(text, blockFor(lines), roleOf);
    const html = blocks(view.entries)
      .map((b) => b.html)
      .join("");
    expect(html).toContain("<pre>");
    expect(html).toContain("const b = 2;");
    expect(html).not.toContain("```");
  });

  test("one token holding several chapters' lines takes the strongest role: this > later > earlier > excluded", () => {
    const text = "para line one\npara line two\npara line three";
    const view = markdownView(
      text,
      blockFor(
        linesFor(text, {
          1: { runId: "r-x" },
          2: { runId: "r-later" },
          3: { runId: "r-earlier" },
        }),
        ["r-this"],
      ),
      roleOf,
    );
    const [block] = blocks(view.entries);
    expect(block.html).toMatch(/<p class="md-later">/);
    expect(block.laterChapters).toEqual([3]);
    expect(block.excluded).toBe(true);
  });

  test("a blank added line outside code carries no role, so an inserted paragraph marks only itself", () => {
    const text = "first\n\nnew para\n\nlast";
    const view = markdownView(
      text,
      blockFor(
        linesFor(text, { 2: { runId: "r-this" }, 3: { runId: "r-this" } }),
      ),
      roleOf,
    );
    const html = blocks(view.entries).map((b) => b.html);
    expect(html).toEqual([
      "<p>first</p>\n",
      '<p class="md-this">new para</p>\n',
      "<p>last</p>\n",
    ]);
  });

  test("inside a code fence a blank added line is content and carries its role", () => {
    const text = "```\na\n\nb\n```";
    const view = markdownView(
      text,
      blockFor(linesFor(text, { 3: { runId: "r-this" } })),
      roleOf,
    );
    expect(blocks(view.entries)[0].html).toContain('class="md-this"');
  });
});

describe("visible blocks and bars", () => {
  test("blocks outside the step's windows fold into a bar", () => {
    const paras = Array.from({ length: 12 }, (_, i) => `para ${i + 1}`);
    const text = paras.join("\n\n");
    // para 12 sits on line 23; the window covers lines 20–23.
    const view = markdownView(
      text,
      blockFor(linesFor(text, { 23: { runId: "r-this" } })),
      roleOf,
    );
    const [bar, ...rest] = view.entries;
    expect(bar.kind).toBe("bar");
    if (bar.kind !== "bar") throw new Error();
    expect(bar.blocks).toBe(10);
    expect(rest.map((e) => e.kind)).toEqual(["block", "block"]);
  });
});

describe("removal markers", () => {
  test("a pure deletion is one marker with its count, before the next block", () => {
    const text = "first\n\nlast";
    // Three lines deleted just before "last" (line 3).
    const view = markdownView(
      text,
      blockFor(linesFor(text, {}, { 3: { runId: "r-this", count: 3 } })),
      roleOf,
    );
    expect(view.entries.map((e) => e.kind)).toEqual([
      "block",
      "marker",
      "block",
    ]);
    const marker = view.entries[1];
    if (marker.kind !== "marker") throw new Error();
    expect(marker.count).toBe(3);
    expect(marker.role).toBe("this");
  });

  test("a deletion at the end of the file goes after the last block", () => {
    const text = "only";
    const lines: DiffLine[] = [
      { kind: " ", oldNo: 1, newNo: 1, text: "only" },
      { kind: "-", oldNo: 2, text: "gone", runId: "r-this" },
    ];
    const view = markdownView(text, blockFor(lines), roleOf);
    expect(view.entries.map((e) => e.kind)).toEqual(["block", "marker"]);
  });

  test("a replaced line is highlighted and gets no marker", () => {
    const text = "first\n\nnew text";
    const lines: DiffLine[] = [
      { kind: " ", oldNo: 1, newNo: 1, text: "first" },
      { kind: " ", oldNo: 2, newNo: 2, text: "" },
      { kind: "-", oldNo: 3, text: "old text", runId: "r-this" },
      { kind: "+", newNo: 3, text: "new text", runId: "r-this" },
    ];
    const view = markdownView(text, blockFor(lines), roleOf);
    expect(view.entries.some((e) => e.kind === "marker")).toBe(false);
    expect(blocks(view.entries)[1].html).toContain('class="md-this"');
    expect(
      blocks(view.entries)
        .map((b) => b.html)
        .join(""),
    ).not.toContain("old text");
  });
});

test("a file the step adds whole gets no per-block tint", () => {
  const text = "# Title\n\nbody";
  const lines: DiffLine[] = text
    .split("\n")
    .map((t, i) => ({ kind: "+", newNo: i + 1, text: t, runId: "r-this" }));
  const view = markdownView(text, blockFor(lines), roleOf);
  expect(view.wholeFileAdded).toBe(true);
  expect(
    blocks(view.entries)
      .map((b) => b.html)
      .join(""),
  ).not.toContain("md-this");
  expect(blocks(view.entries).every((b) => b.changedHere)).toBe(true);
});

/** The page's rendering of `text` as a file the step adds whole. */
function renderMarkdown(text: string): string {
  const lines: DiffLine[] = text
    .split("\n")
    .map((t, i) => ({ kind: "+", newNo: i + 1, text: t, runId: "r-this" }));
  return blocks(markdownView(text, blockFor(lines), roleOf).entries)
    .map((b) => b.html)
    .join("");
}

describe("safety", () => {
  test("raw HTML is escaped", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("a javascript: link has no href", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toMatch(/href=/);
  });

  test("images become text and are never loaded", () => {
    const html = renderMarkdown("![a cat](https://example.com/cat.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("[image: a cat]");
  });

  test("a relative link has no href; an absolute one opens in a new tab", () => {
    expect(renderMarkdown("[docs](./docs.md)")).toMatch(
      /<span class="md-link">docs<\/span>/,
    );
    expect(renderMarkdown("[gh](https://github.com)")).toContain(
      '<a href="https://github.com" target="_blank" rel="noopener noreferrer">gh</a>',
    );
  });

  test("task list items render a disabled checkbox", () => {
    const html = renderMarkdown("- [x] done\n- [ ] todo");
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('<input type="checkbox" disabled>');
    expect(html).not.toContain("[x]");
  });
});
