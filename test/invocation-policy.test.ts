import { afterEach, describe, expect, it } from "vitest";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { resolveAgentInvocationPolicy } from "../src/invocation-policy.js";
import type { AgentConfig } from "../src/types.js";

const MODELS = [
  { id: "parent", name: "Parent", provider: "test" },
  { id: "pinned", name: "Pinned", provider: "test" },
  { id: "requested", name: "Requested", provider: "test" },
];

const ctx = {
  cwd: "/tmp",
  model: MODELS[0],
  modelRegistry: {
    find: (provider: string, id: string) => MODELS.find((model) => model.provider === provider && model.id === id),
    getAll: () => MODELS,
    getAvailable: () => MODELS,
  },
} as never;

function customAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: name,
    extensions: true,
    skills: true,
    systemPrompt: `custom:${name}`,
    promptMode: "replace",
    ...overrides,
  };
}

afterEach(() => {
  setDefaultsDisabled(false);
  registerAgents(new Map());
});

describe("resolveAgentInvocationPolicy", () => {
  it("applies case-insensitive type lookup and frontmatter authority before fuzzy model resolution", () => {
    registerAgents(new Map([
      ["Reviewer", customAgent("Reviewer", {
        model: "pinned",
        thinking: "high",
        maxTurns: 9,
        isolated: true,
        isolation: "worktree",
      })],
    ]));

    const result = resolveAgentInvocationPolicy({
      selector: { kind: "registry", agentType: "reviewer" },
      params: {
        model: "requested",
        thinking: "low",
        max_turns: 2,
        isolated: false,
      },
      ctx,
      scopeModels: false,
      defaultMaxTurns: 20,
    });

    expect(result).toMatchObject({
      ok: true,
      subagentType: "Reviewer",
      fellBack: false,
      model: MODELS[1],
      effectiveMaxTurns: 9,
      resolvedConfig: {
        modelInput: "pinned",
        modelFromParams: false,
        thinking: "high",
        maxTurns: 9,
        isolated: true,
        isolation: "worktree",
      },
    });
  });

  it("uses the immutable embedded general-purpose base despite overrides and disabled defaults", () => {
    setDefaultsDisabled(true);
    registerAgents(new Map([
      ["general-purpose", customAgent("general-purpose", {
        displayName: "Overridden",
        model: "pinned",
        thinking: "high",
        maxTurns: 99,
      })],
    ]));

    const embedded = resolveAgentInvocationPolicy({
      selector: { kind: "embedded-general-purpose" },
      params: { model: "requested", thinking: "low", max_turns: 3 },
      ctx,
      scopeModels: false,
    });
    const explicit = resolveAgentInvocationPolicy({
      selector: { kind: "registry", agentType: "general-purpose" },
      params: { model: "requested", thinking: "low", max_turns: 3 },
      ctx,
      scopeModels: false,
    });

    expect(embedded).toMatchObject({
      ok: true,
      model: MODELS[2],
      effectiveMaxTurns: 3,
      resolvedConfig: { thinking: "low", modelFromParams: true },
      agentConfigOverride: {
        name: "general-purpose",
        displayName: "Agent",
        systemPrompt: "",
        promptMode: "append",
      },
    });
    expect(explicit).toMatchObject({
      ok: true,
      model: MODELS[1],
      effectiveMaxTurns: 99,
      resolvedConfig: { thinking: "high", modelFromParams: false },
    });
  });

  it("keeps the Agent tool's unknown-type fallback policy", () => {
    registerAgents(new Map());

    const result = resolveAgentInvocationPolicy({
      selector: { kind: "registry", agentType: "does-not-exist" },
      params: {},
      ctx,
      scopeModels: false,
      defaultMaxTurns: 4,
    });

    expect(result).toMatchObject({
      ok: true,
      rawType: "does-not-exist",
      subagentType: "general-purpose",
      fellBack: true,
      fallbackUsesRegisteredGeneralPurpose: true,
      effectiveMaxTurns: 4,
    });
  });

  it("rejects an unresolved caller model but silently inherits for an unresolved frontmatter pin", () => {
    registerAgents(new Map([
      ["broken-pin", customAgent("broken-pin", { model: "missing-model" })],
    ]));

    const caller = resolveAgentInvocationPolicy({
      selector: { kind: "registry", agentType: "general-purpose" },
      params: { model: "missing-model" },
      ctx,
      scopeModels: false,
    });
    const frontmatter = resolveAgentInvocationPolicy({
      selector: { kind: "registry", agentType: "broken-pin" },
      params: {},
      ctx,
      scopeModels: false,
    });

    expect(caller).toMatchObject({ ok: false, error: expect.stringContaining("Model not found") });
    expect(frontmatter).toMatchObject({ ok: true, model: MODELS[0] });
  });
});
