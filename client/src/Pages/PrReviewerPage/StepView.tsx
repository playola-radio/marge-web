import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../Services/PrReviewerService";
import {
  isMarkdownBlock,
  runStats,
  stepBlocks,
  type DocIndex,
  type RoleOf,
  type StepBlock,
} from "./diffModel";
import { markdownView, type MdItem } from "./markdownBlocks";
import { useMarkdownFile } from "./markdownFiles";
import SplitDiff from "./SplitDiff";

/** One step: its explanation, then one diff block per file it touches. */
export default function StepView({
  step,
  index,
  roleOf,
  runId,
}: {
  step: Step;
  index: DocIndex;
  roleOf: RoleOf;
  runId: string;
}) {
  const blocks = useMemo(() => stepBlocks(index, step), [index, step]);
  return (
    <li className="step">
      {step.explanation ? (
        <p className="step__explanation">{step.explanation}</p>
      ) : null}
      {blocks.map((block, i) =>
        isMarkdownBlock(block) ? (
          <MarkdownBlockView
            key={`${block.path}-${i}`}
            block={block}
            index={index}
            roleOf={roleOf}
            runId={runId}
          />
        ) : (
          <CodeBlock
            key={`${block.path}-${i}`}
            block={block}
            index={index}
            roleOf={roleOf}
          />
        ),
      )}
    </li>
  );
}

function BlockHead({
  block,
  index,
  children,
}: {
  block: StepBlock;
  index: DocIndex;
  children?: React.ReactNode;
}) {
  const stats = runStats(index, block.runIds);
  return (
    <div className="block-head">
      <span className="block-head__path">{block.path}</span>
      <span className="block-head__counts">
        <span className="count-add">+{stats.added}</span>{" "}
        <span className="count-del">−{stats.removed}</span>
      </span>
      {children}
    </div>
  );
}

function CodeBlock({
  block,
  index,
  roleOf,
}: {
  block: StepBlock;
  index: DocIndex;
  roleOf: RoleOf;
}) {
  return (
    <div className="block">
      <BlockHead block={block} index={index} />
      <CodeDiff block={block} roleOf={roleOf} />
    </div>
  );
}

function CodeDiff({ block, roleOf }: { block: StepBlock; roleOf: RoleOf }) {
  const focus = useMemo(() => new Set(block.runIds), [block.runIds]);
  if (block.hunks.length === 0) {
    return (
      <p className="block__empty">
        {block.file?.binary
          ? "Binary file — no line changes to show."
          : "No line changes to show (a rename or mode change)."}
      </p>
    );
  }
  return (
    <>
      {block.hunks.map((hunk, i) => (
        <SplitDiff key={i} hunk={hunk} roleOf={roleOf} focus={focus} />
      ))}
    </>
  );
}

/** A markdown file block: Rendered (default) or Code, per block. */
function MarkdownBlockView({
  block,
  index,
  roleOf,
  runId,
}: {
  block: StepBlock;
  index: DocIndex;
  roleOf: RoleOf;
  runId: string;
}) {
  const [mode, setMode] = useState<"rendered" | "code">("rendered");
  const [renderAttempt, setRenderAttempt] = useState(0);
  return (
    <div className="block">
      <BlockHead block={block} index={index}>
        <span className="view-toggle" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={mode === "rendered"}
            onClick={() => {
              setMode("rendered");
              setRenderAttempt((n) => n + 1);
            }}
          >
            Rendered
          </button>
          <button
            type="button"
            aria-pressed={mode === "code"}
            onClick={() => setMode("code")}
          >
            Code
          </button>
        </span>
      </BlockHead>
      {mode === "rendered" ? (
        <RenderedMarkdown
          block={block}
          roleOf={roleOf}
          runId={runId}
          attempt={renderAttempt}
        />
      ) : (
        <CodeDiff block={block} roleOf={roleOf} />
      )}
    </div>
  );
}

function RenderedMarkdown({
  block,
  roleOf,
  runId,
  attempt,
}: {
  block: StepBlock;
  roleOf: RoleOf;
  runId: string;
  attempt: number;
}) {
  const { file, reload } = useMarkdownFile(runId, block.path);
  const seen = useRef(attempt);
  useEffect(() => {
    // Pressing Rendered again after a failure retries the fetch.
    if (attempt !== seen.current) {
      seen.current = attempt;
      if (file.kind === "failed") reload();
    }
  }, [attempt, file.kind, reload]);
  const view = useMemo(
    () =>
      file.kind === "loaded" ? markdownView(file.text, block, roleOf) : null,
    [file, block, roleOf],
  );
  if (file.kind === "loading") {
    return (
      <p role="status" className="md-status">
        Loading rendered view…
      </p>
    );
  }
  if (file.kind === "failed" || !view) {
    return (
      <>
        <p className="md-fallback">
          Couldn't render this file:{" "}
          {file.kind === "failed" ? file.reason : "unknown error"}.
        </p>
        <CodeDiff block={block} roleOf={roleOf} />
      </>
    );
  }
  return (
    <div className={`md-view${view.wholeFileAdded ? " md-view--added" : ""}`}>
      {view.entries.map((entry) =>
        entry.kind === "bar" ? (
          <MdBar key={entry.key} items={entry.items} blocks={entry.blocks} />
        ) : (
          <MdItemView key={entry.key} item={entry} />
        ),
      )}
    </div>
  );
}

function MdBar({ items, blocks }: { items: MdItem[]; blocks: number }) {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  if (open) {
    return (
      <div ref={first} tabIndex={-1} className="md-revealed">
        {items.map((item) => (
          <MdItemView key={item.key} item={item} />
        ))}
      </div>
    );
  }
  const removals = items.filter((i) => i.kind === "marker").length;
  const label =
    blocks > 0
      ? `${blocks} ${blocks === 1 ? "block" : "blocks"}`
      : `${removals} ${removals === 1 ? "removal" : "removals"}`;
  return (
    <button
      type="button"
      className="diff__bar md-bar"
      aria-expanded="false"
      onClick={() => setOpen(true)}
    >
      ▸ {label}
    </button>
  );
}

function MdItemView({ item }: { item: MdItem }) {
  if (item.kind === "marker") {
    return (
      <div
        className={`md-marker${item.role ? ` md-marker--${item.role}` : ""}`}
      >
        − {item.count} {item.count === 1 ? "line" : "lines"} removed
        {item.role === "later" && item.laterChapter !== undefined ? (
          <span className="diff__tag">ch {item.laterChapter}</span>
        ) : item.role === "excluded" ? (
          <span className="diff__tag">not in a chapter</span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="md-block">
      {item.laterChapters.length || item.excluded ? (
        <div className="md-block__tags">
          {item.laterChapters.map((n) => (
            <span key={n} className="diff__tag">
              ch {n}
            </span>
          ))}
          {item.excluded ? (
            <span className="diff__tag">not in a chapter</span>
          ) : null}
        </div>
      ) : null}
      {item.changedHere ? (
        <span className="visually-hidden">changed in this step</span>
      ) : null}
      <div dangerouslySetInnerHTML={{ __html: item.html }} />
    </div>
  );
}
