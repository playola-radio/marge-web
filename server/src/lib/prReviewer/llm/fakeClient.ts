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

const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]+\.lock)$/;

interface OutlineIn {
  runs: { id: string; path: string }[];
}
interface WriteIn {
  headline: string;
  runs: { id: string; path: string }[];
}
interface SummarizeIn {
  branch: string;
  chapters: { headline: string }[];
}

/** A valid answer for each stage, derived from its input. */
export function defaultAnswer(stage: LlmStage, input: unknown): unknown {
  if (stage === "outline") {
    // Lockfiles are left out (unless nothing else changed); the rest is one
    // chapter per top-level directory (at most 12), in first-seen order.
    const all = (input as OutlineIn).runs;
    const kept = all.filter((r) => !LOCKFILE.test(r.path));
    const lockfiles =
      kept.length > 0 ? all.filter((r) => !kept.includes(r)) : [];
    const groups = new Map<string, string[]>();
    for (const run of lockfiles.length > 0 ? kept : all) {
      const top = run.path.includes("/") ? run.path.split("/")[0] : "(root)";
      groups.set(top, [...(groups.get(top) ?? []), run.id]);
    }
    const entries = [...groups.entries()];
    while (entries.length > 12) {
      const [, ids] = entries.pop()!;
      entries[entries.length - 1][1].push(...ids);
    }
    return {
      chapters: entries.map(([dir, ids], i) => ({
        key: `chapter-${i + 1}`,
        headline: dir === "(root)" ? "Top-level files" : `Changes in ${dir}`,
        runIds: ids,
      })),
      excluded: lockfiles.map((r) => ({
        runId: r.id,
        reason: "Generated lockfile.",
      })),
    };
  }
  if (stage === "write") {
    const { headline, runs } = input as WriteIn;
    return {
      intro: `This chapter covers: ${headline}.`,
      steps: runs.map((r) => ({
        runIds: [r.id],
        explanation: `Updates ${r.path}.`,
      })),
    };
  }
  const { branch, chapters } = input as SummarizeIn;
  return {
    title: branch,
    summary: `This pull request ${chapters
      .map((c) => c.headline.toLowerCase())
      .join(", then ")}.`,
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
