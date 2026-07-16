import type {
  SubagentHostV1 as PackageSubagentHostV1,
} from "../../src/index.js";

// Type-only copy of pi-workflows' runtime-independent structural mirror. The
// fixture deliberately has no package dependency in either direction.
type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type WorkflowAgentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

interface WorkflowUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
}

interface WorkflowActivity {
  readonly type: "start" | "end";
  readonly toolName: string;
}

interface WorkflowChildTool {
  readonly name: string;
}

type WorkflowStreamFn = (...args: never[]) => unknown;

interface WorkflowChildSession {
  readonly agent: {
    readonly state: {
      tools: WorkflowChildTool[];
      systemPrompt: string;
    };
    streamFn: WorkflowStreamFn;
  };
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
}

interface WorkflowSpawnBase {
  readonly prompt: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: WorkflowThinkingLevel;
  readonly maxTurns?: number;
  readonly isolation?: "worktree";
  readonly cwd?: string;
  readonly queue: "external";
  readonly notification: "suppress";
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly excludeExtensions: readonly string[];
  readonly transcriptDirectory?: string;
  readonly groupId?: string;
}

type WorkflowSpawnRequest = WorkflowSpawnBase & (
  | { readonly agentType: string; readonly baseConfig?: never }
  | {
      readonly agentType?: never;
      readonly baseConfig: { readonly source: "embedded"; readonly name: "general-purpose" };
    }
);

interface WorkflowHooks {
  readonly configureSession?: (session: WorkflowChildSession) => void | Promise<void>;
  readonly onActivity?: (activity: WorkflowActivity) => void | Promise<void>;
  readonly onTurn?: (turn: { readonly turnCount: number }) => void | Promise<void>;
  readonly onCompaction?: (compaction: {
    readonly reason: "manual" | "threshold" | "overflow";
    readonly tokensBefore: number;
  }) => void | Promise<void>;
  readonly onUsage?: (usage: WorkflowUsage) => void | Promise<void>;
}

interface WorkflowGroupView {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly narrator?: string;
  readonly agentIds: readonly string[];
  readonly children?: readonly WorkflowGroupView[];
}

interface WorkflowSubagentHostV1 {
  readonly version: 1;
  spawn(request: WorkflowSpawnRequest, hooks?: WorkflowHooks): {
    readonly agentId: string;
    readonly completion: Promise<{
      readonly agentId: string;
      readonly status: "completed" | "failed" | "stopped";
      readonly text: string | null;
      readonly usage: WorkflowUsage;
      readonly error?: string;
      readonly worktree?: { readonly hasChanges: boolean; readonly branch?: string };
    }>;
  };
  stop(agentId: string): boolean;
  get(agentId: string): {
    readonly agentId: string;
    readonly description: string;
    readonly status: WorkflowAgentStatus;
    readonly usage: WorkflowUsage;
    readonly turnCount: number;
    readonly compactionCount: number;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly startedAt: number;
    readonly completedAt?: number;
    readonly activity?: WorkflowActivity;
    readonly error?: string;
    readonly worktree?: { readonly hasChanges: boolean; readonly branch?: string };
  } | undefined;
  waitForAll(): Promise<void>;
  registerGroupProvider(provider: () => readonly WorkflowGroupView[]): () => void;
}

declare const packageHost: PackageSubagentHostV1;
const workflowsHost: WorkflowSubagentHostV1 = packageHost;
void workflowsHost;
