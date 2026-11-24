import { AnthropicLlmClient } from "./anthropicClient.js";
import { FakeLlmClient } from "./fakeClient.js";
import type { LlmClient } from "./LlmClient.js";

export * from "./LlmClient.js";
export { AnthropicLlmClient } from "./anthropicClient.js";
export { FakeLlmClient } from "./fakeClient.js";

/**
 * Picks the LLM from env (D6): `PR_REVIEWER_LLM=fake` for the scripted fake
 * (tests and the demo environment), otherwise the Anthropic API when
 * `ANTHROPIC_API_KEY` is set. Null when neither is configured.
 * `PR_REVIEWER_MODEL` and `PR_REVIEWER_EFFORT` override the defaults;
 * `PR_REVIEWER_FAKE_LLM_DELAY_MS` and `PR_REVIEWER_FAKE_LLM_OUTAGE_FILE` set
 * the fake's demo switches.
 */
export function createLlmClient(env: NodeJS.ProcessEnv): LlmClient | null {
  const model = env.PR_REVIEWER_MODEL || undefined;
  const effort = env.PR_REVIEWER_EFFORT || undefined;
  if (env.PR_REVIEWER_LLM === "fake")
    return new FakeLlmClient({
      effort,
      delayMs: Number(env.PR_REVIEWER_FAKE_LLM_DELAY_MS) || 0,
      outageFile: env.PR_REVIEWER_FAKE_LLM_OUTAGE_FILE || undefined,
    });
  if (env.ANTHROPIC_API_KEY)
    return new AnthropicLlmClient({
      apiKey: env.ANTHROPIC_API_KEY,
      model,
      effort,
    });
  return null;
}
