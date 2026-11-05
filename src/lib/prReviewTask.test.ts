import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be declared before the module under test is imported.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ipc", () => ({
  taskGroupJoin: vi.fn().mockResolvedValue(undefined),
  taskGroupNew: vi.fn().mockResolvedValue(undefined),
  taskGroupUpdate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/quickTask", () => ({ createQuickTask: vi.fn() }));
vi.mock("@/lib/seedPrompt", () => ({ seedPromptWhenReady: vi.fn(), SETUP_SPAWN_DEADLINE_MS: 1 }));
vi.mock("@/lib/runPrompt", () => ({ runPrompt: vi.fn() }));
vi.mock("@/lib/prReview", () => ({
  fetchPrForReview: vi.fn(),
  checkoutPrInMain: vi.fn(),
  prReviewPrompt: (_pr: unknown, body: string) => body,
  reviewTaskName: (n: number) => `review-pr-${n}`,
}));

import { startPrReview, existingReviewTask, DEFAULT_REVIEW_GROUP, type ReviewWhere } from "@/lib/prReviewTask";
import { taskGroupJoin, taskGroupNew, taskGroupUpdate } from "@/lib/ipc";
import { createQuickTask } from "@/lib/quickTask";
import { runPrompt } from "@/lib/runPrompt";
import { fetchPrForReview, checkoutPrInMain } from "@/lib/prReview";
import { useApp } from "@/store/app";
import type { Task } from "@/lib/types";
import type { Prompt } from "@/store/prompts";

const PROMPT = { id: "builtin:review", title: "Review", body: "review it", builtin: true, enabled: true, modified: false } as Prompt;

function task(over: Partial<Task>): Task {
  return { id: "t", project_id: "p", name: "x", branch: "x", base_branch: "main", path: "/x", cli: "claude", port: 0, created: "", archived: false, ...over } as Task;
}

function review(over: { name?: string; group?: string; where?: ReviewWhere } = {}) {
  return startPrReview({ projectId: "p", number: 7, where: "worktree", cli: "claude", prompt: PROMPT, ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ tasks: [], projects: [], loadAll: vi.fn().mockResolvedValue(undefined) } as never);
  vi.mocked(fetchPrForReview).mockResolvedValue({ pr: { number: 7 } as never, branch: "alice/fix-login" });
  vi.mocked(createQuickTask).mockImplementation(async o => task({ id: "new", name: o.name, branch: o.branch ?? "" }));
});

describe("naming a review task", () => {
  it("is named after the PR's branch, as is", async () => {
    await review();
    expect(vi.mocked(createQuickTask).mock.calls[0][0].name).toBe("alice/fix-login");
  });

  it("takes the name typed in the dialog instead", async () => {
    await review({ name: "  login review  " });
    expect(vi.mocked(createQuickTask).mock.calls[0][0].name).toBe("login review");
  });
});

describe("grouping a review task", () => {
  it("founds the group, named, when no task carries it yet", async () => {
    await review({ group: DEFAULT_REVIEW_GROUP });
    expect(taskGroupNew).toHaveBeenCalledWith("new");
    expect(taskGroupUpdate).toHaveBeenCalledWith("new", "Review", null);
    expect(taskGroupJoin).not.toHaveBeenCalled();
  });

  it("joins the one an earlier review founded, whatever its case", async () => {
    useApp.setState({ tasks: [task({ id: "old", name: "earlier", branch: "b", group: { id: "old", name: "review" } })] } as never);
    await review({ group: "Review" });
    expect(taskGroupJoin).toHaveBeenCalledWith("new", "old");
    expect(taskGroupNew).not.toHaveBeenCalled();
  });

  it("does not join a group of that name in another project", async () => {
    useApp.setState({ tasks: [task({ id: "old", project_id: "other", group: { id: "old", name: "Review" } })] } as never);
    await review({ group: "Review" });
    expect(taskGroupJoin).not.toHaveBeenCalled();
    expect(taskGroupNew).toHaveBeenCalledWith("new");
  });

  it("puts it in no group when the group is left empty", async () => {
    await review({ group: "  " });
    expect(taskGroupNew).not.toHaveBeenCalled();
    expect(taskGroupJoin).not.toHaveBeenCalled();
  });

  it("still starts the review when grouping fails", async () => {
    vi.mocked(taskGroupNew).mockRejectedValueOnce(new Error("disk full"));
    const r = await review({ group: "Review" });
    expect(r.reused).toBe(false);
    expect(r.task.id).toBe("new");
  });
});

describe("a PR that already has a task", () => {
  it("reviews in the task on the PR's branch rather than checking it out twice", async () => {
    useApp.setState({ tasks: [task({ id: "mine", name: "my work", branch: "alice/fix-login" })], setActiveTask: vi.fn() } as never);
    const r = await review({ name: "ignored", group: "Review" });
    expect(r).toMatchObject({ reused: true, task: { id: "mine" } });
    expect(createQuickTask).not.toHaveBeenCalled();
    expect(runPrompt).toHaveBeenCalled();
    expect(taskGroupNew).not.toHaveBeenCalled();
  });

  it("finds it by branch, by the PR its poll resolved, or by the old review-pr name", () => {
    useApp.setState({ tasks: [
      task({ id: "a", branch: "alice/fix-login" }),
      task({ id: "b", branch: "z", pr_number: 9 }),
      task({ id: "c", branch: "y", name: "Review-PR-11" }),
      task({ id: "d", branch: "alice/fix-login", archived: true }),
    ] } as never);
    expect(existingReviewTask("p", 7, "alice/fix-login")?.id).toBe("a");
    expect(existingReviewTask("p", 9)?.id).toBe("b");
    expect(existingReviewTask("p", 11)?.id).toBe("c");
    expect(existingReviewTask("p", 12, "nobody")).toBeUndefined();
  });
});

describe("reviewing in a bare repository", () => {
  it("makes a worktree on the PR's branch and never moves a main checkout, even when asked for main", async () => {
    useApp.setState({ projects: [{ id: "p", bare: true }] } as never);

    await review({ where: "main" });

    expect(checkoutPrInMain).not.toHaveBeenCalled();
    expect(vi.mocked(createQuickTask).mock.calls[0][0]).toMatchObject({
      mode: "worktree", branch: "alice/fix-login", checkoutExisting: true,
    });
  });
});
