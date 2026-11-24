import { Link, useParams } from "react-router-dom";
import { readSession } from "../../utils/session";
import SignOutButton from "../../Components/SignOutButton/SignOutButton";
import { ArrowLeftIcon } from "../../Components/Icons/Icons";
import type { Run, RunPr, RunStage } from "../../Services/PrReviewerService";
import { isCurrent, usePrReviewer, viewLatestCandidate } from "./usePrReviewer";
import { shortSha } from "./diffModel";
import MarkdownFilesProvider from "./MarkdownFilesProvider";
import ChaptersView from "./ChaptersView";
import "./prReviewer.css";

export default function PrReviewerPage() {
  const { org = "", repo = "", prNumber = "" } = useParams();
  const email = readSession()?.email;
  return (
    <div className="prr">
      <header className="factory__header prr__chrome">
        <div className="factory__crumbs">
          <Link to="/home" className="back-link">
            <ArrowLeftIcon size={20} />
            <span className="wordmark back-link__wordmark">marge</span>
          </Link>
          <span className="factory__separator desktop-only" aria-hidden="true">
            /
          </span>
          <span className="factory__crumb desktop-only">PR reviewer</span>
          <span className="prr__crumb-repo desktop-only">
            {org}/{repo} #{prNumber}
          </span>
        </div>
        <div className="factory__account">
          <span className="signed-in-email desktop-only">{email}</span>
          <SignOutButton />
        </div>
      </header>
      <MarkdownFilesProvider>
        <Body org={org} repo={repo} prNumber={prNumber} />
      </MarkdownFilesProvider>
    </div>
  );
}

function Body({
  org,
  repo,
  prNumber,
}: {
  org: string;
  repo: string;
  prNumber: string;
}) {
  const r = usePrReviewer(org, repo, prNumber);
  const { state, pr } = r;

  const note = r.note ? (
    <div className="prr-note" role="status">
      <span>{r.note}</span>
      <button
        type="button"
        className="prr-note__dismiss"
        aria-label="Dismiss"
        onClick={r.dismissNote}
      >
        ×
      </button>
    </div>
  ) : null;

  if (state.kind === "loading") {
    return (
      <main className="prr__body">
        <p role="status" className="prr-status">
          Loading…
        </p>
      </main>
    );
  }

  if (state.kind === "error") {
    return (
      <main className="prr__body">
        <MessageCard
          title={
            state.unavailable
              ? "The PR reviewer isn't available on this server."
              : "The request failed."
          }
        >
          {!state.unavailable && state.detail ? (
            <details className="prr-detail">
              <summary>Error detail</summary>
              <pre>{state.detail}</pre>
            </details>
          ) : null}
          <button type="button" className="prr-button" onClick={r.tryAgain}>
            Try again
          </button>
        </MessageCard>
      </main>
    );
  }

  if (state.kind === "notFound") {
    return (
      <main className="prr__body">
        <MessageCard title="Couldn't find that pull request.">
          <p>
            {org}/{repo} #{prNumber} isn't an open pull request marge can read.
            Check the URL — take the GitHub PR address, replace
            <code> github.com </code> with
            <code> marge.playola.fm/pr-reviewer </code> and
            <code> /pull/ </code> with <code>/pulls/</code>.
          </p>
        </MessageCard>
      </main>
    );
  }

  if (state.kind === "emptyDiff") {
    return (
      <main className="prr__body">
        {pr ? <PrHeader prNumber={prNumber} pr={pr} /> : null}
        <MessageCard title="Nothing to narrate.">
          <p>
            This pull request has no changes between its merge base and its
            head, so no chapters were generated.
          </p>
        </MessageCard>
      </main>
    );
  }

  if (state.kind === "noRun") {
    return (
      <main className="prr__body">
        {pr ? <PrHeader prNumber={prNumber} pr={pr} /> : null}
        {note}
        <MessageCard title="No chapters yet for this pull request.">
          <button
            type="button"
            className="prr-button prr-button--primary"
            disabled={r.busy}
            onClick={() => void r.generate()}
          >
            Generate chapters
          </button>
        </MessageCard>
      </main>
    );
  }

  const { run, loaded } = state;
  const latestRun = viewLatestCandidate(run, r.candidate, pr);
  const superseded = !!pr && !isCurrent(run, pr);
  return (
    <main className="prr__body">
      <PrHeader
        prNumber={prNumber}
        pr={run.pr}
        title={loaded?.document.title}
        url={loaded?.document.pr?.url}
        generatedFor={run.headSha}
      />
      {latestRun ? (
        <div className="prr-banner" role="status">
          <span>{latestMessage(latestRun)}</span>
          <button
            type="button"
            className="prr-button"
            disabled={r.busy}
            onClick={() => void r.viewLatest(latestRun.id)}
          >
            View latest
          </button>
        </div>
      ) : superseded ? (
        <div className="prr-banner" role="status">
          <span>
            These chapters were generated for{" "}
            <code>{shortSha(run.headSha)}</code>; the PR has changed.
          </span>
          <button
            type="button"
            className="prr-button prr-button--primary"
            disabled={r.busy}
            onClick={() => void r.generate()}
          >
            Generate for latest
          </button>
        </div>
      ) : null}
      {note}
      {run.status === "failed" ? (
        <FailedCard run={run} busy={r.busy} onRetry={() => void r.retry()} />
      ) : run.status === "ready" && loaded ? (
        <ChaptersView
          key={run.id}
          document={loaded.document}
          runId={run.id}
          reviewed={loaded.shown}
          onToggleReviewed={(key, value) => void r.toggleReviewed(key, value)}
        />
      ) : run.status === "ready" ? (
        <p role="status" className="prr-status">
          Loading…
        </p>
      ) : (
        <Progress run={run} />
      )}
    </main>
  );
}

function latestMessage(run: Run): string {
  switch (run.status) {
    case "ready":
      return "Chapters for the latest revision are ready.";
    case "failed":
      return "Generating chapters for the latest revision failed.";
    default:
      return "Chapters for the latest revision are generating.";
  }
}

function PrHeader({
  prNumber,
  pr,
  title,
  url,
  generatedFor,
}: {
  prNumber: string;
  pr: RunPr;
  title?: string;
  url?: string;
  generatedFor?: string;
}) {
  return (
    <section className="pr-header" aria-label="Pull request">
      <h1 className="pr-header__title">{title ?? pr.title}</h1>
      <p className="pr-header__meta">
        <code className="chip">{pr.baseRef}</code>
        <span aria-label="from"> ← </span>
        <code className="chip">{pr.headRef}</code>
        <span>
          {" "}
          · {pr.commits} {pr.commits === 1 ? "commit" : "commits"}
        </span>
        {generatedFor ? (
          <span>
            {" "}
            · generated for{" "}
            <code className="chip">{shortSha(generatedFor)}</code>
          </span>
        ) : null}
      </p>
      <a
        className="pr-header__link"
        href={url ?? pr.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        PR #{prNumber}: {pr.title}
      </a>
    </section>
  );
}

function MessageCard({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="prr-card" role="alert">
      <h2 className="prr-card__title">{title}</h2>
      {children}
    </section>
  );
}

function FailedCard({
  run,
  busy,
  onRetry,
}: {
  run: Run;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      className="prr-card prr-card--failed"
      aria-label="Generation failed"
    >
      <h2 className="prr-card__title">{run.failure ?? "Generation failed."}</h2>
      {run.failureDetail ? (
        <details className="prr-detail">
          <summary>Error detail</summary>
          <pre>{run.failureDetail}</pre>
        </details>
      ) : null}
      <p>Retry picks up where it stopped: finished stages aren't redone.</p>
      <button
        type="button"
        className="prr-button prr-button--primary"
        disabled={busy}
        onClick={onRetry}
      >
        Retry
      </button>
    </section>
  );
}

const STAGES: { key: RunStage; label: string }[] = [
  { key: "fetch", label: "Fetching the repo" },
  { key: "extract", label: "Reading the diff" },
  { key: "outline", label: "Outlining" },
  { key: "write", label: "Writing chapters" },
  { key: "summarize", label: "Summarizing" },
];

function Progress({ run }: { run: Run }) {
  const at = run.progress
    ? STAGES.findIndex((s) => s.key === run.progress!.stage)
    : -1;
  return (
    <section className="prr-card progress" aria-label="Generating chapters">
      <h2 className="prr-card__title">
        {run.status === "queued" && at === -1
          ? "Waiting to start generating chapters…"
          : "Generating chapters…"}
      </h2>
      <ol className="progress__stages" aria-live="polite">
        {STAGES.map((stage, i) => {
          const state = i < at ? "done" : i === at ? "current" : "upcoming";
          const label =
            stage.key === "write" &&
            i === at &&
            run.progress?.totalChapters !== undefined
              ? `${stage.label} (${run.progress.completedChapters ?? 0} of ${run.progress.totalChapters})`
              : stage.label;
          return (
            <li
              key={stage.key}
              className={`progress__stage progress__stage--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="progress__dot" aria-hidden="true">
                {state === "done" ? "✓" : ""}
              </span>
              {label}
            </li>
          );
        })}
      </ol>
      <p className="progress__note">
        You can close this page and come back — generation keeps going on the
        server. A first generation usually takes 1–3 minutes.
      </p>
    </section>
  );
}
