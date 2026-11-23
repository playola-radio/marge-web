import type { ZodType } from "zod";

/**
 * The LLM behind the pipeline's three model stages (D6). One `structured()`
 * call is exactly one request: it returns the schema-validated output or a
 * validation failure for the caller to act on. Retrying with the validation
 * error, and the deterministic fallback after it, belong to the pipeline.
 */

export type LlmStage = "outline" | "write" | "summarize";

export interface StructuredRequest<T> {
  stage: LlmStage;
  system: string;
  user: string;
  schema: ZodType<T>;
  /** The stage's canonical input, for clients that answer from it (the fake). */
  input: unknown;
}

export type StructuredResult<T> =
  | { ok: true; value: T; raw: unknown }
  | { ok: false; error: string; raw: unknown };

export interface LlmClient {
  readonly model: string;
  readonly effort: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** A network, auth or API failure: it aborts the attempt and never falls back. */
export class LlmRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmRequestError";
  }
}

export function toolName(stage: LlmStage): string {
  return `emit_${stage}`;
}

/** zod issues as one readable line, for the retry prompt and the QA trail. */
export function describeIssues(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map(
      (i) =>
        `${i.path.length ? i.path.map(String).join(".") : "(root)"}: ${i.message}`,
    )
    .join("; ");
}

/** Parses a raw tool input against the stage schema. */
export function validateRaw<T>(
  schema: ZodType<T>,
  raw: unknown,
): StructuredResult<T> {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data, raw }
    : { ok: false, error: describeIssues(parsed.error), raw };
}
