// @vitest-environment happy-dom
//
// `termic view` (v30) driven through the REAL `viewFileHandler` against the
// REAL store, ipc mocked. What matters is where the file lands (edit tab
// inside the task, read-only external tab outside it), that it stays in the
// background unless asked, and that nothing reaches an unmounted strip.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  taskPathStat: vi.fn(),
  pathExists: vi.fn(),
  fileReadExternal: vi.fn(),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { viewFileHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { ExternalTab, Tab, Task } from "@/lib/types";

const TASK = {
  id: "ws1", project_id: "p1", name: "fix-auth", branch: "main", base_branch: "main",
  path: "/Users/u/tasks/fix-auth", cli: "claude", port: 1420, created: "2024-01-01", archived: false,
  persisted_tabs: [{ id: "main", cli: "claude", title: "claude", is_default: true }],
} as unknown as Task;

function seed(mounted = true) {
  useApp.setState({
    tasks: [TASK],
    tabs: { ws1: [{ id: "main", type: "terminal", title: "claude", cli: "claude", is_default: true } as unknown as Tab] },
    activeTab: { ws1: "main" },
    mountedTasks: new Set(mounted ? ["ws1"] : []),
    closedTabs: {},
    splitTree: {},
    activePaneId: {},
    paneHistory: {},
    agents: [],
  } as never);
  vi.mocked(ipc.taskPathStat).mockResolvedValue({ exists: true, is_dir: false } as never);
  vi.mocked(ipc.pathExists).mockResolvedValue(true);
  vi.mocked(ipc.fileReadExternal).mockResolvedValue("# Report\n");
}

const tabs = () => useApp.getState().tabs.ws1 ?? [];
const active = () => useApp.getState().activeTab.ws1;

describe("termic view", () => {
  beforeEach(() => seed());

  it("refuses a task that is not mounted and opens no tab", async () => {
    seed(false);

    const result = viewFileHandler({ taskId: "ws1", path: "/tmp/report.md", focus: false });

    await expect(result).rejects.toThrow("task fix-auth is not open in Termic");
    expect(useApp.getState().tabs.ws1).toHaveLength(1);
  });

  it("opens a file inside the task as an edit tab on its task-relative path", async () => {
    const result = await viewFileHandler({ taskId: "ws1", path: "/Users/u/tasks/fix-auth/src/a.ts", focus: false });

    const tab = tabs().find(t => t.id === result.tabId);
    expect(tab).toMatchObject({ type: "edit", path: "src/a.ts", title: "a.ts" });
    expect(result).toMatchObject({ taskId: "ws1", external: false, focused: false });
    expect(ipc.taskPathStat).toHaveBeenCalledWith("ws1", "src/a.ts");
  });

  it("opens a file outside the task as an external tab in the background", async () => {
    const result = await viewFileHandler({ taskId: "ws1", path: "/tmp/notes.txt", focus: false });

    const tab = tabs().find(t => t.id === result.tabId);
    expect(tab).toMatchObject({ type: "external", path: "/tmp/notes.txt", title: "notes.txt" });
    expect(result).toMatchObject({ path: "/tmp/notes.txt", external: true, focused: false });
    expect(active()).toBe("main");
  });

  it("makes the tab the task's active tab with focus", async () => {
    const result = await viewFileHandler({ taskId: "ws1", path: "/tmp/notes.txt", focus: true });

    expect(active()).toBe(result.tabId);
    expect(result.focused).toBe(true);
  });

  it("opens a new markdown tab rendered, without touching a non-markdown tab's view", async () => {
    const md = await viewFileHandler({ taskId: "ws1", path: "/tmp/report.md", focus: false });
    const txt = await viewFileHandler({ taskId: "ws1", path: "/tmp/notes.txt", focus: false });

    const byId = (id: string) => tabs().find(t => t.id === id) as ExternalTab;
    expect(byId(md.tabId).mdView).toBe("preview");
    expect(byId(txt.tabId).mdView).toBeUndefined();
  });

  it("reuses the open tab on a second view and bumps its reload nonce", async () => {
    const first = await viewFileHandler({ taskId: "ws1", path: "/tmp/report.md", focus: false });
    const nonce = (tabs().find(t => t.id === first.tabId) as ExternalTab).reloadNonce ?? 0;

    const second = await viewFileHandler({ taskId: "ws1", path: "/tmp/report.md", focus: false });

    expect(second.tabId).toBe(first.tabId);
    expect(tabs().filter(t => t.type === "external")).toHaveLength(1);
    expect((tabs().find(t => t.id === first.tabId) as ExternalTab).reloadNonce).toBe(nonce + 1);
  });

  it("keeps a markdown tab's view when it is viewed again after the user switched it", async () => {
    const first = await viewFileHandler({ taskId: "ws1", path: "/tmp/report.md", focus: false });
    useApp.getState().patchTab("ws1", first.tabId, { mdView: "source" });

    await viewFileHandler({ taskId: "ws1", path: "/tmp/report.md", focus: false });

    expect((tabs().find(t => t.id === first.tabId) as ExternalTab).mdView).toBe("source");
  });

  it("refuses a missing file outside the task and opens no tab", async () => {
    vi.mocked(ipc.pathExists).mockResolvedValue(false);

    const result = viewFileHandler({ taskId: "ws1", path: "/tmp/gone.md", focus: false });

    await expect(result).rejects.toThrow("no such file: /tmp/gone.md");
    expect(tabs()).toHaveLength(1);
  });

  it("refuses a directory inside the task and opens no tab", async () => {
    vi.mocked(ipc.taskPathStat).mockResolvedValue({ exists: true, is_dir: true } as never);

    const result = viewFileHandler({ taskId: "ws1", path: "/Users/u/tasks/fix-auth/src", focus: false });

    await expect(result).rejects.toThrow("no such file: /Users/u/tasks/fix-auth/src");
    expect(tabs()).toHaveLength(1);
  });

  it("refuses a file the read rejects (binary or over 2 MB) and opens no tab", async () => {
    vi.mocked(ipc.fileReadExternal).mockRejectedValue(new Error("not UTF-8"));

    const result = viewFileHandler({ taskId: "ws1", path: "/tmp/image.png", focus: false });

    await expect(result).rejects.toThrow("Termic shows UTF-8 text files of 2 MB or less: /tmp/image.png");
    expect(tabs()).toHaveLength(1);
  });

  it("folds .. in a path under the task root and opens the edit tab on the clean task-relative path", async () => {
    const path = "/Users/u/tasks/fix-auth/src/../docs/r.md";

    const result = await viewFileHandler({ taskId: "ws1", path, focus: false });

    const tab = tabs().find(t => t.id === result.tabId);
    expect(tab).toMatchObject({ type: "edit", path: "docs/r.md", title: "r.md" });
    expect(ipc.taskPathStat).toHaveBeenCalledWith("ws1", "docs/r.md");
    expect(result).toMatchObject({ path, external: false });
  });

  it("folds .. that climbs out of the task root and opens one external tab on the clean absolute path", async () => {
    const path = "/Users/u/tasks/fix-auth/../../docs/tasks/r.md";

    const result = await viewFileHandler({ taskId: "ws1", path, focus: false });
    await viewFileHandler({ taskId: "ws1", path: "/Users/u/docs/tasks/r.md", focus: false });

    const external = tabs().filter(t => t.type === "external");
    expect(external).toHaveLength(1);
    expect(external[0]).toMatchObject({ id: result.tabId, path: "/Users/u/docs/tasks/r.md", title: "r.md" });
    expect(ipc.pathExists).toHaveBeenCalledWith("/Users/u/docs/tasks/r.md");
    expect(result).toMatchObject({ path, external: true });
  });
});
