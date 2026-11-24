import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  LlmRequestError,
  validateRaw,
  type LlmClient,
  type LlmStage,
  type StructuredRequest,
  type StructuredResult,
} from "./LlmClient.js";
import { SUMMARY_MAX_WORDS } from "../pipeline/schema.js";

/**
 * A scripted stand-in for the LLM (tests, and the demo environment via
 * `PR_REVIEWER_LLM=fake`). Each stage answers from its script queue first —
 * a raw tool input (validated like a real response), an Error (thrown, like a
 * network failure), or a function of the request — and otherwise from a
 * deterministic default built from the stage's input.
 *
 * Two switches exist for recording the demo: `delayMs` slows every answer so
 * the stage progress is visible, and summarize fails while `outageFile`
 * exists, so a run fails part-way and can be retried.
 */

export type FakeAnswer =
  | Error
  | ((req: StructuredRequest<unknown>) => unknown | Promise<unknown>)
  | Record<string, unknown>;

export interface FakeLlmOptions {
  script?: Partial<Record<LlmStage, FakeAnswer[]>>;
  model?: string;
  effort?: string;
  delayMs?: number;
  outageFile?: string;
}

const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|[^/]+\.lock)$/;

interface Commit {
  sha: string;
  subject: string;
  body: string;
}
interface OutlineIn {
  commits?: Commit[];
  runs: { id: string; path: string; owners?: string[] }[];
}
interface WriteIn {
  headline: string;
  runs: { id: string; path: string }[];
  commits?: Commit[];
}
interface SummarizeIn {
  branch: string;
  subjects?: string[];
  chapters: { headline: string }[];
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A valid answer for each stage, derived from its input. */
export function defaultAnswer(stage: LlmStage, input: unknown): unknown {
  if (stage === "outline") {
    // Lockfiles are left out (unless nothing else changed); the rest is one
    // chapter per commit that wrote it (at most 12), oldest commit first.
    const { commits = [], runs: all } = input as OutlineIn;
    const isLock = (r: { path: string }) => LOCKFILE.test(r.path);
    const lockfiles = all.every(isLock) ? [] : all.filter(isLock);
    const kept = lockfiles.length > 0 ? all.filter((r) => !isLock(r)) : all;
    const subjects = new Map(commits.map((c) => [c.sha, c.subject]));
    const groups = new Map<string, string[]>(commits.map((c) => [c.sha, []]));
    for (const run of kept) {
      const owner = run.owners?.[0] ?? "";
      const key = subjects.has(owner) ? owner : "";
      groups.set(key, [...(groups.get(key) ?? []), run.id]);
    }
    const entries = [...groups.entries()].filter(([, ids]) => ids.length > 0);
    while (entries.length > 12) {
      const [, ids] = entries.pop()!;
      entries[entries.length - 1][1].push(...ids);
    }
    return {
      chapters: entries.map(([sha, ids], i) => ({
        key: `chapter-${i + 1}`,
        headline: subjects.get(sha) ?? "Other changes",
        runIds: ids,
      })),
      excluded: lockfiles.map((r) => ({
        runId: r.id,
        reason: "Generated lockfile.",
      })),
    };
  }
  if (stage === "write") {
    const { headline, runs, commits = [] } = input as WriteIn;
    return {
      intro:
        commits.find((c) => c.body)?.body ??
        `This chapter covers: ${headline}.`,
      steps: runs.map((r) => ({
        runIds: [r.id],
        explanation: `Updates ${r.path}.`,
      })),
    };
  }
  const { branch, subjects = [], chapters } = input as SummarizeIn;
  const points =
    subjects.length > 0 ? subjects : chapters.map((c) => c.headline);
  const summary = points
    .map((p, i) => (i === 0 ? upperFirst(p) : lowerFirst(p)))
    .join(", then ");
  return {
    title: upperFirst(branch.split("/").pop()!.replace(/[-_]+/g, " ")),
    summary: `${summary.split(/\s+/).slice(0, SUMMARY_MAX_WORDS).join(" ")}.`,
  };
}

export class FakeLlmClient implements LlmClient {
  readonly model: string;
  readonly effort: string;
  readonly calls: StructuredRequest<unknown>[] = [];
  private readonly script: Partial<Record<LlmStage, FakeAnswer[]>>;
  private readonly delayMs: number;
  private readonly outageFile?: string;

  constructor(options: FakeLlmOptions = {}) {
    this.model = options.model ?? "fake";
    this.effort = options.effort ?? "low";
    this.delayMs = options.delayMs ?? 0;
    this.outageFile = options.outageFile;
    this.script = Object.fromEntries(
      Object.entries(options.script ?? {}).map(([k, v]) => [k, [...v]]),
    );
  }

  callsFor(stage: LlmStage): StructuredRequest<unknown>[] {
    return this.calls.filter((c) => c.stage === stage);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (
      req.stage === "summarize" &&
      this.outageFile &&
      existsSync(this.outageFile)
    )
      throw new LlmRequestError("The LLM is unavailable (demo outage).");
    const next = this.script[req.stage]?.shift();
    if (next instanceof Error) {
      throw next instanceof LlmRequestError
        ? next
        : new LlmRequestError(`The LLM request failed: ${next.message}`);
    }
    const raw =
      typeof next === "function"
        ? await next(req as StructuredRequest<unknown>)
        : (next ?? defaultAnswer(req.stage, req.input));
    return validateRaw(req.schema, raw);
  }
}
