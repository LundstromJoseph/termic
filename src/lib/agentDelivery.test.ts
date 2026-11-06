// @vitest-environment happy-dom
//
// queueOrDeliver's promptId handling. The `termic send` paths (promptId
// always set) are pinned by store/cliSend*.integration.test.ts; this covers
// the UI comment sends, which carry no promptId.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyAlive: vi.fn().mockResolvedValue(true),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/agentSend", () => ({ deliverMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cliPromptReports", () => ({ reportCliPromptDelivery: vi.fn().mockResolvedValue(undefined) }));

import { queueOrDeliver } from "@/lib/agentDelivery";
import { useApp } from "@/store/app";
import { reportCliPromptDelivery } from "@/lib/cliPromptReports";
import type { Task, Tab, TerminalTab } from "@/lib/types";

const TAB = { id: "t-agent", type: "terminal", cli: "claude", title: "claude", is_default: true, ptyId: "pty-1" } as unknown as TerminalTab;

describe("queueOrDeliver without a promptId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({
      tasks: [{ id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude", archived: false, persisted_tabs: [] } as unknown as Task],
      tabs: { ws1: [TAB as unknown as Tab] },
      mountedTasks: new Set(["ws1"]),
      agents: [{ id: "claude", name: "Claude Code", disabled: false }],
      detectedClis: {},
    } as never);
  });

  it("delivers to an idle agent without sending a cli_prompt_report", async () => {
    const mode = await queueOrDeliver("ws1", TAB, "look at this", { capable: true });

    expect(mode).toBe("delivered");
    expect(reportCliPromptDelivery).not.toHaveBeenCalled();
  });
});
