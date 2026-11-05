// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  taskCreate: vi.fn(),
  taskOpenRepo: vi.fn(),
  taskImportWorktree: vi.fn(),
  settingsLoad: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/runTabs", () => ({ launchSetupTab: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/seedPrompt", () => ({ seedPromptWhenReady: vi.fn(), SPAWN_DEADLINE_MS: 1, SETUP_SPAWN_DEADLINE_MS: 2 }));

import { createQuickTask } from "@/lib/quickTask";
import { taskCreate, taskOpenRepo } from "@/lib/ipc";
import { seedPromptWhenReady } from "@/lib/seedPrompt";
import { useApp } from "@/store/app";
import type { Project, Task } from "@/lib/types";

const TASK = { id: "new", project_id: "p", name: "fix" } as Task;

function withProject(over: Partial<Project>) {
  useApp.setState({
    projects: [{ id: "p", name: "app", root_path: "/r", ...over } as Project],
    loadAll: vi.fn().mockResolvedValue(undefined),
    setActiveTask: vi.fn(),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(taskCreate).mockResolvedValue(TASK);
  vi.mocked(taskOpenRepo).mockResolvedValue(TASK);
});

describe("createQuickTask mode", () => {
  it("creates a worktree in a bare project even when the caller asks for the main checkout", async () => {
    withProject({ bare: true });

    await createQuickTask({ projectId: "p", mode: "repo_root", cli: "shell", name: "fix" });

    expect(taskCreate).toHaveBeenCalledOnce();
    expect(taskOpenRepo).not.toHaveBeenCalled();
  });

  it("opens the main checkout in a non-bare project when the caller asks for it", async () => {
    withProject({ bare: false });

    await createQuickTask({ projectId: "p", mode: "repo_root", cli: "shell", name: "fix" });

    expect(taskOpenRepo).toHaveBeenCalledOnce();
    expect(taskCreate).not.toHaveBeenCalled();
  });
});

describe("createQuickTask project default prompt", () => {
  it("seeds the trimmed default with the spawn deadline for a main-checkout agent task when asked", async () => {
    withProject({ default_initial_prompt: "  Read AGENTS.md.  " });

    await createQuickTask({ projectId: "p", mode: "repo_root", cli: "claude", name: "fix", seedProjectPrompt: true });

    expect(seedPromptWhenReady).toHaveBeenCalledWith("new", "Read AGENTS.md.", 1);
  });

  it("seeds the default with the setup deadline for a worktree agent task when asked", async () => {
    withProject({ default_initial_prompt: "Read AGENTS.md." });

    await createQuickTask({ projectId: "p", mode: "worktree", cli: "claude", name: "fix", seedProjectPrompt: true });

    expect(seedPromptWhenReady).toHaveBeenCalledWith("new", "Read AGENTS.md.", 2);
  });

  it("does not seed the default when the caller does not opt in (PR review seeds its own)", async () => {
    withProject({ default_initial_prompt: "Read AGENTS.md." });

    await createQuickTask({ projectId: "p", mode: "repo_root", cli: "claude", name: "fix" });

    expect(seedPromptWhenReady).not.toHaveBeenCalled();
  });

  it("does not seed the default into a shell task", async () => {
    withProject({ default_initial_prompt: "Read AGENTS.md." });

    await createQuickTask({ projectId: "p", mode: "repo_root", cli: "shell", name: "fix", seedProjectPrompt: true });

    expect(seedPromptWhenReady).not.toHaveBeenCalled();
  });

  it("does not seed anything when the project has no default", async () => {
    withProject({});

    await createQuickTask({ projectId: "p", mode: "repo_root", cli: "claude", name: "fix", seedProjectPrompt: true });

    expect(seedPromptWhenReady).not.toHaveBeenCalled();
  });
});
