import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolActivity } from "./agent-runner.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import type { LifetimeUsage } from "./usage.js";
import { addUsage } from "./usage.js";

export interface AgentActivityCallbacks {
  onToolActivity(activity: ToolActivity): void;
  onTextDelta(delta: string, fullText: string): void;
  onTurnEnd(turnCount: number): void;
  onSessionCreated(session: AgentSession): void;
  onAssistantUsage(usage: LifetimeUsage): void;
}

/** Shared live-activity tracking used by Agent-tool and managed-host spawns. */
export function createActivityTracker(
  maxTurns?: number,
  onStreamUpdate?: () => void,
): { state: AgentActivity; callbacks: AgentActivityCallbacks } {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks: AgentActivityCallbacks = {
    onToolActivity: (activity) => {
      if (activity.type === "start") {
        state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) {
            state.activeTools.delete(key);
            break;
          }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta, fullText) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session) => {
      state.session = session;
    },
    onAssistantUsage: (usage) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}
