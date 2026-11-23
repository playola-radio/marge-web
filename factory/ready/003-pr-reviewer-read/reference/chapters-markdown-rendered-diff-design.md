# Chapters: markdown changes render as markdown

**Status:** approved design, 2026-11-12. It extends the chapter page (`2026-10-20-chapters-mvp-design.md` §8). Extract, outline, write and summarize are unchanged.

## 1. Goal

A markdown file changed in a chapter step is shown **rendered**, with this step's changes highlighted. The old text isn't shown. One click switches that block to the usual split code diff.

- **Which files:** a step block (`StepView`) whose path ends in `.md` or `.markdown` (case-insensitive), whose file `status` isn't `deleted`, and which isn't `binary`. `.mdx` is left out because it holds JSX.
- **Where:** chapter steps only. The file order view, the excluded panel and the QA pages stay code-only.
- **Toggle:** each such block's `block-head` gets two buttons, **Rendered** and **Code**, with `aria-pressed` on each. Rendered is the default. The choice is per block, kept in component state, and lost on reload.

## 2. Server: `GET /api/file?path=<path>`

Returns `{ path, text }`: the file at the tour's `headSha`. That is the file's text as the diff's new side has it, even if the user's HEAD has moved since.

- **Reading:** `RepoLookups.readRaw(path)` (new). It reuses `entry("head", p)`, `cat-file blob` and `NO_PROMPT`, so a blobless clone lazily fetches the one blob. It returns the whole text, not numbered lines.
- **Allow-list:** only paths in `chapters.files` that §1 counts as markdown are served. Any other path gets a 404 `{ error }`. The endpoint can't be used to read arbitrary repo files.
- **Limits:** the text is capped at 1 MB (`MARKDOWN_MAX_BYTES`). A larger file, or one with a NUL byte, gets a 422 `{ error }` naming the reason ("too big to render", "binary file").
- **Methods:** GET, and HEAD as GET, like every other read route. It's added to the route table in `server.ts`.
- **Errors:** a git failure is a 500 `{ error }` with the usual redaction.

The UI fetches each path at most once a page load (a `Map<path, Promise>` in a `useMarkdownFile` hook), because several steps may show the same README.

## 3. Rendering

### 3.1 Parser

Uses `markdown-it`, configured `{ html: false, linkify: false, typographer: false }`, with its built-in GFM tables and strikethrough. It's the standard choice when rendered blocks have to map back to source lines; VS Code's markdown preview uses it for that. Every block-level token has `map: [startLine, endLine)`, 0-based.

The whole file is parsed, never a hunk on its own. A code fence, list or table that starts above the hunk still renders correctly.

### 3.2 `markdownBlocks.ts` (pure, no DOM)

`markdownView(text, block, roleOf)` takes the file text, the `StepBlock` and the step's `roleOf`. It returns the view model:

- **Line roles:** each new-side `+` line in the block's hunks has a role (`this`, `earlier`, `later`, `excluded`, from `roleFor`).
- **Innermost block:** each changed line is attached to the deepest block token whose `map` covers it: a list item, table row, paragraph, heading, fence, `hr` or blockquote paragraph, not the whole list. A token's strongest role, ranked `this` > `later` > `earlier` > `excluded`, becomes a class on its opening tag (`md-this`, `md-earlier`, `md-later`, `md-excluded`). The text signals (the `ch N` and `not in a chapter` tags, the hidden "changed in this step" label) are given once per top-level block, from every role in it, because the rendered HTML is a string that components can't be put inside. A blank added line carries no role, because inserting a paragraph diffs as its lines plus one blank `+` line, and that line mustn't mark the unchanged block beside it. Inside a code fence or indented code, a blank line is content, so there it does carry its role. A line no token covers (a blank line between blocks, a link definition) carries no role either. For note and marker placement only, such a line goes with the next top-level block, or the last one at the end of the file.
- **Visible blocks:** the top-level (`level === 0`) blocks whose `map` overlaps a new-side line of the block's `lines` segments. Those are the ±3 windows `segmentHunk` already computes. Each maximal run of hidden top-level blocks becomes a bar, `▸ N blocks`, that expands in place. As in `SplitDiff`, focus moves to the first revealed block.
- **Removal markers:** a pure deletion, meaning consecutive `-` lines with no `+` line directly before or after them, forms one marker. A replaced line (`-` next to `+`) gets no marker, because its new text is already highlighted. The marker reads `− N lines removed`. It sits before the block that holds the `newNo` of the next context or `+` line in the hunk. If no such line follows, it goes after the block holding the previous one, or at the end of the file. A marker carries its old-side line range and the strongest role of its lines, coloured as in §3.3. The deleted text isn't shown.
- **HTML:** each visible top-level block is rendered by the markdown-it renderer, with the role classes already added to the tokens. The result is set with `dangerouslySetInnerHTML`. That's safe because of §3.4.

### 3.3 Styling (spec §8 roles)

| Role | Look |
| --- | --- |
| `this` | green left rule and a light green tint |
| `earlier` | the same rule and tint at the faint opacity code view uses |
| `later` | no tint; a yellow left rule, and a `ch N` tag at the top-level block's top right |
| `excluded` | no tint; a grey left rule, and a `not in a chapter` tag |

A file the step adds whole, meaning every line of the block's hunks is this step's `+` line, gets one green rule down the view's left side and no per-block tint or rule. Highlighting every block would say nothing. The hidden labels and Ask buttons stay.

Removal markers are a thin red rule with the label in muted text. Colour is never the only signal: `this` blocks also get a visually hidden "changed in this step" label, and the tags are text.

Rendered content uses the page's Inter body font and JetBrains Mono for code, with headings, tables and lists styled in `.md-view` in `app.css`. It's scoped, so nothing leaks into the rest of the page.

GitHub task list items (`- [ ] …`, `- [x] …`) render with a disabled checkbox in place of the bullet.

### 3.4 Safety

- `html: false`: raw HTML in the file is escaped and shown as text.
- markdown-it's default `validateLink` blocks `javascript:`, `vbscript:`, `file:` and most `data:` URLs.
- **Images aren't loaded.** The image rule is overridden to render `[image: <alt>]` as text, so a PR's README can't make the local page fetch a tracking pixel. Relative paths wouldn't resolve anyway.
- **Links:** absolute `http(s)` links get `target="_blank" rel="noopener noreferrer"`. Relative and anchor links render as plain text in the link style, without `href`, because they'd point into the local server.

## 4. Notes on the rendered view

- Model threads, review drafts and PR threads with a `new`-side anchor render under the **top-level** block that holds their `end` line: the whole list or table, because the block's HTML is a string. They use the same components as code view (`ThreadView`, `DraftView`, `PrThreadView`), stacked in the same order (spec PR-comments §2.2).
- `old`-side anchors render under the removal marker whose old range covers their `end`. A replaced line has no marker, so its note goes under the top-level block holding the next new-side line in the hunk (or the previous one).
- A bar never hides a note: a hidden block holding one shows anyway. A marker outside the step's windows folds into the bar around it, like a block; one holding a note shows anyway.
- **No new selection model.** Asks and comments are still started from line numbers in code view. Each top-level block holding this step's added lines has an **Ask / comment on these lines** button (**Ask about these lines** outside PR mode). It's shown on hover and focus, with a visible focus ring. It switches the block to Code and opens the compose box on the block's lines that this step added, from the first to the last, within the first hunk that has any. A PR thread's **Ask about it…** hands off the same way, with the thread as the box's subject. `SplitDiff` gets an optional `initialSelection: { side; from; to; about? }` that sets `sel`, `composing` and `prAsk` on mount.

## 5. States

- **Loading:** "Loading rendered view…" with `role="status"`. The Code button works at once.
- **Failed** (fetch error, 404, 422): the block shows the code diff, with a muted note above it: `Couldn't render this file: <reason>.` The Rendered button stays and retries the fetch, clearing that path's cached rejection first.
- **A path in no step's hunk** (a contentless block, such as a pure rename): no toggle, as now.

## 6. Tests

- **`markdownBlocks`:**
  - innermost token per changed line: a list item, a table row, a nested list;
  - a fence opened above the hunk renders as a fence;
  - the role ranking when one token holds lines from several chapters;
  - blank added lines: no role outside code, so an inserted paragraph marks only itself;
  - visible blocks from windows, with bars for the gaps;
  - removal markers: position, count, at the end of the file, a deletions-only step;
  - safety: raw `<script>` is escaped, a `javascript:` link has no `href`, images become text, a relative link has no `href`.
- **`/api/file`:**
  - a served markdown path at `headSha` after HEAD has moved;
  - a 404 for a non-markdown path, a deleted file and a path not in the tour;
  - a 422 over the cap and for a binary file;
  - HEAD served as GET.
- **Components:**
  - the toggle's default, and `aria-pressed`;
  - bars expand and move focus;
  - note placement, new side and old side;
  - Ask / comment switches to Code with the compose box open on the right lines;
  - the loading status, the fallback note, and Rendered retrying;
  - non-markdown blocks unchanged.
- **Live QA** (playwright-core, as in earlier QA): a demo branch that edits a README across two chapters, adding a list item, changing a table row, deleting a paragraph and editing inside a fence. Screenshots of both views, the toggle, a PR thread on a README line, and the Ask hand-off.

## 7. Not changing

- The chapters file and its schema, the pipeline and the prompts.
- The code view's behaviour. Its only addition is `initialSelection`.
- The file order view, the excluded panel and the QA pages.
