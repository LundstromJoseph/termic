// @vitest-environment happy-dom
//
// `termic new` on a bare project, through the REAL `newTaskHandler`: a bare
// repo has no main checkout, so the remembered mode never applies, while an
// explicit --main still reaches Rust (which refuses it with the reason).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/ipc", () => ({
  taskCreate: vi.fn(),
  taskOpenRepo: vi.fn(),
  tasksList: vi.fn().mockResolvedValue([]),
  projectGitBranches: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/runTabs", () => ({ launchSetupTab: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/agentDelivery", () => ({
  waitForAgentPty: vi.fn().mockResolvedValue(false),
  agentTabFor: vi.fn(),
  defaultAgentTab: vi.fn(),
  deliverPromptWhenReady: vi.fn(),
}));

import { newTaskHandler } from "@/lib/cliRpc";
import { writeNewTaskMode } from "@/lib/quickTask";
import { taskCreate, taskOpenRepo } from "@/lib/ipc";
import { useApp } from "@/store/app";
import type { Project, Task } from "@/lib/types";

const TASK = { id: "new", project_id: "p", name: "fix" } as Task;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(taskCreate).mockResolvedValue(TASK);
  vi.mocked(taskOpenRepo).mockResolvedValue(TASK);
  useApp.setState({
    projects: [{ id: "p", name: "app", root_path: "/r", bare: true } as Project],
    tasks: [],
    loadAll: vi.fn().mockResolvedValue(undefined),
    mountTasks: vi.fn(),
  } as never);
});

describe("termic new on a bare project", () => {
  it("creates a worktree when no mode is given, even with the main checkout remembered", async () => {
    writeNewTaskMode("repo_root");

    await newTaskHandler({ projectId: "p", name: "fix" }, () => {});

    expect(taskCreate).toHaveBeenCalledOnce();
    expect(taskOpenRepo).not.toHaveBeenCalled();
  });

  it("passes an explicit --main through to the main checkout create for Rust to refuse", async () => {
    await newTaskHandler({ projectId: "p", name: "fix", mode: "main" }, () => {});

    expect(taskOpenRepo).toHaveBeenCalledOnce();
    expect(taskCreate).not.toHaveBeenCalled();
  });
});
