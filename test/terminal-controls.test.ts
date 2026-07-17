import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import type { NotificationDetails } from "../src/types.js";
import type { AgentDetails, Theme } from "../src/ui/agent-widget.js";
import { cleanUiLines, cleanUiText, neutralizeTerminalControls } from "../src/ui/terminal-controls.js";

const OSC52 = "\u001b]52;c;dHVpLWNsaXBib2FyZC1zZWNyZXQ=\u0007";
const CSI = "\u001b[2J";
const C1_CSI = "\u009b31m";
const C1_OSC52 = "\u009d52;c;YzEtdHVpLWNsaXBib2FyZC1zZWNyZXQ=\u009c";

const ansiTheme: Theme = {
  fg: (_color, text) => `\u001b[38;5;240m${text}\u001b[39m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};

type Renderable = { render(width: number): string[] };
type NotificationRenderer = (
  message: { details?: NotificationDetails },
  options: { expanded: boolean },
  theme: Theme,
) => Renderable | undefined;
type AgentTool = {
  renderCall(args: { description?: string; subagent_type?: string }, theme: Theme): Renderable;
  renderResult(
    result: { content: Array<{ type: "text"; text: string }>; details?: AgentDetails },
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
  ): Renderable;
};
type LifecycleHandler = (event: unknown, ctx: unknown) => unknown;

const shutdowns: Array<() => Promise<void>> = [];

function extensionHarness(): { notificationRenderer: NotificationRenderer; agentTool: AgentTool } {
  const tools = new Map<string, unknown>();
  const lifecycle = new Map<string, LifecycleHandler>();
  let notificationRenderer: NotificationRenderer | undefined;
  const pi = {
    registerMessageRenderer: vi.fn((type: string, renderer: NotificationRenderer) => {
      if (type === "subagent-notification") notificationRenderer = renderer;
    }),
    registerTool: vi.fn((tool: { name: string }) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    on: vi.fn((event: string, handler: LifecycleHandler) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  };

  subagentsExtension(pi as unknown as ExtensionAPI);
  shutdowns.push(async () => {
    await lifecycle.get("session_shutdown")?.({}, { hasUI: false, ui: {} });
  });

  if (!notificationRenderer) throw new Error("notification renderer was not registered");
  const agentTool = tools.get("Agent") as AgentTool | undefined;
  if (!agentTool) throw new Error("Agent tool was not registered");
  return { notificationRenderer, agentTool };
}

function expectNoUntrustedControls(rendered: string): void {
  expect(rendered).not.toContain("dHVpLWNsaXBib2FyZC1zZWNyZXQ=");
  expect(rendered).not.toContain("YzEtdHVpLWNsaXBib2FyZC1zZWNyZXQ=");
  expect(rendered).not.toContain("\u001b]52");
  expect(rendered).not.toContain(CSI);
  expect(rendered).not.toMatch(/[\u0080-\u009f]/u);
}

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
});

describe("terminal control neutralization", () => {
  it("strips OSC 52, CSI, and C1 while preserving safe Unicode and requested newlines", () => {
    const raw = `alpha λ${OSC52}${CSI}${C1_CSI}${C1_OSC52}\r\nbeta 文`;

    expect(cleanUiLines(raw)).toBe("alpha λ\nbeta 文");
    expect(cleanUiText(raw)).toBe("alpha λ beta 文");
    expect(neutralizeTerminalControls(raw, { preserveNewlines: true })).toBe("alpha λ\nbeta 文");
  });

  it("neutralizes automatic notification descriptions and result previews before theming", () => {
    const { notificationRenderer } = extensionHarness();
    const details: NotificationDetails = {
      id: "agent-1",
      description: `Review λ${OSC52}${CSI}${C1_CSI}${C1_OSC52}\nchanges`,
      status: "completed",
      toolUses: 1,
      turnCount: 1,
      totalTokens: 42,
      durationMs: 10,
      outputFile: `/tmp/result${OSC52}${CSI}${C1_CSI}.jsonl`,
      resultPreview: `first 文${OSC52}${CSI}${C1_CSI}${C1_OSC52}\nsecond β`,
    };

    for (const expanded of [false, true]) {
      const component = notificationRenderer({ details }, { expanded }, ansiTheme);
      const rendered = component?.render(240).join("\n") ?? "";
      expect(rendered).toContain("Review λ changes");
      expect(rendered).toContain("first 文");
      if (expanded) expect(rendered).toContain("second β");
      expect(rendered).toContain("\u001b[38;5;240m");
      expectNoUntrustedControls(rendered);
    }
  });

  it("neutralizes Agent tool-call descriptions and expanded results before theming", () => {
    const { agentTool } = extensionHarness();
    const unsafe = `safe α${OSC52}${CSI}${C1_CSI}${C1_OSC52}\nnext 文`;

    const call = agentTool.renderCall(
      { subagent_type: "general-purpose", description: unsafe },
      ansiTheme,
    ).render(240).join("\n");
    expect(call).toContain("safe α next 文");
    expect(call).toContain("\u001b[38;5;240m");
    expectNoUntrustedControls(call);

    const details: AgentDetails = {
      displayName: "Agent",
      description: "unsafe result",
      subagentType: "general-purpose",
      toolUses: 0,
      tokens: "",
      durationMs: 10,
      status: "completed",
    };
    const result = agentTool.renderResult(
      { content: [{ type: "text", text: unsafe }], details },
      { expanded: true, isPartial: false },
      ansiTheme,
    ).render(240).join("\n");
    expect(result).toContain("safe α");
    expect(result).toContain("next 文");
    expectNoUntrustedControls(result);
  });
});
