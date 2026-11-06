// @vitest-environment happy-dom
//
// Every UI comment send (composer Send, the pending bar) against the REAL
// store: it goes through the agent's queue like `termic send`, and it never
// moves the user off the tab they were reviewing in.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyAlive: vi.fn().mockResolvedValue(true),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/agentSend", () => ({ deliverMessage: vi.fn().mockResolvedValue(undefined) }));

import { sendCommentsToAgent } from "@/lib/sendComments";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { deliverMessage } from "@/lib/agentSend";
import { ptyAlive } from "@/lib/ipc";
import { focusTerminalTab } from "@/lib/tabFocus";
import type { ReviewComment } from "@/store/reviewComments";
import type { Task, Tab, TerminalTab } from "@/lib/types";

const COMMENT: ReviewComment = {
  id: "c1", taskId: "ws1", file: "src/a.ts", startLine: 3, endLine: 3,
  quote: "const a = 1;", body: "rename this", source: "diff",
} as ReviewComment;

function seed(agent: Record<string, unknown> = {}) {
  useApp.setState({
    tasks: [{ id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude", archived: false, persisted_tabs: [] } as unknown as Task],
    tabs: {
      ws1: [
        { id: "t-agent", type: "terminal", cli: "claude", title: "claude", is_default: true, ptyId: "pty-1", ...agent } as unknown as Tab,
        { id: "t-edit", type: "edit", path: "src/a.ts", title: "a.ts" } as unknown as Tab,
      ],
    },
    activeTab: { ws1: "t-edit" },
    mountedTasks: new Set(["ws1"]),
    agents: [{ id: "claude", name: "Claude Code", disabled: false }],
    detectedClis: {},
  } as never);
}

const agentTab = () => useApp.getState().tabs.ws1.find(t => t.id === "t-agent") as TerminalTab;
const toasts = () => useUI.getState().toasts.map(t => ({ msg: t.msg, kind: t.kind }));

describe("sendCommentsToAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUI.setState({ toasts: [] });
  });

  it("delivers straight into an idle agent's PTY and toasts Sent", async () => {
    seed();

    const ok = await sendCommentsToAgent("ws1", [COMMENT]);

    expect(ok).toBe(true);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverMessage).mock.calls[0][0]).toBe("pty-1");
    expect(vi.mocked(deliverMessage).mock.calls[0][1]).toContain("rename this");
    expect(toasts()).toEqual([{ msg: "Sent 1 comment to claude", kind: "success" }]);
  });

  it("queues behind a mid-turn agent instead of typing into its turn, and toasts Queued", async () => {
    seed({ workState: "working" });

    const ok = await sendCommentsToAgent("ws1", [COMMENT, { ...COMMENT, id: "c2" }]);

    expect(ok).toBe(true);
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(agentTab().queue?.map(q => q.text)).toEqual([expect.stringContaining("rename this")]);
    expect(toasts()).toEqual([{ msg: "Queued 2 comments for claude. It goes in when the agent is free.", kind: "success" }]);
  });

  it("queues behind the user's unsubmitted draft in an idle agent's prompt, and toasts Queued", async () => {
    seed({ composing: true });

    const ok = await sendCommentsToAgent("ws1", [COMMENT]);

    expect(ok).toBe(true);
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(agentTab().queue).toHaveLength(1);
    expect(toasts()).toEqual([{ msg: "Queued 1 comment for claude. It goes in when the agent is free.", kind: "success" }]);
  });

  it("leaves the active tab and focus where they were, whether it delivers or queues", async () => {
    seed();
    await sendCommentsToAgent("ws1", [COMMENT]);
    seed({ workState: "working" });
    await sendCommentsToAgent("ws1", [COMMENT]);

    expect(useApp.getState().activeTab.ws1).toBe("t-edit");
    expect(focusTerminalTab).not.toHaveBeenCalled();
  });

  it("returns false and toasts unreachable when the PTY write fails", async () => {
    seed();
    vi.mocked(deliverMessage).mockRejectedValueOnce(new Error("pty gone"));

    const ok = await sendCommentsToAgent("ws1", [COMMENT]);

    expect(ok).toBe(false);
    expect(toasts()).toEqual([{ msg: "Could not reach claude. Nothing was sent.", kind: "error" }]);
  });

  it("returns false and says it may not have arrived when the PTY dies right after the write", async () => {
    seed();
    vi.mocked(ptyAlive).mockResolvedValueOnce(false);

    const ok = await sendCommentsToAgent("ws1", [COMMENT]);

    expect(ok).toBe(false);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([{ msg: "claude exited while receiving 1 comment, so it may not have arrived.", kind: "error" }]);
  });
});
