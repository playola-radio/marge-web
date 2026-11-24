import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import {
  createRun,
  fetchChapters,
  fetchLatestRun,
  fetchRun,
  retryRun,
  setChapterReviewed,
  type ChaptersDocument,
  type CurrentPr,
  type Run,
} from "../../Services/PrReviewerService";
import { clearSession } from "../../utils/session";

export const POLL_MS = 3_000;

export type Loaded = {
  document: ChaptersDocument;
  /** Marks the server has confirmed. */
  confirmed: Set<string>;
  /** Marks on screen: confirmed plus optimistic flips still in flight. */
  shown: Set<string>;
};

export type PageState =
  | { kind: "loading" }
  /** The page itself failed to read (not a failed run). */
  | { kind: "error"; unavailable: boolean; detail: string | null }
  | { kind: "notFound" }
  | { kind: "emptyDiff" }
  /** A recovered lookup found no run: generation waits for the button. */
  | { kind: "noRun" }
  | { kind: "run"; run: Run; loaded: Loaded | null };

function status(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  const data = error.response?.data as { error?: unknown } | undefined;
  return typeof data?.error === "string" ? data.error : undefined;
}

function detailOf(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const code = errorCode(error);
    return code ? `${error.message} (${code})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function isCurrent(run: Run, pr: CurrentPr | null): boolean {
  return (
    !!pr &&
    run.headSha === pr.currentHeadSha &&
    run.baseSha === pr.currentBaseSha
  );
}

/**
 * The newer run a reader may switch to: the lookup's latest candidate
 * (`newerRun ?? run`) when it is a different, more recently created run for
 * the PR's current revision. Never offers a step backward.
 */
export function viewLatestCandidate(
  displayed: Run,
  candidate: Run | null,
  pr: CurrentPr | null,
): Run | null {
  if (!candidate || candidate.id === displayed.id) return null;
  if (Date.parse(candidate.createdAt) <= Date.parse(displayed.createdAt)) {
    return null;
  }
  return isCurrent(candidate, pr) ? candidate : null;
}

export function usePrReviewer(org: string, repo: string, prNumber: string) {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [pr, setPr] = useState<CurrentPr | null>(null);
  const [candidate, setCandidate] = useState<Run | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const stateRef = useRef(state);
  stateRef.current = state;
  /** Bumped on every switch of displayed run; stale async results are dropped. */
  const seq = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const mounted = useRef(true);

  const signedOut = useCallback(
    (error: unknown) => {
      if (status(error) !== 401) return false;
      clearSession();
      const redirectTo = encodeURIComponent(
        location.pathname + location.search,
      );
      navigate(`/?redirectTo=${redirectTo}`, { replace: true });
      return true;
    },
    [location.pathname, location.search, navigate],
  );

  const stopPolling = () => {
    clearTimeout(pollTimer.current);
    pollTimer.current = undefined;
  };

  // The run-following steps call each other; refs keep them stable.
  const displayRef = useRef<(run: Run) => void>(() => {});

  const loadChapters = useCallback(
    async (run: Run, mySeq: number) => {
      try {
        const data = await fetchChapters(run.id);
        if (!mounted.current || seq.current !== mySeq) return;
        setState({
          kind: "run",
          run: data.run,
          loaded: {
            document: data.document,
            confirmed: new Set(data.reviewed),
            shown: new Set(data.reviewed),
          },
        });
      } catch (error) {
        if (!mounted.current || seq.current !== mySeq || signedOut(error))
          return;
        const notReady = (error as { response?: { data?: { run?: Run } } })
          .response?.data?.run;
        if (status(error) === 409 && notReady) {
          displayRef.current(notReady);
          return;
        }
        setState({
          kind: "error",
          unavailable: status(error) === 503,
          detail: detailOf(error),
        });
      }
    },
    [signedOut],
  );

  const schedulePoll = useCallback(
    (runId: string, mySeq: number) => {
      stopPolling();
      pollTimer.current = setTimeout(async () => {
        try {
          const run = await fetchRun(runId);
          if (!mounted.current || seq.current !== mySeq) return;
          if (run.status === "ready") {
            setState({ kind: "run", run, loaded: null });
            void loadChapters(run, mySeq);
          } else {
            setState({ kind: "run", run, loaded: null });
            if (run.status !== "failed") schedulePoll(runId, mySeq);
          }
        } catch (error) {
          if (!mounted.current || seq.current !== mySeq || signedOut(error))
            return;
          setNote("Couldn't check on generation. Still trying.");
          schedulePoll(runId, mySeq);
        }
      }, POLL_MS);
    },
    [loadChapters, signedOut],
  );

  const display = useCallback(
    (run: Run) => {
      stopPolling();
      seq.current += 1;
      const mySeq = seq.current;
      setState({ kind: "run", run, loaded: null });
      if (run.status === "ready") void loadChapters(run, mySeq);
      else if (run.status !== "failed") schedulePoll(run.id, mySeq);
    },
    [loadChapters, schedulePoll],
  );
  displayRef.current = display;

  const hasRunOnScreen = () => stateRef.current.kind === "run";

  const generate = useCallback(async () => {
    setBusy(true);
    try {
      const run = await createRun(org, repo, prNumber);
      if (!mounted.current) return;
      setCandidate(run);
      display(run);
    } catch (error) {
      if (!mounted.current || signedOut(error)) return;
      const code = errorCode(error);
      if (hasRunOnScreen()) {
        setNote(
          code === "empty_diff"
            ? "The PR's latest revision has no changes to narrate."
            : `Couldn't start generation: ${detailOf(error)}`,
        );
      } else if (code === "empty_diff") setState({ kind: "emptyDiff" });
      else if (code === "pr_not_found") setState({ kind: "notFound" });
      else {
        setState({
          kind: "error",
          unavailable: status(error) === 503,
          detail: detailOf(error),
        });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [display, org, prNumber, repo, signedOut]);

  /**
   * Reads `runs/latest`. Only the first, untroubled lookup may generate; a
   * recovery lookup never does; a freshness lookup never switches the run.
   */
  const lookup = useCallback(
    async (mode: "initial" | "recover" | "fresh") => {
      try {
        const data = await fetchLatestRun(org, repo, prNumber);
        if (!mounted.current) return;
        setPr(data.pr);
        setCandidate(data.newerRun ?? data.run);
        if (mode === "fresh") return;
        if (data.run) display(data.run);
        else if (mode === "initial") void generate();
        else setState({ kind: "noRun" });
      } catch (error) {
        if (!mounted.current || signedOut(error)) return;
        if (mode === "fresh") {
          setNote("Couldn't check the PR for new commits.");
          return;
        }
        if (errorCode(error) === "pr_not_found") setState({ kind: "notFound" });
        else {
          setState({
            kind: "error",
            unavailable: status(error) === 503,
            detail: detailOf(error),
          });
        }
      }
    },
    [display, generate, org, prNumber, repo, signedOut],
  );

  useEffect(() => {
    mounted.current = true;
    void lookup("initial");
    const onFocus = () => {
      if (hasRunOnScreen()) void lookup("fresh");
    };
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      stopPolling();
      window.removeEventListener("focus", onFocus);
    };
    // The PR in the URL is fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tryAgain = useCallback(() => {
    setState({ kind: "loading" });
    void lookup("recover");
  }, [lookup]);

  const retry = useCallback(async () => {
    const current = stateRef.current;
    if (current.kind !== "run") return;
    setBusy(true);
    try {
      const run = await retryRun(current.run.id);
      if (mounted.current) display(run);
    } catch (error) {
      if (!mounted.current || signedOut(error)) return;
      setNote(`Couldn't retry: ${detailOf(error)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [display, signedOut]);

  const viewLatest = useCallback(
    async (runId: string) => {
      setBusy(true);
      try {
        const run = await fetchRun(runId);
        if (mounted.current) display(run);
      } catch (error) {
        if (!mounted.current || signedOut(error)) return;
        setNote(`Couldn't open the latest chapters: ${detailOf(error)}`);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [display, signedOut],
  );

  const toggleReviewed = useCallback(
    async (key: string, reviewed: boolean) => {
      const current = stateRef.current;
      if (current.kind !== "run" || !current.loaded) return;
      const runId = current.run.id;
      const flip = (set: Set<string>) => {
        const next = new Set(set);
        if (reviewed) next.add(key);
        else next.delete(key);
        return next;
      };
      const update = (fn: (l: Loaded) => Loaded) =>
        setState((s) =>
          s.kind === "run" && s.loaded && s.run.id === runId
            ? { ...s, loaded: fn(s.loaded) }
            : s,
        );
      update((l) => ({ ...l, shown: flip(l.shown) }));
      try {
        await setChapterReviewed(runId, key, reviewed);
        if (!mounted.current) return;
        update((l) => ({ ...l, confirmed: flip(l.confirmed) }));
      } catch (error) {
        if (!mounted.current || signedOut(error)) return;
        update((l) => {
          const shown = new Set(l.shown);
          if (l.confirmed.has(key)) shown.add(key);
          else shown.delete(key);
          return { ...l, shown };
        });
        setNote("Couldn't save your Reviewed mark. Please try again.");
      }
    },
    [signedOut],
  );

  return {
    state,
    pr,
    candidate,
    note,
    busy,
    dismissNote: () => setNote(null),
    tryAgain,
    generate,
    retry,
    viewLatest,
    toggleReviewed,
  };
}
