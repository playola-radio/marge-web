import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { LlmClient, LlmStage } from "../llm/LlmClient.js";
import { PROMPT_VERSION } from "./schema.js";

/**
 * What every LLM stage shares (reference §6.3): the content-hash stage cache,
 * one retry with the validation error appended, then the stage's
 * deterministic fallback. An LlmRequestError (network/auth) propagates and
 * aborts the attempt; it never falls back.
 */

export interface StageCacheEntry {
  output: unknown;
  fallbackUsed: boolean;
}

export interface StageCache {
  get(key: string): Promise<StageCacheEntry | null>;
  /** Keeps the first entry stored under a key. */
  put(key: string, stage: LlmStage, entry: StageCacheEntry): Promise<void>;
}

export class MemoryStageCache implements StageCache {
  readonly entries = new Map<string, StageCacheEntry & { stage: LlmStage }>();

  async get(key: string): Promise<StageCacheEntry | null> {
    const hit = this.entries.get(key);
    return hit
      ? { output: structuredClone(hit.output), fallbackUsed: hit.fallbackUsed }
      : null;
  }

  async put(key: string, stage: LlmStage, entry: StageCacheEntry) {
    if (!this.entries.has(key))
      this.entries.set(key, { ...structuredClone(entry), stage });
  }
}

/** JSON with object keys sorted at every level, so equal inputs hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/** sha256(stage, prompt version, model, effort, canonical stage input). */
export function cacheKey(
  stage: LlmStage,
  llm: Pick<LlmClient, "model" | "effort">,
  input: unknown,
): string {
  return createHash("sha256")
    .update(
      canonicalJson([stage, PROMPT_VERSION, llm.model, llm.effort, input]),
    )
    .digest("hex");
}

export interface LlmStageOptions<T> {
  stage: LlmStage;
  llm: LlmClient;
  cache: StageCache;
  system: string;
  user: string;
  input: unknown;
  schema: ZodType<T>;
  /** Checks beyond the schema (coverage, counts); returns the problem or null. */
  check: (value: T) => string | null;
  fallback: () => T;
}

export interface LlmStageResult<T> {
  output: T;
  fallbackUsed: boolean;
  cacheHit: boolean;
}

export async function runLlmStage<T>(
  opts: LlmStageOptions<T>,
): Promise<LlmStageResult<T>> {
  const key = cacheKey(opts.stage, opts.llm, opts.input);
  // A hit is trusted as stored: it was validated (or is a fallback, which
  // need not meet the LLM schema — e.g. an empty intro) when it was written.
  const hit = await opts.cache.get(key);
  if (hit)
    return {
      output: hit.output as T,
      fallbackUsed: hit.fallbackUsed,
      cacheHit: true,
    };

  let user = opts.user;
  let result: { output: T; fallbackUsed: boolean } | null = null;
  for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
    const response = await opts.llm.structured({
      stage: opts.stage,
      system: opts.system,
      user,
      schema: opts.schema,
      input: opts.input,
    });
    const problem = response.ok ? opts.check(response.value) : response.error;
    if (response.ok && problem === null)
      result = { output: response.value, fallbackUsed: false };
    else
      user =
        `${opts.user}\n\nYour previous response was invalid: ${problem}\n` +
        "Call the tool again with a corrected result.";
  }
  result ??= { output: opts.fallback(), fallbackUsed: true };
  await opts.cache.put(key, opts.stage, result);
  return { ...result, cacheHit: false };
}

/** Which stage an attempt failed in, for the run's plain-English failure line. */
export class StageFailure extends Error {
  constructor(
    readonly stage: "outline" | "write" | "summarize" | "assemble",
    readonly cause: unknown,
    readonly chapterNumber?: number,
  ) {
    super((cause as Error)?.message ?? String(cause));
    this.name = "StageFailure";
  }
}
