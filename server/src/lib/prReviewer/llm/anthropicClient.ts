import Anthropic from "@anthropic-ai/sdk";
import { z, type ZodType } from "zod";
import {
  LlmRequestError,
  toolName,
  validateRaw,
  type LlmClient,
  type StructuredRequest,
  type StructuredResult,
} from "./LlmClient.js";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT = "low";
const MAX_TOKENS = 16_000;

/** The slice of the SDK's `client.messages` this client uses (mocked in tests). */
export interface MessagesApi {
  create(body: Record<string, unknown>): Promise<unknown>;
}

export interface AnthropicLlmClientOptions {
  /** Injected in tests; otherwise the SDK client is built from `apiKey`. */
  messages?: MessagesApi;
  /**
   * Explicit API key. When omitted, the SDK resolves credentials from its own
   * environment variables (workload identity federation on Render).
   */
  apiKey?: string;
  model?: string;
  effort?: string;
}

// Strict tool schemas accept only a subset of JSON Schema; the zod schema
// still enforces every dropped constraint when the response is validated.
const UNSUPPORTED = new Set(["$schema", "minLength"]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED.has(key)) continue;
    out[key] = strip(value);
  }
  return out;
}

/** The zod schema as a strict tool `input_schema` (objects closed). */
export function toStrictToolSchema(schema: ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

/**
 * The Anthropic API client (reference §6.1): one request per call, a single
 * strict tool named `emit_<stage>`, `tool_choice: auto` with parallel tool use
 * off (forced tool choice is rejected by the model), and the tool input
 * validated with zod. Never retries a validation failure itself.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  readonly effort: string;
  private readonly messages: MessagesApi;

  constructor(options: AnthropicLlmClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    if (options.messages) this.messages = options.messages;
    else {
      const sdk = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
      this.messages = sdk.messages as unknown as MessagesApi;
    }
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const name = toolName(req.stage);
    let response: { content?: ContentBlock[] };
    try {
      response = (await this.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: `${req.system}\n\nRespond only by calling the \`${name}\` tool.`,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name,
            description: `Emit the ${req.stage} result.`,
            strict: true,
            input_schema: toStrictToolSchema(req.schema),
          },
        ],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        output_config: { effort: this.effort },
      })) as { content?: ContentBlock[] };
    } catch (err) {
      throw new LlmRequestError(
        `The LLM request failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }
    const call = (response.content ?? []).find(
      (b) => b.type === "tool_use" && b.name === name,
    );
    if (!call)
      return {
        ok: false,
        error: `The response did not call the \`${name}\` tool.`,
      };
    return validateRaw(req.schema, call.input);
  }
}
