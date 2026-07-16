/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Persist this subagent as a normal pi session instead of keeping it in memory only. */
  persistSession?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export type JoinMode = 'async' | 'group' | 'smart';

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   Agent tool result, #118); show background/queued/scheduled/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'background' | 'off';

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  groupId?: string;
  joinMode?: JoinMode;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: { path: string; branch: string; baseSha: string; workPath: string };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /**
   * Whether this agent was spawned to run in the background. Tri-state, set at
   * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
   * foreground (has an inline Agent tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface). The widget's background-only filter keys off this
   * — and excludes only explicit `false`, so `undefined` agents stay visible.
   * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
   * which only the Agent-tool path populates.
   */
  isBackground?: boolean;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** External controllers bypass this package's background queue/accounting. */
  queuePolicy?: "external";
  /** Suppress the per-agent follow-up without changing lifecycle events. */
  suppressNotification?: boolean;
  /** Suppress the parent session's durable `subagents:record` entry. */
  suppressParentRecord?: boolean;
  /** Opaque controller data copied by reference onto lifecycle events. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
  id: string;
  /** Unique within store. Defaults to `description`. */
  name: string;
  description: string;
  /** Raw user input — cron expr | "+10m" | ISO | "5m". */
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  /** Computed at create time for interval/once. */
  intervalMs?: number;

  // spawn params (subset of Agent tool params; no inherit_context, no resume)
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;

  // state
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  /** Refreshed on every fire and on store load. */
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  /** For future migrations. */
  version: 1;
  jobs: ScheduledSubagent[];
}

// ---- Versioned same-process host contract ----

export type ManagedThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ManagedAgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";
export type ManagedAgentTerminalStatus = Extract<ManagedAgentStatus, "completed" | "failed" | "stopped">;

export interface ManagedAgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
}

export interface ManagedWorktreeResult {
  readonly hasChanges: boolean;
  readonly branch?: string;
}

export interface ManagedAgentActivity {
  readonly type: "start" | "end";
  readonly toolName: string;
}

export interface ManagedAgentTurn {
  readonly turnCount: number;
}

export interface ManagedAgentCompaction {
  readonly reason: "manual" | "threshold" | "overflow";
  readonly tokensBefore: number;
}

export interface EmbeddedBaseConfig {
  readonly source: "embedded";
  readonly name: "general-purpose";
}

export interface ManagedSpawnRequestBase {
  readonly prompt: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: ManagedThinkingLevel;
  readonly maxTurns?: number;
  readonly isolation?: "worktree";
  readonly cwd?: string;
  readonly queue: "external";
  readonly notification: "suppress";
  /** Defaults to `suppress` when notification is suppressed. */
  readonly parentBookkeeping?: "record" | "suppress";
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly excludeExtensions: readonly string[];
  /** Existing directory; the host writes `<transcriptDirectory>/<agentId>.jsonl`. */
  readonly transcriptDirectory?: string;
  readonly groupId?: string;
}

export type ManagedSpawnRequest = ManagedSpawnRequestBase &
  (
    | { readonly agentType: string; readonly baseConfig?: never }
    | { readonly agentType?: never; readonly baseConfig: EmbeddedBaseConfig }
  );

export interface ManagedChildTool {
  readonly name: string;
}

export type ManagedChildStreamFn = (...args: never[]) => unknown;

/** Supported mutable child surface passed after extension binding and before the first prompt. */
export interface ManagedChildSession {
  readonly agent: {
    readonly state: {
      tools: ManagedChildTool[];
      systemPrompt: string;
    };
    streamFn: ManagedChildStreamFn;
  };
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface ManagedSpawnHooks {
  readonly configureSession?: (session: ManagedChildSession) => void | Promise<void>;
  readonly onActivity?: (activity: ManagedAgentActivity) => void | Promise<void>;
  readonly onTurn?: (turn: ManagedAgentTurn) => void | Promise<void>;
  readonly onCompaction?: (compaction: ManagedAgentCompaction) => void | Promise<void>;
  readonly onUsage?: (usage: ManagedAgentUsage) => void | Promise<void>;
}

export interface ManagedAgentCompletion {
  readonly agentId: string;
  readonly status: ManagedAgentTerminalStatus;
  readonly text: string | null;
  readonly usage: ManagedAgentUsage;
  readonly error?: string;
  readonly worktree?: ManagedWorktreeResult;
}

export interface ManagedSpawn {
  readonly agentId: string;
  readonly completion: Promise<ManagedAgentCompletion>;
}

export interface ManagedAgentSnapshot {
  readonly agentId: string;
  readonly description: string;
  readonly status: ManagedAgentStatus;
  readonly usage: ManagedAgentUsage;
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly activity?: ManagedAgentActivity;
  readonly error?: string;
  readonly worktree?: ManagedWorktreeResult;
}

export interface AgentGroupView {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly narrator?: string;
  readonly agentIds: readonly string[];
  readonly children?: readonly AgentGroupView[];
}

export type AgentGroupProvider = () => readonly AgentGroupView[];

export interface SubagentHostV1 {
  readonly version: 1;
  spawn(request: ManagedSpawnRequest, hooks?: ManagedSpawnHooks): ManagedSpawn;
  stop(agentId: string): boolean;
  get(agentId: string): ManagedAgentSnapshot | undefined;
  waitForAll(): Promise<void>;
  registerGroupProvider(provider: AgentGroupProvider): () => void;
}
