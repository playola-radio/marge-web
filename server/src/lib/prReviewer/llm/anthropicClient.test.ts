import { assert } from "chai";
import { z } from "zod";
import {
  AnthropicLlmClient,
  type MessagesApi,
  toStrictToolSchema,
} from "./anthropicClient.js";
import { LlmRequestError } from "./LlmClient.js";

/** A stand-in for the SDK's `messages.create`, answering from a script. */
export function mockMessages(
  responses: (unknown | Error)[],
): MessagesApi & { requests: Record<string, unknown>[] } {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    async create(body: Record<string, unknown>) {
      requests.push(body);
      const next = responses.shift();
      if (next === undefined) throw new Error("mock: no response scripted");
      if (next instanceof Error) throw next;
      return next as never;
    },
  };
}

/** An SDK response whose only content is one `emit_<stage>` tool call. */
export function toolUse(name: string, input: unknown) {
  return { content: [{ type: "tool_use", name, input }] };
}

const schema = z.object({ title: z.string().min(1), summary: z.string() });

function client(messages: MessagesApi) {
  return new AnthropicLlmClient({ messages, model: "claude-opus-5-5" });
}

const req = {
  stage: "summarize" as const,
  system: "You summarise pull requests.",
  user: "Summarise this.",
  schema,
  input: {},
};

describe("AnthropicLlmClient", () => {
  it("returns the typed output of a schema-valid tool call", async () => {
    const messages = mockMessages([
      toolUse("emit_summarize", { title: "Fix tests", summary: "It fixes." }),
    ]);
    const result = await client(messages).structured(req);
    assert.deepEqual(result, {
      ok: true,
      value: { title: "Fix tests", summary: "It fixes." },
    });
    assert.lengthOf(messages.requests, 1);
  });

  it("sends one strict tool, auto tool choice with parallel use off, and the emit-only system line", async () => {
    const messages = mockMessages([
      toolUse("emit_summarize", { title: "t", summary: "s" }),
    ]);
    await new AnthropicLlmClient({
      messages,
      model: "claude-opus-5-5",
      effort: "low",
    }).structured(req);
    const body = messages.requests[0] as {
      model: string;
      system: string;
      tools: { name: string; strict: boolean; input_schema: object }[];
      tool_choice: unknown;
      messages: { role: string; content: string }[];
      output_config: unknown;
    };
    assert.equal(body.model, "claude-opus-5-5");
    assert.include(body.system, "You summarise pull requests.");
    assert.include(
      body.system,
      "Respond only by calling the `emit_summarize` tool.",
    );
    assert.lengthOf(body.tools, 1);
    assert.equal(body.tools[0].name, "emit_summarize");
    assert.isTrue(body.tools[0].strict);
    assert.deepEqual(body.tools[0].input_schema, toStrictToolSchema(schema));
    assert.deepEqual(body.tool_choice, {
      type: "auto",
      disable_parallel_tool_use: true,
    });
    assert.deepEqual(body.messages, [
      { role: "user", content: "Summarise this." },
    ]);
    assert.deepEqual(body.output_config, { effort: "low" });
  });

  it("reports a schema-invalid response as a validation failure after exactly one request", async () => {
    const messages = mockMessages([
      toolUse("emit_summarize", { title: "", summary: 3 }),
    ]);
    const result = await client(messages).structured(req);
    assert.isFalse(result.ok);
    if (!result.ok) {
      assert.include(result.error, "title");
      assert.include(result.error, "summary");
    }
    assert.lengthOf(messages.requests, 1);
  });

  it("treats a response with no tool call as a validation failure", async () => {
    const messages = mockMessages([
      { content: [{ type: "text", text: "```json\n{}\n```" }] },
    ]);
    const result = await client(messages).structured(req);
    assert.isFalse(result.ok);
    if (!result.ok) assert.include(result.error, "emit_summarize");
    assert.lengthOf(messages.requests, 1);
  });

  it("raises an API or network failure as an LlmRequestError instead of a validation failure", async () => {
    const messages = mockMessages([new Error("401 invalid x-api-key")]);
    let caught: unknown;
    try {
      await client(messages).structured(req);
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, LlmRequestError);
    assert.include((caught as Error).message, "401 invalid x-api-key");
    assert.lengthOf(messages.requests, 1);
  });

  it("leaves retries to the runner: a 503 from the real SDK is one request", async () => {
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response('{"type":"error"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const sdkClient = new AnthropicLlmClient({ apiKey: "test-key" });
      let caught: unknown;
      try {
        await sdkClient.structured(req);
      } catch (err) {
        caught = err;
      }
      assert.instanceOf(caught, LlmRequestError);
      assert.equal(requests, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("toStrictToolSchema", () => {
  it("is a plain object schema with closed objects and no $schema", () => {
    const out = toStrictToolSchema(
      z.object({
        items: z.array(z.object({ id: z.string().min(1) })).min(1),
      }),
    ) as Record<string, unknown>;
    assert.notProperty(out, "$schema");
    assert.equal(out.type, "object");
    assert.equal(out.additionalProperties, false);
    const items = (out.properties as Record<string, Record<string, unknown>>)
      .items;
    const item = items.items as Record<string, unknown>;
    assert.equal(item.additionalProperties, false);
  });
});

describe("createLlmClient", () => {
  it("picks the fake, the Anthropic client, or nothing from env", async () => {
    const { createLlmClient, FakeLlmClient } = await import("./index.js");
    assert.instanceOf(
      createLlmClient({ PR_REVIEWER_LLM: "fake" }),
      FakeLlmClient,
    );
    const real = createLlmClient({
      ANTHROPIC_API_KEY: "sk-test",
      PR_REVIEWER_MODEL: "claude-sonnet-5-5",
    });
    assert.instanceOf(real, AnthropicLlmClient);
    assert.equal(real!.model, "claude-sonnet-5-5");
    assert.equal(
      createLlmClient({ ANTHROPIC_API_KEY: "sk-test" })!.model,
      "claude-opus-5-5",
    );
    assert.isNull(createLlmClient({}));
  });

  it("picks the Anthropic client from workload identity federation env", async () => {
    const { createLlmClient } = await import("./index.js");
    const federation = {
      ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
      ANTHROPIC_ORGANIZATION_ID: "org-test",
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/lib/render/oidc/anthropic.jwt",
    };
    assert.instanceOf(createLlmClient(federation), AnthropicLlmClient);
    assert.instanceOf(
      createLlmClient({
        ...federation,
        ANTHROPIC_IDENTITY_TOKEN_FILE: undefined,
        ANTHROPIC_IDENTITY_TOKEN: "jwt-value",
      }),
      AnthropicLlmClient,
    );
    assert.isNull(
      createLlmClient({ ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test" }),
    );
    assert.isNull(
      createLlmClient({
        ...federation,
        ANTHROPIC_IDENTITY_TOKEN_FILE: undefined,
      }),
    );
  });

  it("exchanges the federation token and authenticates a Messages request without an API key", async () => {
    const { createLlmClient } = await import("./index.js");
    const realFetch = globalThis.fetch;
    const savedEnv: Record<string, string | undefined> = {
      PR_REVIEWER_LLM: process.env.PR_REVIEWER_LLM,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_FEDERATION_RULE_ID: process.env.ANTHROPIC_FEDERATION_RULE_ID,
      ANTHROPIC_ORGANIZATION_ID: process.env.ANTHROPIC_ORGANIZATION_ID,
      ANTHROPIC_IDENTITY_TOKEN_FILE: process.env.ANTHROPIC_IDENTITY_TOKEN_FILE,
      ANTHROPIC_IDENTITY_TOKEN: process.env.ANTHROPIC_IDENTITY_TOKEN,
    };
    const calls: { url: string; headers: Headers; body: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : null;
      calls.push({ url, headers, body });
      if (url.endsWith("/v1/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fed-access-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(
          toolUse("emit_summarize", { title: "Federated", summary: "Works." }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      delete process.env.PR_REVIEWER_LLM;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
      process.env.ANTHROPIC_FEDERATION_RULE_ID = "fdrl_test";
      process.env.ANTHROPIC_ORGANIZATION_ID = "org-test";
      process.env.ANTHROPIC_IDENTITY_TOKEN = "jwt-value";

      const sdkClient = createLlmClient(process.env);
      assert.instanceOf(sdkClient, AnthropicLlmClient);
      const result = await sdkClient!.structured(req);

      assert.deepEqual(result, {
        ok: true,
        value: { title: "Federated", summary: "Works." },
      });
      assert.lengthOf(calls, 2);
      assert.isTrue(calls[0].url.endsWith("/v1/oauth/token"));
      const exchangeBody = JSON.parse(calls[0].body!) as Record<
        string,
        unknown
      >;
      assert.equal(exchangeBody.federation_rule_id, "fdrl_test");
      assert.equal(exchangeBody.organization_id, "org-test");
      assert.equal(exchangeBody.assertion, "jwt-value");

      assert.isTrue(calls[1].url.endsWith("/v1/messages"));
      assert.equal(
        calls[1].headers.get("authorization"),
        "Bearer fed-access-token",
      );
      assert.isNull(calls[1].headers.get("x-api-key"));
    } finally {
      globalThis.fetch = realFetch;
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
