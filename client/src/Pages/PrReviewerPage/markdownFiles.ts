import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import axios from "axios";
import { fetchMarkdownFile } from "../../Services/PrReviewerService";
import { useSignedOut } from "./usePrReviewer";

/**
 * Markdown file texts for the rendered view, fetched at most once per
 * (run, path) for the page's life — several steps may show the same README,
 * and a View-latest switch to another run must never reuse the old text.
 */
export type Cache = Map<string, Promise<string>>;

export const MarkdownFilesContext = createContext<Cache | null>(null);

const cacheKey = (runId: string, path: string) => `${runId}\0${path}`;

export type MarkdownFileState =
  | { kind: "loading" }
  | { kind: "loaded"; text: string }
  | { kind: "failed"; reason: string };

function reasonOf(error: unknown): string {
  if (axios.isAxiosError(error) && error.response?.status === 404) {
    return "the file isn't available";
  }
  return "the request failed";
}

export function useMarkdownFile(
  runId: string,
  path: string,
): { file: MarkdownFileState; reload: () => void } {
  const cache = useContext(MarkdownFilesContext);
  const [file, setFile] = useState<MarkdownFileState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const signedOut = useSignedOut();

  useEffect(() => {
    let live = true;
    const key = cacheKey(runId, path);
    let pending = cache?.get(key);
    if (!pending) {
      const fetched = fetchMarkdownFile(runId, path).then((f) => f.text);
      // A failure isn't kept, so the next showing of the file fetches again.
      fetched.catch(() => {
        if (cache?.get(key) === fetched) cache.delete(key);
      });
      cache?.set(key, fetched);
      pending = fetched;
    }
    setFile({ kind: "loading" });
    pending.then(
      (text) => live && setFile({ kind: "loaded", text }),
      (error) => {
        if (!live || signedOut(error)) return;
        setFile({ kind: "failed", reason: reasonOf(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [cache, runId, path, attempt, signedOut]);

  const reload = useCallback(() => {
    cache?.delete(cacheKey(runId, path));
    setAttempt((n) => n + 1);
  }, [cache, runId, path]);

  return { file, reload };
}
