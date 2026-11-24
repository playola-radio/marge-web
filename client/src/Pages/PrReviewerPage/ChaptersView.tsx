import { useMemo, useState } from "react";
import type {
  Chapter,
  ChaptersDocument,
} from "../../Services/PrReviewerService";
import {
  indexDocument,
  roleOfForRun,
  roleOfForStep,
  runStats,
  shortSha,
  type DocIndex,
  type RoleOf,
} from "./diffModel";
import SplitDiff from "./SplitDiff";
import StepView from "./StepView";

/**
 * The ready page body (reference capture): the chapter rail with progress
 * and the "not in a chapter" bucket, the summary, and the chapters in
 * narrated order — or the plain file order view.
 */
export default function ChaptersView({
  document: doc,
  runId,
  reviewed,
  onToggleReviewed,
}: {
  document: ChaptersDocument;
  runId: string;
  reviewed: Set<string>;
  onToggleReviewed: (key: string, reviewed: boolean) => void;
}) {
  const index = useMemo(() => indexDocument(doc), [doc]);
  const [order, setOrder] = useState<"chapter" | "file">("chapter");
  const firstUnreviewed = () =>
    doc.chapters.find((c) => !reviewed.has(c.key))?.key ?? null;
  const [current, setCurrent] = useState<string | null>(firstUnreviewed);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(current ? [current] : []),
  );
  const [openExcluded, setOpenExcluded] = useState<string | null>(null);

  const setOpen = (key: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  const goTo = (key: string) => {
    setOrder("chapter");
    setCurrent(key);
    setOpen(key, true);
    requestAnimationFrame(() =>
      window.document
        .getElementById(`chapter-${key}`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" }),
    );
  };

  const toggleReviewed = (chapter: Chapter) => {
    const marking = !reviewed.has(chapter.key);
    onToggleReviewed(chapter.key, marking);
    if (!marking) return;
    // Marking reviewed collapses the chapter and opens the next unreviewed one.
    const at = doc.chapters.indexOf(chapter);
    const after = [...doc.chapters.slice(at + 1), ...doc.chapters.slice(0, at)];
    const next = after.find((c) => !reviewed.has(c.key));
    setExpanded((prev) => {
      const s = new Set(prev);
      s.delete(chapter.key);
      if (next) s.add(next.key);
      return s;
    });
    setCurrent(next?.key ?? null);
  };

  const reviewedCount = doc.chapters.filter((c) => reviewed.has(c.key)).length;

  return (
    <div className="prr-layout">
      <aside className="rail" aria-label="Chapters">
        <h2 className="rail__heading">Chapters</h2>
        <p className="rail__progress-label">
          {reviewedCount} of {doc.chapters.length} reviewed
        </p>
        <div
          className="rail__progress"
          role="progressbar"
          aria-label="Chapters reviewed"
          aria-valuemin={0}
          aria-valuemax={doc.chapters.length}
          aria-valuenow={reviewedCount}
        >
          <div
            className="rail__progress-fill"
            style={{
              width: `${doc.chapters.length ? (100 * reviewedCount) / doc.chapters.length : 0}%`,
            }}
          />
        </div>
        <ol className="rail__list">
          {doc.chapters.map((chapter) => {
            const stats = runStats(index, chapter.runIds);
            const done = reviewed.has(chapter.key);
            return (
              <li key={chapter.key}>
                <button
                  type="button"
                  className={`rail__item${current === chapter.key ? " rail__item--current" : ""}${done ? " rail__item--reviewed" : ""}`}
                  aria-current={current === chapter.key ? "true" : undefined}
                  onClick={() => goTo(chapter.key)}
                >
                  <span className="num-badge" aria-hidden="true">
                    {done ? "✓" : chapter.number}
                  </span>
                  <span className="rail__text">
                    <span className="rail__headline">{chapter.headline}</span>
                    <span className="rail__stats">
                      {stats.files.length}{" "}
                      {stats.files.length === 1 ? "file" : "files"} · +
                      {stats.added} −{stats.removed}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <ExcludedList
          doc={doc}
          index={index}
          open={openExcluded}
          onOpen={setOpenExcluded}
        />
      </aside>

      <div className="prr-main">
        {openExcluded ? (
          <ExcludedDiff
            runId={openExcluded}
            doc={doc}
            index={index}
            onClose={() => setOpenExcluded(null)}
          />
        ) : null}
        <section className="summary" aria-labelledby="summary-heading">
          <div className="summary__top">
            <h2 id="summary-heading" className="summary__heading">
              What this PR does
            </h2>
            <span className="order-toggle" role="group" aria-label="Order">
              <button
                type="button"
                aria-pressed={order === "chapter"}
                onClick={() => setOrder("chapter")}
              >
                Chapter order
              </button>
              <button
                type="button"
                aria-pressed={order === "file"}
                onClick={() => setOrder("file")}
              >
                File order
              </button>
            </span>
          </div>
          <p className="summary__text">{doc.summary}</p>
          <p className="summary__provenance">
            Written from {doc.commits.length}{" "}
            {doc.commits.length === 1 ? "commit" : "commits"} and the diff
          </p>
          {doc.fallbacks.length ? (
            <p className="summary__fallbacks">
              Generated with fallback for: {doc.fallbacks.join(", ")}
            </p>
          ) : null}
        </section>

        {order === "chapter" ? (
          <ol className="chapters">
            {doc.chapters.map((chapter, chapterIdx) => (
              <ChapterCard
                key={chapter.key}
                chapter={chapter}
                chapterIdx={chapterIdx}
                index={index}
                runId={runId}
                expanded={expanded.has(chapter.key)}
                current={current === chapter.key}
                reviewed={reviewed.has(chapter.key)}
                onExpand={(open) => {
                  setOpen(chapter.key, open);
                  if (open) setCurrent(chapter.key);
                }}
                onToggleReviewed={() => toggleReviewed(chapter)}
              />
            ))}
          </ol>
        ) : (
          <FileOrderView doc={doc} index={index} />
        )}
      </div>
    </div>
  );
}

function ChapterCard({
  chapter,
  chapterIdx,
  index,
  runId,
  expanded,
  current,
  reviewed,
  onExpand,
  onToggleReviewed,
}: {
  chapter: Chapter;
  chapterIdx: number;
  index: DocIndex;
  runId: string;
  expanded: boolean;
  current: boolean;
  reviewed: boolean;
  onExpand: (open: boolean) => void;
  onToggleReviewed: () => void;
}) {
  const stats = runStats(index, chapter.runIds);
  const roleOfs = useMemo(
    () =>
      chapter.steps.map((_, stepIdx) =>
        roleOfForStep(index, chapterIdx, stepIdx),
      ),
    [chapter.steps, chapterIdx, index],
  );
  const headingId = `chapter-${chapter.key}-heading`;
  return (
    <li
      id={`chapter-${chapter.key}`}
      className={`chapter${expanded ? " chapter--expanded" : ""}${current ? " chapter--current" : ""}${reviewed ? " chapter--reviewed" : ""}`}
      aria-labelledby={headingId}
    >
      <div className="chapter__head">
        <span className="num-badge" aria-hidden="true">
          {chapter.number}
        </span>
        <div className="chapter__titles">
          <h3 id={headingId} className="chapter__headline">
            <button
              type="button"
              className="chapter__toggle"
              aria-expanded={expanded}
              onClick={() => onExpand(!expanded)}
            >
              {chapter.headline}
              <span className="chapter__caret" aria-hidden="true">
                {expanded ? "▾" : "▸"}
              </span>
            </button>
          </h3>
          <p className="chapter__meta">
            {stats.files.join(" · ")} · +{stats.added} −{stats.removed} ·{" "}
            {stats.commits.length === 1 ? "commit" : "commits"}{" "}
            {stats.commits.map(shortSha).join(", ")}
          </p>
        </div>
        <button
          type="button"
          className={`reviewed-toggle${reviewed ? " reviewed-toggle--on" : ""}`}
          aria-pressed={reviewed}
          aria-label={`Reviewed: ${chapter.headline}`}
          onClick={onToggleReviewed}
        >
          <span aria-hidden="true">{reviewed ? "✓" : "○"}</span> Reviewed
        </button>
      </div>
      {chapter.intro ? <p className="chapter__intro">{chapter.intro}</p> : null}
      {expanded ? (
        <ol className="steps">
          {chapter.steps.map((step, stepIdx) => (
            <StepView
              key={stepIdx}
              step={step}
              index={index}
              roleOf={roleOfs[stepIdx]}
              runId={runId}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

/** "(lines 8–14)": where an excluded run sits, to tell same-file runs apart. */
function linesOf(index: DocIndex, runId: string): string {
  const run = index.runsById.get(runId);
  const range = run?.newRange ?? run?.oldRange;
  if (!range) return "";
  const [from, to] = range;
  return from === to ? `(line ${from})` : `(lines ${from}–${to})`;
}

function ExcludedList({
  doc,
  index,
  open,
  onOpen,
}: {
  doc: ChaptersDocument;
  index: DocIndex;
  open: string | null;
  onOpen: (runId: string | null) => void;
}) {
  const byPath = new Map<string, { runId: string; reason: string }[]>();
  for (const ex of doc.excluded) {
    const path = index.runsById.get(ex.runId)?.path ?? "(unknown file)";
    byPath.set(path, [...(byPath.get(path) ?? []), ex]);
  }
  return (
    <section className="excluded" aria-labelledby="excluded-heading">
      <h2 id="excluded-heading" className="excluded__heading">
        Not in a chapter
      </h2>
      {doc.excluded.length === 0 ? (
        <p className="excluded__none">Every change is in a chapter.</p>
      ) : (
        <ul className="excluded__list">
          {[...byPath].map(([path, items]) => (
            <li key={path}>
              <span className="excluded__path">{path}</span>
              <ul>
                {items.map((ex) => (
                  <li key={ex.runId}>
                    <button
                      type="button"
                      className="excluded__reason"
                      aria-expanded={open === ex.runId}
                      onClick={() =>
                        onOpen(open === ex.runId ? null : ex.runId)
                      }
                    >
                      {ex.reason}
                      {items.length > 1 ? (
                        <span className="excluded__lines">
                          {" "}
                          {linesOf(index, ex.runId)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExcludedDiff({
  runId,
  doc,
  index,
  onClose,
}: {
  runId: string;
  doc: ChaptersDocument;
  index: DocIndex;
  onClose: () => void;
}) {
  const run = index.runsById.get(runId);
  const reason = doc.excluded.find((e) => e.runId === runId)?.reason;
  const file = run ? index.filesByPath.get(run.path) : undefined;
  const hunks = (file?.hunks ?? []).filter((h) =>
    h.lines.some((l) => l.runId === runId),
  );
  const roleOf = roleOfForRun(runId);
  return (
    <section
      className="block excluded-diff"
      aria-label="Change not in a chapter"
    >
      <div className="block-head">
        <span className="block-head__path">{run?.path}</span>
        <span className="excluded-diff__reason">
          Not in a chapter: {reason}
        </span>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </div>
      {hunks.map((hunk, i) => (
        <SplitDiff
          key={i}
          hunk={hunk}
          roleOf={roleOf}
          focus={new Set([runId])}
        />
      ))}
    </section>
  );
}

/** The final diff grouped by file in path order; every changed line badged with its chapter. */
function FileOrderView({
  doc,
  index,
}: {
  doc: ChaptersDocument;
  index: DocIndex;
}) {
  const files = [...doc.files].sort((a, b) => a.path.localeCompare(b.path));
  const badgeOf = (runId: string | undefined) => {
    const p = runId ? index.placements.get(runId) : undefined;
    return p?.kind === "chapter" ? String(p.number) : "—";
  };
  const roleOf: RoleOf = (runId) => {
    const p = runId ? index.placements.get(runId) : undefined;
    if (!p) return null;
    return p.kind === "excluded"
      ? { role: "excluded" }
      : { role: "this", chapter: p.number };
  };
  return (
    <ol className="file-order" aria-label="Files">
      {files.map((file) => (
        <li key={file.path} className="block">
          <div className="block-head">
            <span className="block-head__path">{file.path}</span>
            <span className="block-head__status">{file.status}</span>
          </div>
          {file.hunks.length === 0 ? (
            <p className="block__empty">
              {file.binary ? "Binary file." : "No line changes."}
            </p>
          ) : (
            file.hunks.map((hunk, i) => (
              <SplitDiff
                key={i}
                hunk={hunk}
                roleOf={roleOf}
                badgeOf={badgeOf}
              />
            ))
          )}
        </li>
      ))}
    </ol>
  );
}
