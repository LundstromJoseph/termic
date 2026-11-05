// @vitest-environment happy-dom
//
// `termic badge`: the CLI server writes the task file, then pushes the list
// through `task_badges`. Driven through the REAL handler against the REAL
// store, since what matters is which Task objects change identity.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  tasksList: vi.fn().mockResolvedValue([]),
  detectClis: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { taskBadgesHandler } from "@/lib/cliRpc";
import { useApp } from "@/store/app";
import * as ipc from "@/lib/ipc";
import type { Task } from "@/lib/types";

const ci = { key: "ci", text: "passing", color: "good" };

function task(id: string, over: Partial<Task> = {}): Task {
  return { id, project_id: "p1", name: id, archived: false, ...over } as Task;
}

beforeEach(() => {
  useApp.setState({ tasks: [task("a"), task("b", { badges: [ci] })] });
});

describe("setTaskBadges", () => {
  it("replaces only that task, and every other task keeps its identity", () => {
    const [a0, b0] = useApp.getState().tasks;

    useApp.getState().setTaskBadges("a", [ci]);

    const [a1, b1] = useApp.getState().tasks;
    expect(a1).not.toBe(a0);
    expect(a1.badges).toEqual([ci]);
    expect(b1).toBe(b0);
  });

  it("stores an empty list as absent", () => {
    useApp.getState().setTaskBadges("b", []);

    expect(useApp.getState().tasks[1].badges).toBeUndefined();
  });

  it("leaves the state untouched for an unknown task or an equal list", () => {
    const before = useApp.getState().tasks;

    useApp.getState().setTaskBadges("nope", [ci]);
    useApp.getState().setTaskBadges("b", [{ ...ci }]);

    expect(useApp.getState().tasks).toBe(before);
  });
});

describe("taskBadgesHandler", () => {
  it("mirrors the pushed list into the store without reloading tasks", async () => {
    const r = await taskBadgesHandler({ taskId: "a", badges: [ci] });

    expect(r).toBeNull();
    expect(useApp.getState().tasks[0].badges).toEqual([ci]);
    expect(ipc.tasksList).not.toHaveBeenCalled();
  });

  it("is a no-op for a task the store does not hold", async () => {
    const before = useApp.getState().tasks;

    await taskBadgesHandler({ taskId: "unknown", badges: [ci] });

    expect(useApp.getState().tasks).toBe(before);
  });

  it("refuses params without a taskId or with malformed badges", async () => {
    for (const bad of [
      null,
      { badges: [ci] },
      { taskId: "", badges: [ci] },
      { taskId: "a" },
      { taskId: "a", badges: [null] },
      { taskId: "a", badges: [{ key: "ci", text: "x" }] },
    ]) {
      await expect(taskBadgesHandler(bad), JSON.stringify(bad)).rejects.toThrow("task_badges requires");
    }
  });
});
