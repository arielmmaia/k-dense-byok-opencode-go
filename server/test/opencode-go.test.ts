import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Api, Context } from "@earendil-works/pi-ai";
import { getModelRegistry, getModelRuntime } from "../src/agent/session-registry.ts";
import { assertModelAuthentication, modelReference, resolveModel } from "../src/agent/models.ts";
import { goHelperSessionId, goRequestOptions } from "../src/agent/opencode-go.ts";
import { makeSubagentLedgerExtension } from "../src/agent/subagent-bridge.ts";
import { createProject } from "../src/projects.ts";
import { emptySnapshot, isBudgetExceeded, recordRun, sessionCostSummary } from "../src/cost/ledger.ts";

const runtime = getModelRuntime();
const registry = getModelRegistry();
const context: Context = { messages: [{ role: "user", content: "Inspect the test fixture.", timestamp: 0 }] };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kady-go-"));
  vi.stubEnv("OPENCODE_API_KEY", "test-go-key-not-a-real-credential");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Wire-format fixtures exercise Pi's real adapters, including tools and usage,
// while every model request is intercepted before any network access.
function response(api: Api, toolCall = false): Response {
  let events: Record<string, unknown>[];
  if (api === "anthropic-messages") {
    events = [
      { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ready" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
  } else if (api === "openai-responses") {
    const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Ready", annotations: [] }] };
    events = [
      { type: "response.created", response: { id: "resp_test" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Ready" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ];
  } else {
    events = [{
      id: "chat_test", object: "chat.completion.chunk", created: 0,
      choices: [{ index: 0, delta: toolCall
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "probe", arguments: "{}" } }] }
        : { role: "assistant", content: "Ready" }, finish_reason: toolCall ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }];
  }
  const body = events.map((event) => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("OpenCode Go dispatch", () => {
  it.each([
    ["kimi-k2.6", "openai-completions", "/zen/go/v1/chat/completions"],
    ["minimax-m3", "anthropic-messages", "/zen/go/v1/messages"],
    ["gpt-5.6-luna", "openai-responses", "/zen/go/v1/responses"],
  ] as const)("resolves and streams %s through its Go API with helper headers", async (id, api, endpoint) => {
    const model = resolveModel(`opencode-go/${id}`, registry);
    expect(model.api).toBe(api);
    expect(modelReference(model)).toBe(`opencode-go/${id}`);
    await expect(assertModelAuthentication(model, runtime)).resolves.toBeUndefined();
    const requests: Request[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      requests.push(new Request(input, init));
      return response(api);
    });
    const options = goRequestOptions(model, goHelperSessionId("project", "methods-draft", "chat"));
    const message = await runtime.completeSimple(model, context, { ...options, fetch: fetchMock, maxRetries: 0, reasoning: "high", maxTokens: 64 });
    expect(message.stopReason, message.errorMessage).toBe("stop");
    expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "Ready" }));
    expect(message.usage.totalTokens).toBe(12);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0].url);
    expect(url.origin).toBe("https://opencode.ai");
    expect(url.pathname).toBe(endpoint); // Anthropic's SDK also adds ?beta=true.
    expect(requests[0].headers.get("x-opencode-session")).toBe(options.sessionId);
    expect(requests[0].headers.get("user-agent")).toMatch(/^kady\//);
    expect(await requests[0].json()).toMatchObject({ model: id });
  });

  it("keeps native Pi chat identity through tools and turns, with separate identities per session", async () => {
    const model = resolveModel("opencode-go/kimi-k2.6", registry);
    const requests: Request[] = [];
    const seen = new Set<string>();
    const stream = runtime.streamSimple.bind(runtime);
    const fetchMock: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const id = request.headers.get("x-opencode-session")!;
      const first = !seen.has(id);
      seen.add(id);
      return response(model.api, first);
    };
    vi.spyOn(runtime, "streamSimple").mockImplementation((m, c, options) => stream(m, c, { ...options, fetch: fetchMock, maxRetries: 0 }));
    const probe = vi.fn(async () => ({ content: [{ type: "text" as const, text: "fixture inspected" }], details: {} }));
    const ids: string[] = [];
    // pi-subagents also constructs native Pi sessions; the provider's SDK
    // header path is shared, while each child owns its own SessionManager.
    for (let i = 0; i < 2; i++) {
      const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false, compaction: { enabled: false }, retry: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Inspect fixtures using probe." });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), tools: ["probe"], customTools: [{ name: "probe", label: "Probe", description: "Inspect a test fixture", parameters: Type.Object({}), execute: probe }] });
      try {
        ids.push(session.sessionId);
        await session.prompt("Inspect the fixture.");
        await session.prompt("Summarize the result.");
      } finally {
        session.dispose();
      }
    }
    expect(probe).toHaveBeenCalledTimes(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(requests.map((r) => r.headers.get("x-opencode-session"))).toEqual([ids[0], ids[0], ids[0], ids[1], ids[1], ids[1]]);
    for (const request of requests) {
      expect(request.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
      expect(request.headers.get("user-agent")).toMatch(/^pi /);
    }
    expect((await requests[1].json()).messages).toContainEqual(expect.objectContaining({ role: "tool", content: "fixture inspected" }));
  });

  it.each([401, 429])("surfaces Go HTTP %s errors without routing to a paid provider", async (status) => {
    const model = resolveModel("opencode-go/kimi-k2.6", registry);
    const requests: string[] = [];
    const message = await runtime.completeSimple(model, context, {
      ...goRequestOptions(model, "test-session"), maxRetries: 0,
      fetch: async (input, init) => {
        requests.push(new Request(input, init).url);
        return new Response(JSON.stringify({ error: { message: "Go subscription unavailable", type: "subscription_error" } }), { status, headers: { "content-type": "application/json" } });
      },
    });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Go subscription unavailable");
    expect(requests).toEqual(["https://opencode.ai/zen/go/v1/chat/completions"]);
  });

  it("isolates helper identities by project, purpose and source, without changing other providers", () => {
    const id = goHelperSessionId("a", "methods-draft", "chat");
    expect(id).toBe(goHelperSessionId("a", "methods-draft", "chat"));
    expect(new Set([id, goHelperSessionId("b", "methods-draft", "chat"), goHelperSessionId("a", "latex-assist", "chat"), goHelperSessionId("a", "methods-draft", "other")]).size).toBe(4);
    expect(goRequestOptions({ provider: "opencode" }, id)).toEqual({});
    expect(goRequestOptions({ provider: "openrouter" }, id, { Authorization: "test" })).toEqual({ headers: { Authorization: "test" } });
  });
});

describe("Go specialist billing and budget gates", () => {
  it("inherits Go above the cap, records child reference usage, and still gates Zen", async () => {
    const p = createProject({ name: "Go specialists", spendLimitUsd: 0.01 });
    recordRun({ projectId: p.id, sessionId: "spent", model: "opencode/kimi-k2.6", before: emptySnapshot(), after: { ...emptySnapshot(), costUsd: 1 } });
    expect(isBudgetExceeded(p.id).exceeded).toBe(true);
    const handlers = new Map<string, (event: any) => any>();
    makeSubagentLedgerExtension(p.id, () => "parent", () => resolveModel("opencode-go/kimi-k2.6", registry))({
      on: (name: string, handler: (event: any) => any) => handlers.set(name, handler), events: { on: () => {} },
    } as never);
    const input: Record<string, unknown> = { workflowScript: 'return runs.run("test", { agent: "scout", task: "inspect" })' };
    expect(await handlers.get("tool_call")!({ toolName: "subagent", input })).toBeUndefined();
    expect(input.model).toBe("opencode-go/kimi-k2.6");
    await handlers.get("tool_result")!({ toolName: "subagent", details: { results: [{ model: input.model, usage: { input: 10, output: 2, cost: 0.4 } }] } });
    const costs = sessionCostSummary("parent", p.id);
    expect(costs.entries[0]).toMatchObject({ role: "subagent", provider: "opencode-go", billingMode: "subscription", costUsd: 0, listPriceUsd: 0.4 });
    expect(costs.subscriptionTokens).toBe(12);
    expect(await handlers.get("tool_call")!({ toolName: "subagent", input: { ...input, model: "opencode/kimi-k2.6" } })).toMatchObject({ block: true });
  });
});
