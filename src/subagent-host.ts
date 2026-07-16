import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createActivityTracker } from "./agent-activity.js";
import type { AgentManager } from "./agent-manager.js";
import { resolveAgentInvocationPolicy } from "./invocation-policy.js";
import { streamToOutputFile, writeInitialEntry } from "./output-file.js";
import type {
  AgentGroupProvider,
  AgentRecord,
  ManagedAgentActivity,
  ManagedAgentCompletion,
  ManagedAgentSnapshot,
  ManagedAgentStatus,
  ManagedAgentTerminalStatus,
  ManagedAgentUsage,
  ManagedChildSession,
  ManagedSpawn,
  ManagedSpawnHooks,
  ManagedSpawnRequest,
  SubagentHostV1,
} from "./types.js";
import type { AgentActivity } from "./ui/agent-widget.js";

export const SUBAGENT_HOST_SYMBOL = Symbol.for("pi-subagents:host");
export const SUBAGENT_HOST_VERSION = 1 as const;

interface DeferredStop {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

interface HostAgentState {
  turnCount: number;
  activity?: ManagedAgentActivity;
}

interface ActiveManagedAgent {
  readonly completion: Promise<ManagedAgentCompletion>;
  readonly stop: DeferredStop;
}

export interface SubagentHostDependencies {
  readonly pi: ExtensionAPI;
  readonly manager: AgentManager;
  readonly getContext: () => ExtensionContext | undefined;
  readonly reloadAgents: () => void;
  readonly scopeModels: () => boolean;
  readonly defaultMaxTurns: () => number | undefined;
  readonly onAgentTracked: (agentId: string, activity: AgentActivity) => void;
  readonly registerGroupProvider: (provider: AgentGroupProvider) => () => void;
}

function createStopDeferred(): DeferredStop {
  let settled = false;
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise?.();
    },
  };
}

function assertTranscriptDirectory(directory: string | undefined): void {
  if (directory === undefined) return;
  let isDirectory = false;
  try {
    isDirectory = statSync(directory).isDirectory();
  } catch {
    throw new Error(`Managed transcriptDirectory does not exist: "${directory}"`);
  }
  if (!isDirectory) throw new Error(`Managed transcriptDirectory is not a directory: "${directory}"`);
}

function usageOf(record: AgentRecord): ManagedAgentUsage {
  return {
    input: record.lifetimeUsage.input,
    output: record.lifetimeUsage.output,
    cacheWrite: record.lifetimeUsage.cacheWrite,
  };
}

function statusOf(record: AgentRecord): ManagedAgentStatus {
  switch (record.status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
    case "steered":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return "failed";
  }
}

function terminalStatusOf(record: AgentRecord): ManagedAgentTerminalStatus {
  const status = statusOf(record);
  if (status === "completed" || status === "stopped") return status;
  return "failed";
}

function completionOf(record: AgentRecord, forcedStatus?: "stopped"): ManagedAgentCompletion {
  const status = forcedStatus ?? terminalStatusOf(record);
  const base = {
    agentId: record.id,
    status,
    text: status === "completed" ? record.result ?? "" : null,
    usage: usageOf(record),
  } as const;
  return {
    ...base,
    ...(status === "failed" ? { error: record.error ?? "Agent failed" } : {}),
    ...(record.worktreeResult === undefined ? {} : { worktree: { ...record.worktreeResult } }),
  };
}

/** Root-owned implementation of the version-one same-process host contract. */
export class ManagedSubagentHost implements SubagentHostV1 {
  readonly version = SUBAGENT_HOST_VERSION;

  private readonly active = new Map<string, ActiveManagedAgent>();
  private readonly ownedAgentIds = new Set<string>();
  private readonly state = new Map<string, HostAgentState>();
  private readonly groupDisposers = new Set<() => void>();
  private disposed = false;

  constructor(private readonly dependencies: SubagentHostDependencies) {}

  spawn(request: ManagedSpawnRequest, hooks: ManagedSpawnHooks = {}): ManagedSpawn {
    if (this.disposed) throw new Error("The pi-subagents host has been disposed.");
    if (request.queue !== "external") throw new Error('SubagentHostV1 requires queue: "external".');
    assertTranscriptDirectory(request.transcriptDirectory);

    const ctx = this.dependencies.getContext();
    if (!ctx) throw new Error("No active root pi-subagents session.");
    this.dependencies.reloadAgents();

    const selector = "agentType" in request && request.agentType !== undefined
      ? { kind: "registry" as const, agentType: request.agentType }
      : { kind: "embedded-general-purpose" as const };
    const policy = resolveAgentInvocationPolicy({
      selector,
      params: {
        model: request.model,
        thinking: request.thinking,
        max_turns: request.maxTurns,
        run_in_background: true,
        inherit_context: false,
        isolation: request.isolation,
      },
      ctx,
      scopeModels: this.dependencies.scopeModels(),
      defaultMaxTurns: this.dependencies.defaultMaxTurns(),
    });
    if (!policy.ok) throw new Error(policy.error);
    if (policy.warning) ctx.ui.notify(policy.warning, "warning");

    const hostState: HostAgentState = { turnCount: 0 };
    const { state: activityState, callbacks: activityCallbacks } = createActivityTracker(policy.effectiveMaxTurns);
    let hookQueue = Promise.resolve();
    const enqueueHook = (hook: (() => void | Promise<void>) | undefined): void => {
      if (!hook) return;
      hookQueue = hookQueue.then(hook, hook).catch(() => undefined);
    };
    let recordAtCreation: AgentRecord | undefined;

    const suppressNotification = request.notification === "suppress";
    const suppressParentRecord = request.parentBookkeeping === undefined
      ? suppressNotification
      : request.parentBookkeeping === "suppress";

    const agentId = this.dependencies.manager.spawn(
      this.dependencies.pi,
      ctx,
      policy.subagentType,
      request.prompt,
      {
        description: request.description,
        model: policy.model,
        maxTurns: policy.effectiveMaxTurns,
        isolated: policy.resolvedConfig.isolated,
        inheritContext: policy.resolvedConfig.inheritContext,
        thinkingLevel: policy.resolvedConfig.thinking,
        isBackground: true,
        queuePolicy: "external",
        isolation: policy.resolvedConfig.isolation,
        cwd: request.cwd,
        invocation: policy.invocation,
        agentConfigOverride: policy.agentConfigOverride,
        controllerExtensionDenylist: request.excludeExtensions,
        groupId: request.groupId,
        suppressNotification,
        suppressParentRecord,
        metadata: request.metadata,
        configureSession: async (session) => {
          await hooks.configureSession?.(session as unknown as ManagedChildSession);
        },
        onCreated: (record) => {
          recordAtCreation = record;
          if (request.transcriptDirectory) {
            record.outputFile = join(request.transcriptDirectory, `${record.id}.jsonl`);
            writeInitialEntry(record.outputFile, record.id, request.prompt, ctx.cwd);
          }
        },
        onToolActivity: (activity) => {
          activityCallbacks.onToolActivity(activity);
          hostState.activity = activity;
          enqueueHook(hooks.onActivity ? () => hooks.onActivity?.(activity) : undefined);
        },
        onTextDelta: activityCallbacks.onTextDelta,
        onTurnEnd: (turnCount) => {
          activityCallbacks.onTurnEnd(turnCount);
          hostState.turnCount = turnCount;
          enqueueHook(hooks.onTurn ? () => hooks.onTurn?.({ turnCount }) : undefined);
        },
        onAssistantUsage: (usage) => {
          activityCallbacks.onAssistantUsage(usage);
          enqueueHook(hooks.onUsage ? () => hooks.onUsage?.(usage) : undefined);
        },
        onCompaction: (compaction) => {
          enqueueHook(hooks.onCompaction ? () => hooks.onCompaction?.(compaction) : undefined);
        },
        onSessionCreated: (session) => {
          activityCallbacks.onSessionCreated(session);
          if (recordAtCreation?.outputFile) {
            recordAtCreation.outputCleanup = streamToOutputFile(
              session,
              recordAtCreation.outputFile,
              recordAtCreation.id,
              ctx.cwd,
            );
          }
        },
      },
    );

    const record = this.dependencies.manager.getRecord(agentId);
    if (!record?.promise) {
      this.dependencies.manager.abort(agentId);
      throw new Error(`Managed agent ${agentId} did not start.`);
    }

    this.ownedAgentIds.add(agentId);
    this.state.set(agentId, hostState);
    const stop = createStopDeferred();
    const runCompletion = record.promise.then(async () => {
      await hookQueue;
      return completionOf(record);
    });
    const stoppedCompletion = stop.promise.then(() => completionOf(record, "stopped"));
    const completion = Promise.race([runCompletion, stoppedCompletion]);
    this.active.set(agentId, { completion, stop });
    void completion.then(
      () => this.active.delete(agentId),
      () => this.active.delete(agentId),
    );

    this.dependencies.onAgentTracked(agentId, activityState);
    this.dependencies.pi.events.emit("subagents:created", {
      id: agentId,
      type: policy.subagentType,
      description: request.description,
      isBackground: true,
      metadata: request.metadata,
    });

    return { agentId, completion };
  }

  stop(agentId: string): boolean {
    const active = this.active.get(agentId);
    if (!active || !this.dependencies.manager.abort(agentId)) return false;
    active.stop.resolve();
    return true;
  }

  get(agentId: string): ManagedAgentSnapshot | undefined {
    if (!this.ownedAgentIds.has(agentId)) return undefined;
    const record = this.dependencies.manager.getRecord(agentId);
    if (!record) return undefined;
    const state = this.state.get(agentId);
    const status = statusOf(record);
    return {
      agentId,
      description: record.description,
      status,
      usage: usageOf(record),
      turnCount: state?.turnCount ?? 0,
      compactionCount: record.compactionCount,
      metadata: record.metadata ?? {},
      startedAt: record.startedAt,
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(state?.activity === undefined ? {} : { activity: state.activity }),
      ...(status !== "failed" || record.error === undefined ? {} : { error: record.error }),
      ...(record.worktreeResult === undefined ? {} : { worktree: { ...record.worktreeResult } }),
    };
  }

  async waitForAll(): Promise<void> {
    await Promise.all([...this.active.values()].map(({ completion }) => completion));
  }

  registerGroupProvider(provider: AgentGroupProvider): () => void {
    if (this.disposed) return () => undefined;
    const unregister = this.dependencies.registerGroupProvider(provider);
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      this.groupDisposers.delete(dispose);
      unregister();
    };
    this.groupDisposers.add(dispose);
    return dispose;
  }

  /** Root activation cleanup; intentionally outside the public V1 interface. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const agentId of [...this.active.keys()]) this.stop(agentId);
    for (const unregister of [...this.groupDisposers]) unregister();
  }
}
