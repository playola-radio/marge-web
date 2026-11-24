import MarkdownIt from "markdown-it";
import type { StateCore, Token } from "markdown-it";
import {
  segmentHunk,
  type LineRole,
  type Role,
  type RoleOf,
  type StepBlock,
} from "./diffModel";

/**
 * The rendered-markdown view model (markdown reference §3): parse the whole
 * file, attach each changed line to its innermost block token, mark tokens
 * with their strongest role, fold blocks outside the step's windows into bars,
 * and place "− N lines removed" markers for pure deletions. Pure, no DOM.
 */

const RANK: Record<Role, number> = {
  this: 4,
  later: 3,
  earlier: 2,
  excluded: 1,
};

export function strongest(roles: Iterable<Role>): Role | null {
  let best: Role | null = null;
  for (const r of roles) if (!best || RANK[r] > RANK[best]) best = r;
  return best;
}

function safeLinks(state: StateCore) {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const stack: boolean[] = [];
    for (const t of block.children) {
      if (t.type === "link_open") {
        const href = String(t.attrGet("href") ?? "");
        if (/^https?:\/\//i.test(href)) {
          t.attrSet("target", "_blank");
          t.attrSet("rel", "noopener noreferrer");
          stack.push(false);
        } else {
          // Relative and anchor links would point into this site: text only.
          t.tag = "span";
          t.attrs = [["class", "md-link"]];
          stack.push(true);
        }
      } else if (t.type === "link_close" && stack.pop()) {
        t.tag = "span";
      }
    }
  }
}

function taskLists(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i += 1) {
    const inline = tokens[i];
    if (
      inline.type !== "inline" ||
      tokens[i - 1].type !== "paragraph_open" ||
      tokens[i - 2].type !== "list_item_open"
    ) {
      continue;
    }
    const match = /^\[([ xX])\] /.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || !first || first.type !== "text") continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content =
      match[1] === " "
        ? '<input type="checkbox" disabled> '
        : '<input type="checkbox" disabled checked> ';
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin("class", "md-task");
  }
}

function createParser() {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  });
  md.renderer.rules.image = (tokens, idx) =>
    `[image: ${md.utils.escapeHtml(tokens[idx].content)}]`;
  md.core.ruler.push("md_safe_links", safeLinks);
  md.core.ruler.push("md_task_lists", taskLists);
  return md;
}

const md = createParser();

/** Block tokens a changed line can attach to (the innermost wins). */
const ATTACHABLE = new Set([
  "paragraph_open",
  "heading_open",
  "fence",
  "code_block",
  "hr",
  "tr_open",
  "list_item_open",
  "blockquote_open",
]);
const CODE = new Set(["fence", "code_block"]);

export type MdBlock = {
  kind: "block";
  key: string;
  html: string;
  /** This step changed something in the block (for the hidden label). */
  changedHere: boolean;
  laterChapters: number[];
  excluded: boolean;
  visible: boolean;
};

export type MdMarker = {
  kind: "marker";
  key: string;
  count: number;
  role: Role | null;
  laterChapter?: number;
  visible: boolean;
};

export type MdItem = MdBlock | MdMarker;

export type MdBar = {
  kind: "bar";
  key: string;
  blocks: number;
  items: MdItem[];
};

export type MdEntry = MdItem | MdBar;

export type MarkdownView = { entries: MdEntry[]; wholeFileAdded: boolean };

type TopBlock = { start: number; end: number; from: number; to: number };

function topLevelBlocks(tokens: Token[]): TopBlock[] {
  const blocks: TopBlock[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.level !== 0 || t.nesting === -1 || !t.map) continue;
    let end = i;
    if (t.nesting === 1) {
      while (
        end < tokens.length &&
        !(tokens[end].level === 0 && tokens[end].nesting === -1)
      ) {
        end += 1;
      }
    }
    blocks.push({ start: i, end, from: t.map[0], to: t.map[1] });
    i = end;
  }
  return blocks;
}

export function markdownView(
  text: string,
  block: StepBlock,
  roleOf: RoleOf,
): MarkdownView {
  const tokens = md.parse(text, {});
  const tops = topLevelBlocks(tokens);

  const attachable = tokens.filter(
    (t) => ATTACHABLE.has(t.type) && t.map && !t.hidden,
  );
  const innermost = (line: number) => {
    let best: Token | null = null;
    for (const t of attachable) {
      const [from, to] = t.map!;
      if (line < from || line >= to) continue;
      if (!best || t.level >= best.level) best = t;
    }
    return best;
  };
  const inCode = (line: number) => {
    const inner = innermost(line);
    return !!inner && CODE.has(inner.type);
  };
  const topIndexAt = (line: number) => {
    const holding = tops.findIndex((b) => line >= b.from && line < b.to);
    if (holding !== -1) return holding;
    const next = tops.findIndex((b) => b.from > line);
    return next !== -1 ? next : tops.length - 1;
  };

  // Roles of new-side changed lines (0-based line → role).
  const lineRoles = new Map<number, LineRole>();
  const focus = new Set(block.runIds);
  const visibleNew = new Set<number>();
  const visibleOld = new Set<number>();
  let wholeFileAdded = block.hunks.length > 0;
  // Roles come from every hunk of the file: a rendered table or fence can
  // hold another chapter's change that sits in a hunk this step doesn't touch.
  for (const hunk of block.file?.hunks ?? block.hunks) {
    for (const line of hunk.lines) {
      const role = roleOf(line.runId);
      if (line.kind !== "+" || role?.role !== "this") wholeFileAdded = false;
      if (line.kind !== "+" || line.newNo === undefined || !role) continue;
      const at = line.newNo - 1;
      if (line.text.trim() === "" && !inCode(at)) continue;
      lineRoles.set(at, role);
    }
  }
  for (const hunk of block.hunks) {
    for (const seg of segmentHunk(hunk, focus)) {
      if (seg.kind !== "lines") continue;
      for (const line of hunk.lines.slice(seg.start, seg.end)) {
        if (line.newNo !== undefined) visibleNew.add(line.newNo - 1);
        if (line.kind === "-" && line.oldNo !== undefined)
          visibleOld.add(line.oldNo);
      }
    }
  }

  // Mark each line's innermost token with its strongest role.
  if (!wholeFileAdded) {
    const tokenRoles = new Map<Token, Role[]>();
    for (const [line, role] of lineRoles) {
      const inner = innermost(line);
      if (!inner) continue;
      tokenRoles.set(inner, [...(tokenRoles.get(inner) ?? []), role.role]);
    }
    for (const [token, roles] of tokenRoles) {
      token.attrJoin("class", `md-${strongest(roles)}`);
    }
  }

  // Removal markers for pure deletions.
  const before = new Map<number, MdMarker[]>();
  const after = new Map<number, MdMarker[]>();
  const atEnd: MdMarker[] = [];
  for (const [h, hunk] of block.hunks.entries()) {
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; ) {
      if (lines[i].kind !== "-") {
        i += 1;
        continue;
      }
      let j = i;
      while (j < lines.length && lines[j].kind === "-") j += 1;
      const pure = lines[i - 1]?.kind !== "+" && lines[j]?.kind !== "+";
      if (pure) {
        const removed = lines.slice(i, j);
        const roles = removed
          .map((l) => roleOf(l.runId))
          .filter((r) => r !== null);
        const role = strongest(roles.map((r) => r.role));
        const marker: MdMarker = {
          kind: "marker",
          key: `m${h}-${i}`,
          count: removed.length,
          role,
          laterChapter: roles.find((r) => r.role === "later")?.chapter,
          visible: removed.some(
            (l) => l.oldNo !== undefined && visibleOld.has(l.oldNo),
          ),
        };
        const next = lines.slice(j).find((l) => l.newNo !== undefined);
        const prev = lines
          .slice(0, i)
          .reverse()
          .find((l) => l.newNo !== undefined);
        if (next && tops.length) {
          const b = topIndexAt(next.newNo! - 1);
          before.set(b, [...(before.get(b) ?? []), marker]);
        } else if (prev && tops.length) {
          const b = topIndexAt(prev.newNo! - 1);
          after.set(b, [...(after.get(b) ?? []), marker]);
        } else {
          atEnd.push(marker);
        }
      }
      i = j;
    }
  }

  const items: MdItem[] = [];
  tops.forEach((top, b) => {
    items.push(...(before.get(b) ?? []));
    const roles: LineRole[] = [];
    for (const [line, role] of lineRoles) {
      if (line >= top.from && line < top.to) roles.push(role);
    }
    let visible = false;
    for (let line = top.from; line < top.to && !visible; line += 1) {
      visible = visibleNew.has(line);
    }
    items.push({
      kind: "block",
      key: `b${top.from}`,
      html: md.renderer.render(
        tokens.slice(top.start, top.end + 1),
        md.options,
        {},
      ),
      changedHere: roles.some((r) => r.role === "this"),
      laterChapters: [
        ...new Set(
          roles.filter((r) => r.role === "later").map((r) => r.chapter!),
        ),
      ].sort((x, y) => x - y),
      excluded: !wholeFileAdded && roles.some((r) => r.role === "excluded"),
      visible,
    });
    items.push(...(after.get(b) ?? []));
  });
  items.push(...atEnd);

  // Fold each maximal run of hidden items into a bar.
  const entries: MdEntry[] = [];
  for (const item of items) {
    if (item.visible) {
      entries.push(item);
      continue;
    }
    const last = entries[entries.length - 1];
    if (last?.kind === "bar") {
      last.items.push(item);
      if (item.kind === "block") last.blocks += 1;
    } else {
      entries.push({
        kind: "bar",
        key: `bar-${item.key}`,
        blocks: item.kind === "block" ? 1 : 0,
        items: [item],
      });
    }
  }
  return { entries, wholeFileAdded };
}
