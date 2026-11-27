import axios from "axios";
import { readToken } from "../utils/session";

/** The PR metadata pinned on a run at creation (ApiContract.md, `run.pr`). */
export type RunPr = {
  title: string;
  url: string;
  baseRef: string;
  headRef: string;
  commits: number;
};

export type RunStatus = "queued" | "generating" | "ready" | "failed";

export type RunStage = "fetch" | "extract" | "outline" | "write" | "summarize";

export type Run = {
  id: string;
  org: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  pipelineVersion: string;
  status: RunStatus;
  progress: {
    stage: RunStage;
    completedChapters?: number;
    totalChapters?: number;
  } | null;
  failure: string | null;
  failureDetail: string | null;
  pr: RunPr;
  createdAt: string;
  updatedAt: string;
};

export type ChangedFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};

/** The PR as GitHub has it now, from `runs/latest`. */
export type CurrentPr = RunPr & {
  currentHeadSha: string;
  currentBaseSha: string;
  author: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** At most 300 (GitHub's limit); `changedFiles` is the true count. */
  files: ChangedFile[];
};

export type LatestResponse = {
  pr: CurrentPr;
  run: Run | null;
  newerRun?: Run;
};

export type DiffLine = {
  kind: " " | "+" | "-";
  oldNo?: number;
  newNo?: number;
  text: string;
  runId?: string;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
};

export type DocRun = {
  id: string;
  path: string;
  commitSha: string;
  added: number;
  removed: number;
  oldRange?: [number, number];
  newRange?: [number, number];
};

export type Step = { runIds: string[]; explanation: string };

export type Chapter = {
  key: string;
  number: number;
  headline: string;
  intro: string;
  runIds: string[];
  steps: Step[];
};

/** chapters.json v1 (reference §7) plus the PR-mode `pr` field, served verbatim. */
export type ChaptersDocument = {
  version: 1;
  repo: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  generatedAt: string;
  model: string;
  promptVersion: string;
  fallbacks: string[];
  title: string;
  summary: string;
  commits: { sha: string; subject: string; author: string; date: string }[];
  files: DiffFile[];
  runs: DocRun[];
  chapters: Chapter[];
  excluded: { runId: string; reason: string }[];
  pr?: {
    number: number;
    title: string;
    url: string;
    host: string;
    owner: string;
    repo: string;
  };
};

export type ChaptersResponse = {
  run: Run;
  document: ChaptersDocument;
  reviewed: string[];
};

export type MarkdownFile = { path: string; text: string };

const serverBaseUrl = import.meta.env.VITE_SERVER_BASE_URL;
const TIMEOUT_MS = 15_000;

function config() {
  return {
    headers: { Authorization: "Bearer " + readToken() },
    timeout: TIMEOUT_MS,
  };
}

const enc = encodeURIComponent;
const base = `${serverBaseUrl}/v1/pr-reviewer`;
const prBase = (org: string, repo: string, prNumber: string | number) =>
  `${base}/${enc(org)}/${enc(repo)}/pulls/${enc(String(prNumber))}`;
const runBase = (runId: string) => `${base}/runs/${enc(runId)}`;

export async function fetchLatestRun(
  org: string,
  repo: string,
  prNumber: string | number,
): Promise<LatestResponse> {
  const { data } = await axios.get<LatestResponse>(
    `${prBase(org, repo, prNumber)}/runs/latest`,
    config(),
  );
  return data;
}

export async function createRun(
  org: string,
  repo: string,
  prNumber: string | number,
): Promise<Run> {
  const { data } = await axios.post<{ run: Run }>(
    `${prBase(org, repo, prNumber)}/runs`,
    null,
    config(),
  );
  return data.run;
}

export async function fetchRun(runId: string): Promise<Run> {
  const { data } = await axios.get<{ run: Run }>(runBase(runId), config());
  return data.run;
}

export async function retryRun(runId: string): Promise<Run> {
  const { data } = await axios.post<{ run: Run }>(
    `${runBase(runId)}/retry`,
    null,
    config(),
  );
  return data.run;
}

export async function fetchChapters(runId: string): Promise<ChaptersResponse> {
  const { data } = await axios.get<ChaptersResponse>(
    `${runBase(runId)}/chapters`,
    config(),
  );
  return data;
}

export async function fetchMarkdownFile(
  runId: string,
  path: string,
): Promise<MarkdownFile> {
  const { data } = await axios.get<MarkdownFile>(`${runBase(runId)}/files`, {
    ...config(),
    params: { path },
  });
  return data;
}

export async function setChapterReviewed(
  runId: string,
  chapterKey: string,
  reviewed: boolean,
): Promise<void> {
  const url = `${runBase(runId)}/chapters/${enc(chapterKey)}/reviewed`;
  if (reviewed) await axios.put(url, null, config());
  else await axios.delete(url, config());
}
