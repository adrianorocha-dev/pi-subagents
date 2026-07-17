import { describe, expect, it, vi } from "vitest";
import { renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import { type AgentActivity, AgentWidget, fgPreservingNestedStyles, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }

  function makeRecord(id: string, opts: { isBackground?: boolean } = {}) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: opts.isBackground,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });

  it("polls a registered provider so groups can appear before the first agent", () => {
    vi.useFakeTimers();
    try {
      const manager = { listAgents: () => [] };
      const widget = new AgentWidget(manager as any, new Map(), () => "background");
      let factory: any;
      let groups: Array<{ id: string; title: string; agentIds: string[] }> = [];
      widget.setUICtx({
        setStatus: () => {},
        setWidget: (_key, content) => { factory = content; },
      });
      widget.registerGroupProvider(() => groups);
      expect(factory).toBeUndefined();

      groups = [{ id: "live", title: "Live workflow", agentIds: [] }];
      vi.advanceTimersByTime(100);
      expect(factory).toBeTypeOf("function");
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps registered groups hidden when widget mode is off", () => {
    const manager = { listAgents: () => [] };
    const widget = new AgentWidget(manager as any, new Map(), () => "off");
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.registerGroupProvider(() => [{ id: "hidden", title: "Hidden", agentIds: [] }]);
    widget.update();

    expect(factory).toBeUndefined();
    widget.dispose();
  });

  it("neutralizes terminal controls in external groups, descriptions, activity, and errors", () => {
    const running = {
      ...makeRecord("running", { isBackground: true }),
      description: "review\u001b[2J description",
    };
    const failed = {
      ...makeRecord("failed", { isBackground: true }),
      description: "failed\u009b31m description",
      status: "error",
      error: "provider\u001b]8;;https://evil.example\u0007 failure\u001b]8;;\u0007",
      completedAt: Date.now(),
    };
    const activity = makeActivity();
    activity.responseText = "checking\u009d2;title\u009c changes";
    const manager = { listAgents: () => [running, failed] };
    const widget = new AgentWidget(
      manager as any,
      new Map([[running.id, activity]]),
      () => "background",
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.registerGroupProvider(() => [{
      id: "unsafe",
      title: "Review\u001b]0;owned\u0007 workflow",
      detail: "2\u009b2J calls",
      narrator: "checking\u001b[31m changes",
      agentIds: [running.id, failed.id],
    }]);
    widget.update();

    const rendered = factory(
      { terminal: { columns: 160 }, requestRender: () => {} },
      theme,
    ).render().join("\n");
    expect(rendered).toContain("Review workflow");
    expect(rendered).toContain("review description");
    expect(rendered).toContain("checking changes");
    expect(rendered).toContain("provider failure");
    expect(rendered).not.toContain("evil.example");
    expect(rendered).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    widget.dispose();
  });

  it("renders registered nested groups in provider order without duplicate agent rows", () => {
    const first = makeRecord("first", { isBackground: true });
    const second = makeRecord("second", { isBackground: true });
    const manager = { listAgents: () => [first, second] };
    const widget = new AgentWidget(
      manager as any,
      new Map([
        [first.id, makeActivity()],
        [second.id, makeActivity()],
      ]),
      () => "background",
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    const unregister = widget.registerGroupProvider(() => [{
      id: "workflow:run-1",
      title: "Review workflow",
      narrator: "checking changes",
      agentIds: [second.id],
      children: [{
        id: "phase:verify",
        title: "Verify",
        detail: "2 calls",
        agentIds: [first.id, second.id],
      }],
    }]);
    widget.update();

    const render = () => factory(
      { terminal: { columns: 120 }, requestRender: () => {} },
      theme,
    ).render().join("\n");
    const grouped = render();
    expect(grouped).toContain("Review workflow");
    expect(grouped).toContain("checking changes");
    expect(grouped).toContain("Verify");
    expect(grouped.indexOf("second description")).toBeLessThan(grouped.indexOf("first description"));
    expect(grouped.match(/second description/g)).toHaveLength(1);

    unregister();
    unregister();
    expect(render()).not.toContain("Review workflow");
    widget.dispose();
  });
});
