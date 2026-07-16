import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(() => ({
    path: "/tmp/managed-worktree",
    branch: "pi-agent-managed",
    baseSha: "abc123",
    workPath: "/tmp/managed-worktree",
  })),
  cleanupWorktree: vi.fn(() => ({ hasChanges: true, branch: "pi-agent-managed" })),
  pruneWorktrees: vi.fn(),
}));

import { type RunOptions, type RunResult, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { SUBAGENT_HOST_SYMBOL } from "../src/subagent-host.js";
import type { ManagedSpawnRequest, SubagentHostV1 } from "../src/types.js";

const MANAGER_SYMBOL = Symbol.for("pi-subagents:manager");

interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

interface ExecutableTool {
  execute(
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: never,
  ): Promise<ToolResult>;
}

interface ExtensionHarness {
  readonly pi: ReturnType<typeof makePi>["pi"];
  readonly tools: Map<string, unknown>;
  readonly lifecycle: Map<string, unknown>;
}

const MODELS = [
  { id: "parent", name: "Parent", provider: "test" },
  { id: "pinned", name: "Pinned", provider: "test" },
  { id: "requested", name: "Requested", provider: "test" },
];

function makePi() {
  const tools = new Map<string, unknown>();
  const lifecycle = new Map<string, unknown>();
  const eventHandlers = new Map<string, unknown>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      const registered = tool as { name: string };
      tools.set(registered.name, tool);
    }),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: unknown) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };
  return { pi, tools, lifecycle, eventHandlers };
}

function createContext(cwd: string) {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd,
    model: MODELS[0],
    modelRegistry: {
      find: (provider: string, id: string) => MODELS.find((model) => model.provider === provider && model.id === id),
      getAll: () => MODELS,
      getAvailable: () => MODELS,
    },
    sessionManager: { getSessionId: vi.fn(() => "session-1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  };
}

function createSession() {
  const listeners: Array<(event: never) => void> = [];
  const session = {
    messages: [] as Array<Record<string, unknown>>,
    agent: {
      state: {
        tools: [{ name: "read" }],
        systemPrompt: "initial prompt",
      },
      streamFn: vi.fn(() => undefined),
    },
    subscribe: vi.fn((listener: (event: never) => void) => {
      listeners.push(listener);
      return () => undefined;
    }),
    prompt: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    waitForIdle: vi.fn(async () => undefined),
    dispose: vi.fn(),
    getSessionStats: vi.fn(() => ({
      tokens: { input: 0, output: 0, cacheWrite: 0 },
      contextUsage: { percent: null },
    })),
  };
  return { session, listeners };
}

function immediateRun(captured: RunOptions[], sessions: ReturnType<typeof createSession>[]) {
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, options) => {
    captured.push(options);
    const created = createSession();
    sessions.push(created);
    await options.configureSession?.(created.session as never);
    options.onSessionCreated?.(created.session as never);
    options.onToolActivity?.({ type: "start", toolName: "read" });
    options.onToolActivity?.({ type: "end", toolName: "read" });
    options.onTurnEnd?.(2);
    options.onAssistantUsage?.({ input: 4, output: 5, cacheWrite: 6 });
    options.onCompaction?.({ reason: "threshold", tokensBefore: 100 });
    created.session.messages.push(
      { role: "user", content: prompt },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    );
    for (const listener of created.listeners) listener({ type: "turn_end" } as never);
    return {
      responseText: "done",
      session: created.session,
      aborted: false,
      steered: false,
    } as unknown as RunResult;
  });
}

function request(overrides: Partial<ManagedSpawnRequest> = {}): ManagedSpawnRequest {
  return {
    prompt: "do managed work",
    description: "managed contract agent",
    agentType: "general-purpose",
    queue: "external",
    notification: "suppress",
    metadata: { workflowRunId: "run-1", callKey: "call-1" },
    excludeExtensions: ["pi-workflows"],
    ...overrides,
  } as ManagedSpawnRequest;
}

function tool(harness: ExtensionHarness, name: string): ExecutableTool {
  const value = harness.tools.get(name);
  if (!value) throw new Error(`Missing tool: ${name}`);
  return value as ExecutableTool;
}

async function fireLifecycle(harness: ExtensionHarness, event: string, ctx: ReturnType<typeof createContext>) {
  const handler = harness.lifecycle.get(event) as
    | ((payload: unknown, context: never) => void | Promise<void>)
    | undefined;
  await handler?.({}, ctx as never);
}

function emitted(harness: ExtensionHarness, event: string): unknown[] {
  return harness.pi.events.emit.mock.calls
    .filter(([name]) => name === event)
    .map(([, payload]) => payload);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("SubagentHostV1 integration", () => {
  let projectDir: string;
  let agentDir: string;
  let previousCwd: string;
  let previousAgentDir: string | undefined;
  let previousHome: string | undefined;
  let priorHost: unknown;
  let priorManager: unknown;
  const activations: ExtensionHarness[] = [];

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "pi-host-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-host-agent-"));
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, defaultJoinMode: "async" }),
    );
    previousCwd = process.cwd();
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    previousHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    process.chdir(projectDir);
    priorHost = Reflect.get(globalThis, SUBAGENT_HOST_SYMBOL);
    priorManager = Reflect.get(globalThis, MANAGER_SYMBOL);
    Reflect.deleteProperty(globalThis, SUBAGENT_HOST_SYMBOL);
    Reflect.deleteProperty(globalThis, MANAGER_SYMBOL);
  });

  afterEach(async () => {
    for (const activation of activations.splice(0)) {
      await fireLifecycle(activation, "session_shutdown", createContext(projectDir));
    }
    if (priorHost === undefined) Reflect.deleteProperty(globalThis, SUBAGENT_HOST_SYMBOL);
    else Reflect.set(globalThis, SUBAGENT_HOST_SYMBOL, priorHost);
    if (priorManager === undefined) Reflect.deleteProperty(globalThis, MANAGER_SYMBOL);
    else Reflect.set(globalThis, MANAGER_SYMBOL, priorManager);
    vi.mocked(runAgent).mockReset();
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function activate(): Promise<{ harness: ExtensionHarness; host: SubagentHostV1; ctx: ReturnType<typeof createContext> }> {
    const harness = makePi() as ExtensionHarness;
    activations.push(harness);
    subagentsExtension(harness.pi as never);
    const ctx = createContext(projectDir);
    await fireLifecycle(harness, "session_start", ctx);
    const host = Reflect.get(globalThis, SUBAGENT_HOST_SYMBOL) as SubagentHostV1 | undefined;
    if (!host) throw new Error("Host was not registered");
    return { harness, host, ctx };
  }

  it("publishes version 1 and normalizes hooks, metadata, transcript, usage, and completion", async () => {
    const captured: RunOptions[] = [];
    const sessions: ReturnType<typeof createSession>[] = [];
    immediateRun(captured, sessions);
    const { harness, host } = await activate();
    const transcriptDirectory = mkdtempSync(join(projectDir, "transcripts-"));
    const metadata = Object.freeze({
      workflowRunId: "run-1",
      callKey: "call-1",
      future: Object.freeze({ nested: [1, "two"] }),
    });
    const hookOrder: string[] = [];

    const spawn = host.spawn(request({ metadata, transcriptDirectory, groupId: "phase-review" }), {
      configureSession: async (session) => {
        hookOrder.push("configure:start");
        await Promise.resolve();
        session.agent.state.tools = [{ name: "StructuredOutput" }];
        session.agent.state.systemPrompt = "configured";
        hookOrder.push("configure:end");
      },
      onActivity: (activity) => hookOrder.push(`activity:${activity.type}`),
      onTurn: ({ turnCount }) => hookOrder.push(`turn:${turnCount}`),
      onUsage: ({ output }) => hookOrder.push(`usage:${output}`),
      onCompaction: ({ reason }) => hookOrder.push(`compaction:${reason}`),
    });

    const completion = await spawn.completion;
    expect(host.version).toBe(1);
    expect(completion).toEqual({
      agentId: spawn.agentId,
      status: "completed",
      text: "done",
      usage: { input: 4, output: 5, cacheWrite: 6 },
    });
    expect(hookOrder).toEqual([
      "configure:start",
      "configure:end",
      "activity:start",
      "activity:end",
      "turn:2",
      "usage:5",
      "compaction:threshold",
    ]);
    expect(sessions[0].session.agent.state).toMatchObject({
      tools: [{ name: "StructuredOutput" }],
      systemPrompt: "configured",
    });
    expect(captured[0]).toMatchObject({
      controllerExtensionDenylist: ["pi-workflows"],
    });

    const snapshot = host.get(spawn.agentId);
    expect(snapshot).toMatchObject({
      agentId: spawn.agentId,
      status: "completed",
      usage: { input: 4, output: 5, cacheWrite: 6 },
      turnCount: 2,
      compactionCount: 1,
      activity: { type: "end", toolName: "read" },
      metadata,
    });
    expect(snapshot?.metadata).toBe(metadata);

    const manager = Reflect.get(globalThis, MANAGER_SYMBOL) as {
      getRecord(id: string): { outputFile?: string; metadata?: Readonly<Record<string, unknown>> } | undefined;
    };
    const sharedRecord = manager.getRecord(spawn.agentId);
    const transcriptPath = join(transcriptDirectory, `${spawn.agentId}.jsonl`);
    expect(sharedRecord?.outputFile).toBe(transcriptPath);
    expect(sharedRecord?.metadata).toBe(metadata);
    expect(readFileSync(transcriptPath, "utf-8").trim().split("\n")).toHaveLength(2);

    for (const event of ["subagents:created", "subagents:started", "subagents:completed"]) {
      const payloads = emitted(harness, event) as Array<{ metadata?: unknown }>;
      expect(payloads).toHaveLength(1);
      expect(payloads[0].metadata).toBe(metadata);
    }
    expect(harness.pi.appendEntry).not.toHaveBeenCalled();
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("normalizes worktree completion data from the shared manager", async () => {
    immediateRun([], []);
    const { host } = await activate();

    const spawn = host.spawn(request({ isolation: "worktree" }));
    const completion = await spawn.completion;

    expect(completion).toMatchObject({
      agentId: spawn.agentId,
      status: "completed",
      usage: { input: 4, output: 5, cacheWrite: 6 },
      worktree: { hasChanges: true, branch: "pi-agent-managed" },
    });
    expect(completion.text).toContain("Changes saved to branch `pi-agent-managed`");
    expect(host.get(spawn.agentId)).toMatchObject({
      worktree: { hasChanges: true, branch: "pi-agent-managed" },
    });
  });

  it("uses the exact same explicit type/frontmatter/model policy as the Agent tool", async () => {
    mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "agents", "Reviewer.md"), `---
description: policy reviewer
model: test/pinned
thinking: high
max_turns: 7
isolated: true
inherit_context: true
---
Review carefully.
`);
    const captured: RunOptions[] = [];
    immediateRun(captured, []);
    const { harness, host, ctx } = await activate();

    await tool(harness, "Agent").execute(
      "tool-call",
      {
        prompt: "review",
        description: "tool reviewer",
        subagent_type: "reviewer",
        model: "test/requested",
        thinking: "low",
        max_turns: 2,
      } as never,
      undefined,
      undefined,
      ctx as never,
    );
    const managed = host.spawn(request({
      agentType: "reviewer",
      model: "test/requested",
      thinking: "low",
      maxTurns: 2,
    }));
    await managed.completion;

    expect(captured).toHaveLength(2);
    for (const options of captured) {
      expect(options).toMatchObject({
        model: MODELS[1],
        maxTurns: 7,
        thinkingLevel: "high",
        isolated: true,
        inheritContext: true,
      });
    }
  });

  it("applies the same model-scope rejection to Agent and host requests", async () => {
    writeFileSync(
      join(projectDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, scopeModels: true }),
    );
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["test/parent"] }),
    );
    immediateRun([], []);
    const { harness, host, ctx } = await activate();

    const toolResult = await tool(harness, "Agent").execute(
      "tool-call",
      {
        prompt: "review",
        description: "scope test",
        subagent_type: "general-purpose",
        model: "test/requested",
      } as never,
      undefined,
      undefined,
      ctx as never,
    );
    expect(toolResult.content[0].text).toContain("Model not in scope");
    expect(() => host.spawn(request({ model: "test/requested" }))).toThrow("Model not in scope");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("keeps the embedded default independent from a project override and disabled defaults", async () => {
    mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(projectDir, ".pi", "agents", "general-purpose.md"), `---
description: overridden default
model: test/pinned
thinking: high
max_turns: 99
---
Project override.
`);
    writeFileSync(
      join(projectDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, disableDefaultAgents: true }),
    );
    const captured: RunOptions[] = [];
    immediateRun(captured, []);
    const { host } = await activate();

    const embedded = host.spawn({
      ...request({ agentType: undefined } as never),
      baseConfig: { source: "embedded", name: "general-purpose" },
      model: "test/requested",
      thinking: "low",
      maxTurns: 3,
    });
    const explicit = host.spawn(request({
      agentType: "general-purpose",
      model: "test/requested",
      thinking: "low",
      maxTurns: 3,
    }));
    await Promise.all([embedded.completion, explicit.completion]);

    expect(captured[0]).toMatchObject({
      model: MODELS[2],
      thinkingLevel: "low",
      maxTurns: 3,
      agentConfigOverride: {
        name: "general-purpose",
        displayName: "Agent",
        systemPrompt: "",
        promptMode: "append",
      },
    });
    expect(captured[1]).toMatchObject({
      model: MODELS[1],
      thinkingLevel: "high",
      maxTurns: 99,
    });
    expect(captured[1].agentConfigOverride).toBeUndefined();
  });

  it("supports shared steering, idempotent stop/get/waitForAll, and one metadata-bearing terminal event", async () => {
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const { session } = createSession();
      await options.configureSession?.(session as never);
      options.onSessionCreated?.(session as never);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        responseText: "partial",
        session,
        aborted: false,
        steered: false,
      } as unknown as RunResult;
    });
    const { harness, host, ctx } = await activate();
    const metadata = Object.freeze({ workflowRunId: "run-stop", callKey: "call-stop" });
    const spawn = host.spawn(request({ metadata }));
    await flush();

    expect(host.get(spawn.agentId)).toMatchObject({ status: "running", metadata });
    const steerResult = await tool(harness, "steer_subagent").execute(
      "steer-call",
      { agent_id: spawn.agentId, message: "change direction" } as never,
      undefined,
      undefined,
      ctx as never,
    );
    expect(steerResult.content[0].text).toContain("Steering message sent");
    const steerEvents = emitted(harness, "subagents:steered") as Array<{ metadata?: unknown }>;
    expect(steerEvents).toHaveLength(1);
    expect(steerEvents[0].metadata).toBe(metadata);

    expect(host.stop(spawn.agentId)).toBe(true);
    expect(host.stop(spawn.agentId)).toBe(false);
    await expect(spawn.completion).resolves.toMatchObject({
      agentId: spawn.agentId,
      status: "stopped",
      text: null,
    });
    await Promise.all([host.waitForAll(), host.waitForAll()]);
    await flush();

    expect(host.get(spawn.agentId)).toMatchObject({ status: "stopped", metadata });
    expect(host.get("missing")).toBeUndefined();
    const failedEvents = emitted(harness, "subagents:failed") as Array<{ metadata?: unknown; status?: string }>;
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({ metadata, status: "stopped" });
  });

  it("waitForAll snapshots every active managed completion and is safely repeatable", async () => {
    const releases: Array<() => void> = [];
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      const { session } = createSession();
      await options.configureSession?.(session as never);
      options.onSessionCreated?.(session as never);
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        responseText: "done",
        session,
        aborted: false,
        steered: false,
      } as unknown as RunResult;
    });
    const { host } = await activate();
    host.spawn(request({ description: "first" }));
    host.spawn(request({ description: "second" }));
    await flush();
    expect(releases).toHaveLength(2);
    let settled = false;
    const waiter = host.waitForAll().then(() => {
      settled = true;
    });

    releases[1]();
    await flush();
    expect(settled).toBe(false);
    releases[0]();
    await waiter;
    await expect(host.waitForAll()).resolves.toBeUndefined();
  });

  it("delegates group providers to AgentWidget with an idempotent disposer", async () => {
    immediateRun([], []);
    const { harness, host, ctx } = await activate();
    const unregister = host.registerGroupProvider(() => [{
      id: "workflow:run-1",
      title: "Managed workflow",
      narrator: "reviewing",
      agentIds: [],
      children: [{ id: "phase:review", title: "Review", agentIds: [] }],
    }]);

    await fireLifecycle(harness, "tool_execution_start", ctx);
    const registration = ctx.ui.setWidget.mock.calls.find(
      ([key, content]) => key === "agents" && typeof content === "function",
    );
    expect(registration).toBeDefined();
    const factory = registration?.[1] as (
      tui: { terminal: { columns: number }; requestRender(): void },
      theme: { fg(color: string, text: string): string; bold(text: string): string },
    ) => { render(): string[] };
    const component = factory(
      { terminal: { columns: 120 }, requestRender: () => undefined },
      { fg: (_color, text) => text, bold: (text) => text },
    );
    expect(component.render().join("\n")).toContain("Managed workflow");
    expect(component.render().join("\n")).toContain("Review");

    unregister();
    unregister();
    expect(component.render()).toEqual([]);
  });

  it("suppresses notification and parent bookkeeping independently", async () => {
    immediateRun([], []);
    const { harness, host } = await activate();

    await host.spawn(request({ parentBookkeeping: "record" })).completion;
    expect(harness.pi.appendEntry).toHaveBeenCalledTimes(1);
    expect(harness.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the first root host across child activation and releases it only with the owner", async () => {
    immediateRun([], []);
    const root = await activate();
    const rootHost = root.host;

    const childHarness = makePi() as ExtensionHarness;
    activations.push(childHarness);
    subagentsExtension(childHarness.pi as never);
    await fireLifecycle(childHarness, "session_start", createContext(projectDir));
    expect(Reflect.get(globalThis, SUBAGENT_HOST_SYMBOL)).toBe(rootHost);

    await fireLifecycle(childHarness, "session_shutdown", createContext(projectDir));
    activations.splice(activations.indexOf(childHarness), 1);
    expect(Reflect.get(globalThis, SUBAGENT_HOST_SYMBOL)).toBe(rootHost);

    await fireLifecycle(root.harness, "session_shutdown", createContext(projectDir));
    activations.splice(activations.indexOf(root.harness), 1);
    expect(Reflect.get(globalThis, SUBAGENT_HOST_SYMBOL)).toBeUndefined();
  });
});
