import type { AgentEvent, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  AgentGroupProvider as PackageAgentGroupProvider,
  AgentGroupView as PackageAgentGroupView,
  EmbeddedBaseConfig as PackageEmbeddedBaseConfig,
  ManagedAgentActivity as PackageManagedAgentActivity,
  ManagedAgentCompaction as PackageManagedAgentCompaction,
  ManagedAgentCompletion as PackageManagedAgentCompletion,
  ManagedAgentSnapshot as PackageManagedAgentSnapshot,
  ManagedAgentStatus as PackageManagedAgentStatus,
  ManagedAgentTerminalStatus as PackageManagedAgentTerminalStatus,
  ManagedAgentTurn as PackageManagedAgentTurn,
  ManagedAgentUsage as PackageManagedAgentUsage,
  ManagedChildAgentEventListener as PackageManagedChildAgentEventListener,
  ManagedChildBeforeToolCall as PackageManagedChildBeforeToolCall,
  ManagedChildModel as PackageManagedChildModel,
  ManagedChildSession as PackageManagedChildSession,
  ManagedChildStream as PackageManagedChildStream,
  ManagedChildStreamContext as PackageManagedChildStreamContext,
  ManagedChildStreamFn as PackageManagedChildStreamFn,
  ManagedChildStreamOptions as PackageManagedChildStreamOptions,
  ManagedChildStreamResult as PackageManagedChildStreamResult,
  ManagedChildTool as PackageManagedChildTool,
  ManagedSpawn as PackageManagedSpawn,
  ManagedSpawnHooks as PackageManagedSpawnHooks,
  ManagedSpawnRequest as PackageManagedSpawnRequest,
  ManagedSpawnRequestBase as PackageManagedSpawnRequestBase,
  ManagedThinkingLevel as PackageManagedThinkingLevel,
  ManagedWorktreeResult as PackageManagedWorktreeResult,
  SubagentHostV1 as PackageSubagentHostV1,
} from "../../src/index.js";

// Copy-synced from pi-workflows/src/subagents/host.ts. Keep this fixture
// runtime-independent: the packages discover each other structurally.
type ConsumerManagedThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ConsumerManagedAgentStatus = "queued" | "running" | "completed" | "failed" | "skipped" | "stopped";
type ConsumerManagedAgentTerminalStatus = Extract<
  ConsumerManagedAgentStatus,
  "completed" | "failed" | "skipped" | "stopped"
>;

interface ConsumerManagedAgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
}

interface ConsumerManagedWorktreeResult {
  readonly hasChanges: boolean;
  readonly branch?: string;
}

interface ConsumerManagedAgentActivity {
  readonly type: "start" | "end";
  readonly toolName: string;
}

interface ConsumerManagedAgentTurn {
  readonly turnCount: number;
}

interface ConsumerManagedAgentCompaction {
  readonly reason: "manual" | "threshold" | "overflow";
  readonly tokensBefore: number;
}

interface ConsumerEmbeddedBaseConfig {
  readonly source: "embedded";
  readonly name: "general-purpose";
}

interface ConsumerManagedSpawnRequestBase {
  readonly prompt: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: ConsumerManagedThinkingLevel;
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

type ConsumerManagedSpawnRequest = ConsumerManagedSpawnRequestBase &
  (
    | { readonly agentType: string; readonly baseConfig?: never }
    | { readonly agentType?: never; readonly baseConfig: ConsumerEmbeddedBaseConfig }
  );

interface ConsumerManagedChildTool {
  readonly name: string;
}

type ConsumerManagedChildAgentEventListener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;

type ConsumerManagedChildBeforeToolCall = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

type ConsumerManagedChildModel = Model<Api>;
type ConsumerManagedChildStreamContext = Context;
type ConsumerManagedChildStreamOptions = SimpleStreamOptions;

interface ConsumerManagedChildStreamResult {
  readonly usage: {
    readonly output: number;
  };
}

interface ConsumerManagedChildStream extends AsyncIterable<unknown> {
  result(): Promise<ConsumerManagedChildStreamResult>;
}

type ConsumerManagedChildStreamFn = (
  model: ConsumerManagedChildModel,
  context: ConsumerManagedChildStreamContext,
  options?: ConsumerManagedChildStreamOptions,
) => ConsumerManagedChildStream | Promise<ConsumerManagedChildStream>;

interface ConsumerManagedChildSession {
  readonly agent: {
    readonly state: {
      tools: ConsumerManagedChildTool[];
      systemPrompt: string;
    };
    streamFn: ConsumerManagedChildStreamFn;
    beforeToolCall?: ConsumerManagedChildBeforeToolCall;
    subscribe(listener: ConsumerManagedChildAgentEventListener): () => void;
  };
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
}

interface ConsumerManagedSpawnHooks {
  readonly configureSession?: (session: ConsumerManagedChildSession) => void | Promise<void>;
  readonly onActivity?: (activity: ConsumerManagedAgentActivity) => void | Promise<void>;
  readonly onTurn?: (turn: ConsumerManagedAgentTurn) => void | Promise<void>;
  readonly onCompaction?: (compaction: ConsumerManagedAgentCompaction) => void | Promise<void>;
  readonly onUsage?: (usage: ConsumerManagedAgentUsage) => void | Promise<void>;
}

interface ConsumerManagedAgentCompletionBase {
  readonly agentId: string;
  readonly usage: ConsumerManagedAgentUsage;
  readonly worktree?: ConsumerManagedWorktreeResult;
}

type ConsumerManagedAgentCompletion = ConsumerManagedAgentCompletionBase &
  (
    | {
        readonly status: "completed";
        readonly text: string;
        readonly error?: never;
      }
    | {
        readonly status: "failed";
        readonly text: null;
        readonly error: string;
      }
    | {
        readonly status: "skipped" | "stopped";
        readonly text: null;
        readonly error?: string;
      }
  );

interface ConsumerManagedSpawn {
  readonly agentId: string;
  readonly completion: Promise<ConsumerManagedAgentCompletion>;
}

interface ConsumerManagedAgentSnapshot {
  readonly agentId: string;
  readonly description: string;
  readonly status: ConsumerManagedAgentStatus;
  readonly usage: ConsumerManagedAgentUsage;
  readonly turnCount: number;
  readonly compactionCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly activity?: ConsumerManagedAgentActivity;
  readonly error?: string;
  readonly worktree?: ConsumerManagedWorktreeResult;
}

interface ConsumerAgentGroupView {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly narrator?: string;
  readonly agentIds: readonly string[];
  readonly children?: readonly ConsumerAgentGroupView[];
}

type ConsumerAgentGroupProvider = () => readonly ConsumerAgentGroupView[];

interface ConsumerSubagentHostV1 {
  readonly version: 1;
  spawn(request: ConsumerManagedSpawnRequest, hooks?: ConsumerManagedSpawnHooks): ConsumerManagedSpawn;
  stop(agentId: string): boolean;
  get(agentId: string): ConsumerManagedAgentSnapshot | undefined;
  waitForAll(): Promise<void>;
  registerGroupProvider(provider: ConsumerAgentGroupProvider): () => void;
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;

type ContractAssertions = [
  Assert<Equal<PackageManagedThinkingLevel, ConsumerManagedThinkingLevel>>,
  Assert<Equal<PackageManagedAgentStatus, ConsumerManagedAgentStatus>>,
  Assert<Equal<PackageManagedAgentTerminalStatus, ConsumerManagedAgentTerminalStatus>>,
  Assert<Equal<PackageManagedAgentUsage, ConsumerManagedAgentUsage>>,
  Assert<Equal<PackageManagedWorktreeResult, ConsumerManagedWorktreeResult>>,
  Assert<Equal<PackageManagedAgentActivity, ConsumerManagedAgentActivity>>,
  Assert<Equal<PackageManagedAgentTurn, ConsumerManagedAgentTurn>>,
  Assert<Equal<PackageManagedAgentCompaction, ConsumerManagedAgentCompaction>>,
  Assert<Equal<PackageEmbeddedBaseConfig, ConsumerEmbeddedBaseConfig>>,
  Assert<Equal<PackageManagedSpawnRequestBase, ConsumerManagedSpawnRequestBase>>,
  Assert<Equal<PackageManagedSpawnRequest, ConsumerManagedSpawnRequest>>,
  Assert<Equal<PackageManagedChildTool, ConsumerManagedChildTool>>,
  Assert<Equal<PackageManagedChildAgentEventListener, ConsumerManagedChildAgentEventListener>>,
  Assert<Equal<PackageManagedChildBeforeToolCall, ConsumerManagedChildBeforeToolCall>>,
  Assert<Equal<PackageManagedChildModel, ConsumerManagedChildModel>>,
  Assert<Equal<PackageManagedChildStreamContext, ConsumerManagedChildStreamContext>>,
  Assert<Equal<PackageManagedChildStreamOptions, ConsumerManagedChildStreamOptions>>,
  Assert<Equal<PackageManagedChildStreamResult, ConsumerManagedChildStreamResult>>,
  Assert<Equal<PackageManagedChildStream, ConsumerManagedChildStream>>,
  Assert<Equal<PackageManagedChildStreamFn, ConsumerManagedChildStreamFn>>,
  Assert<Equal<PackageManagedChildSession, ConsumerManagedChildSession>>,
  Assert<Equal<PackageManagedSpawnHooks, ConsumerManagedSpawnHooks>>,
  Assert<Equal<PackageManagedAgentCompletion, ConsumerManagedAgentCompletion>>,
  Assert<Equal<PackageManagedSpawn, ConsumerManagedSpawn>>,
  Assert<Equal<PackageManagedAgentSnapshot, ConsumerManagedAgentSnapshot>>,
  Assert<Equal<PackageAgentGroupView, ConsumerAgentGroupView>>,
  Assert<Equal<PackageAgentGroupProvider, ConsumerAgentGroupProvider>>,
  Assert<Equal<PackageSubagentHostV1, ConsumerSubagentHostV1>>,
];

declare const packageHost: PackageSubagentHostV1;
declare const consumerHost: ConsumerSubagentHostV1;
const consumerFromPackage: ConsumerSubagentHostV1 = packageHost;
const packageFromConsumer: PackageSubagentHostV1 = consumerHost;
declare const contractAssertions: ContractAssertions;
void consumerFromPackage;
void packageFromConsumer;
void contractAssertions;
