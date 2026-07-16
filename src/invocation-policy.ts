import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeMaxTurns } from "./agent-runner.js";
import { getAgentConfig, resolveType } from "./agent-types.js";
import { getEmbeddedGeneralPurposeConfig } from "./default-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import {
  type AgentInvocationParams,
  type ResolvedAgentInvocationConfig,
  resolveAgentInvocationConfig,
} from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import type { AgentConfig, AgentInvocation } from "./types.js";

export type AgentInvocationSelector =
  | { readonly kind: "registry"; readonly agentType: string }
  | { readonly kind: "embedded-general-purpose" };

export interface ResolveAgentInvocationPolicyOptions {
  readonly selector: AgentInvocationSelector;
  readonly params: AgentInvocationParams;
  readonly ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry">;
  readonly scopeModels: boolean;
  readonly defaultMaxTurns?: number;
}

export interface ResolvedAgentInvocationPolicy {
  readonly ok: true;
  readonly rawType: string;
  readonly subagentType: string;
  readonly fellBack: boolean;
  readonly fallbackUsesRegisteredGeneralPurpose: boolean;
  readonly agentConfig?: AgentConfig;
  readonly agentConfigOverride?: AgentConfig;
  readonly resolvedConfig: ResolvedAgentInvocationConfig;
  readonly model: ExtensionContext["model"];
  readonly modelName?: string;
  readonly effectiveMaxTurns?: number;
  readonly invocation: AgentInvocation;
  readonly warning?: string;
}

export interface RejectedAgentInvocationPolicy {
  readonly ok: false;
  readonly error: string;
}

export type AgentInvocationPolicyResult = ResolvedAgentInvocationPolicy | RejectedAgentInvocationPolicy;

/**
 * Resolve every invocation policy shared by the Agent tool and SubagentHostV1:
 * type/fallback selection, frontmatter authority, fuzzy models, model scope,
 * thinking, max turns, context, and isolation.
 */
export function resolveAgentInvocationPolicy(
  options: ResolveAgentInvocationPolicyOptions,
): AgentInvocationPolicyResult {
  const embedded = options.selector.kind === "embedded-general-purpose";
  const rawType = embedded ? "general-purpose" : options.selector.agentType;
  const resolvedType = embedded ? "general-purpose" : resolveType(rawType);
  const subagentType = resolvedType ?? "general-purpose";
  const fellBack = !embedded && resolvedType === undefined;
  const agentConfigOverride = embedded ? getEmbeddedGeneralPurposeConfig() : undefined;
  const agentConfig = agentConfigOverride ?? getAgentConfig(subagentType);
  const resolvedConfig = resolveAgentInvocationConfig(agentConfig, options.params);

  let model = options.ctx.model;
  if (resolvedConfig.modelInput) {
    const resolvedModel = resolveModel(resolvedConfig.modelInput, options.ctx.modelRegistry);
    if (typeof resolvedModel === "string") {
      if (resolvedConfig.modelFromParams) return { ok: false, error: resolvedModel };
      // A frontmatter model that cannot resolve keeps the Agent tool's existing
      // silent fallback to the parent model.
    } else {
      model = resolvedModel;
    }
  }

  let warning: string | undefined;
  if (options.scopeModels && model) {
    const allowed = resolveEnabledModels(
      readEnabledModels(options.ctx.cwd),
      options.ctx.modelRegistry,
      options.ctx.cwd,
    );
    if (allowed && !isModelInScope(model, allowed)) {
      if (resolvedConfig.modelFromParams) {
        const list = [...allowed].sort().map((entry) => `  ${entry}`).join("\n");
        return {
          ok: false,
          error:
            `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
            `Allowed models (from enabledModels):\n${list}`,
        };
      }
      const agentLabel = agentConfig?.displayName ?? subagentType;
      const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
      warning = `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`;
    }
  }

  const parentModelId = options.ctx.model?.id;
  const effectiveModelId = model?.id;
  const modelName = effectiveModelId && effectiveModelId !== parentModelId
    ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
    : undefined;
  const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? options.defaultMaxTurns);
  const invocation: AgentInvocation = {
    modelName,
    thinking: resolvedConfig.thinking,
    maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
    isolated: resolvedConfig.isolated,
    inheritContext: resolvedConfig.inheritContext,
    runInBackground: resolvedConfig.runInBackground,
    isolation: resolvedConfig.isolation,
  };

  return {
    ok: true,
    rawType,
    subagentType,
    fellBack,
    fallbackUsesRegisteredGeneralPurpose: resolveType("general-purpose") !== undefined,
    agentConfig,
    ...(agentConfigOverride === undefined ? {} : { agentConfigOverride }),
    resolvedConfig,
    model,
    modelName,
    effectiveMaxTurns,
    invocation,
    ...(warning === undefined ? {} : { warning }),
  };
}
