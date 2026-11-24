import { useEffect, useRef, useState } from "react";
import type { DiffHunk, DiffLine } from "../../Services/PrReviewerService";
import {
  barLabel,
  segmentHunk,
  splitRows,
  type RoleOf,
  type Segment,
} from "./diffModel";

/**
 * One hunk as a side-by-side diff: base on the left, head on the right.
 * With `focus`, only the focus runs' ±3-line windows show; the rest sits
 * behind expandable bars. With `badgeOf` (file order view), every changed
 * line carries its chapter-number badge.
 */
export default function SplitDiff({
  hunk,
  roleOf,
  focus,
  badgeOf,
}: {
  hunk: DiffHunk;
  roleOf: RoleOf;
  focus?: Set<string>;
  badgeOf?: (runId: string | undefined) => string;
}) {
  const segments: Segment[] = focus
    ? segmentHunk(hunk, focus)
    : [{ kind: "lines", start: 0, end: hunk.lines.length }];
  return (
    <div className="diff" role="group" aria-label={`Changes ${hunk.header}`}>
      <div className="diff__hunk-header">
        <span>{hunk.header}</span>
      </div>
      {segments.map((seg) =>
        seg.kind === "lines" ? (
          <Rows
            key={seg.start}
            lines={hunk.lines.slice(seg.start, seg.end)}
            roleOf={roleOf}
            badgeOf={badgeOf}
          />
        ) : (
          <Bar
            key={seg.start}
            lines={hunk.lines.slice(seg.start, seg.end)}
            roleOf={roleOf}
            badgeOf={badgeOf}
          />
        ),
      )}
    </div>
  );
}

function Bar({
  lines,
  roleOf,
  badgeOf,
}: {
  lines: DiffLine[];
  roleOf: RoleOf;
  badgeOf?: (runId: string | undefined) => string;
}) {
  const [open, setOpen] = useState(false);
  const firstRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) firstRow.current?.focus();
  }, [open]);
  if (open) {
    return (
      <Rows
        lines={lines}
        roleOf={roleOf}
        badgeOf={badgeOf}
        firstRef={firstRow}
      />
    );
  }
  return (
    <div className="diff__bar-row">
      <button
        type="button"
        className="diff__bar"
        aria-expanded="false"
        onClick={() => setOpen(true)}
      >
        ▸ {barLabel(lines, roleOf)}
      </button>
    </div>
  );
}

function Rows({
  lines,
  roleOf,
  badgeOf,
  firstRef,
}: {
  lines: DiffLine[];
  roleOf: RoleOf;
  badgeOf?: (runId: string | undefined) => string;
  firstRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <>
      {splitRows(lines).map((row, i) => (
        <div
          key={i}
          className="diff__row"
          ref={i === 0 ? firstRef : undefined}
          tabIndex={i === 0 && firstRef ? -1 : undefined}
        >
          <Cell line={row.left} side="old" roleOf={roleOf} badgeOf={badgeOf} />
          <Cell line={row.right} side="new" roleOf={roleOf} badgeOf={badgeOf} />
        </div>
      ))}
    </>
  );
}

function Cell({
  line,
  side,
  roleOf,
  badgeOf,
}: {
  line: DiffLine | null;
  side: "old" | "new";
  roleOf: RoleOf;
  badgeOf?: (runId: string | undefined) => string;
}) {
  if (!line) {
    return <div className="diff__cell diff__cell--empty" />;
  }
  const changed = line.kind !== " ";
  const r = changed ? roleOf(line.runId) : null;
  const role = changed ? (r?.role ?? "earlier") : null;
  const kind = line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx";
  const no = side === "old" ? line.oldNo : line.newNo;
  return (
    <div
      className={`diff__cell diff__cell--${kind}${role ? ` diff__cell--${role}` : ""}`}
      data-role={role ?? undefined}
    >
      <span className="diff__no">{no}</span>
      <span className="diff__marker" aria-hidden={!changed}>
        {line.kind === "+" ? "+" : line.kind === "-" ? "−" : " "}
      </span>
      <span className="diff__text">{line.text}</span>
      {changed && badgeOf ? (
        <span className="diff__badge">{badgeOf(line.runId)}</span>
      ) : role === "later" && r?.chapter !== undefined ? (
        <span className="diff__tag">ch {r.chapter}</span>
      ) : role === "excluded" ? (
        <span className="diff__tag">not in a chapter</span>
      ) : null}
    </div>
  );
}
