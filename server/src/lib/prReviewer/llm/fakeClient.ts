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
 */

export type FakeAnswer =
  | Error
  | ((req: StructuredRequest<unknown>) => unknown | Promise<unknown>)
  | Record<string, unknown>;

export interface FakeLlmOptions {
  script?: Partial<Record<LlmStage, FakeAnswer[]>>;
  model?: string;
  effort?: string;
}

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
    // One chapter per top-level directory (at most 12), in first-seen order.
    const groups = new Map<string, string[]>();
    for (const run of (input as OutlineIn).runs) {
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
      excluded: [],
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

  constructor(options: FakeLlmOptions = {}) {
    this.model = options.model ?? "fake";
    this.effort = options.effort ?? "low";
    this.script = Object.fromEntries(
      Object.entries(options.script ?? {}).map(([k, v]) => [k, [...v]]),
    );
  }

  callsFor(stage: LlmStage): StructuredRequest<unknown>[] {
    return this.calls.filter((c) => c.stage === stage);
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
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
