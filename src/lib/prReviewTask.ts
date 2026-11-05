// Start a PR review from the GUI (the Review a PR dialog). The CLI and MCP
// reach the same result through `new_task` with a `pr` (lib/cliRpc.ts),
// which shares every step below except the existing-task shortcut and the
// untracked prompt seed.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { createQuickTask } from "@/lib/quickTask";
import { seedPromptWhenReady, SETUP_SPAWN_DEADLINE_MS } from "@/lib/seedPrompt";
import { runPrompt } from "@/lib/runPrompt";
import { fetchPrForReview, checkoutPrInMain, prReviewPrompt, reviewTaskName } from "@/lib/prReview";
import { taskGroupJoin, taskGroupNew, taskGroupUpdate } from "@/lib/ipc";
import type { Prompt } from "@/store/prompts";
import type { Task } from "@/lib/types";

export type ReviewWhere = "worktree" | "main";

/** The sidebar group review tasks go into unless the user names another
 *  (or none) in the dialog. */
export const DEFAULT_REVIEW_GROUP = "Review";

/** The task already open for this PR, if any. Not by name alone, since the
 *  user names review tasks now: the PR's branch (one branch, one checkout,
 *  which git enforces anyway), the PR a task's poll resolved, or the
 *  `review-pr-<n>` name the CLI and older reviews use. */
export function existingReviewTask(projectId: string, n: number, branch?: string | null): Task | undefined {
  const legacy = reviewTaskName(n).toLowerCase();
  return useApp.getState().tasks.find(
    t => !t.archived && t.project_id === projectId
      && (t.name.toLowerCase() === legacy || t.pr_number === n || (!!branch && t.branch === branch)),
  );
}

/** Put `task` in the project's group called `label`: join it if a task
 *  already carries one by that name, else found it with `task` as the lead.
 *  A grouping failure leaves an ungrouped review, never a failed one. */
async function groupReview(task: Task, label: string) {
  const name = label.trim();
  if (!name) return;
  try {
    const peer = useApp.getState().tasks.find(
      t => !t.archived && t.id !== task.id && t.project_id === task.project_id
        && t.group?.name?.toLowerCase() === name.toLowerCase(),
    );
    if (peer) await taskGroupJoin(task.id, peer.id);
    else {
      await taskGroupNew(task.id);
      // A new group's id is its lead's: this task.
      await taskGroupUpdate(task.id, name, null);
    }
    await useApp.getState().loadAll();
  } catch (e) {
    console.warn("[review] could not group the review task", e);
  }
}

/** Fetch the PR, put its branch where the user asked, and seed the review
 *  prompt. A PR that already has a review task gets a fresh agent tab in
 *  that task instead of a second checkout of the same branch (git refuses
 *  that anyway). Returns the task and whether it was reused. */
export async function startPrReview(opts: {
  projectId: string;
  number: number;
  where: ReviewWhere;
  cli: string;
  prompt: Prompt;
  /** The task's name; empty or absent = the PR's branch. */
  name?: string;
  /** The sidebar group to put it in; empty or absent = none. */
  group?: string;
}): Promise<{ task: Task; reused: boolean }> {
  const { projectId, number, cli, prompt } = opts;
  // A bare repo has no main checkout to move.
  const bare = !!useApp.getState().projects.find(p => p.id === projectId)?.bare;
  const where: ReviewWhere = bare ? "worktree" : opts.where;
  const { pr, branch } = await fetchPrForReview(projectId, number);
  const body = prReviewPrompt(pr, prompt.body);

  const open = existingReviewTask(projectId, number, branch);
  if (open) {
    useApp.getState().setActiveTask(open.id);
    runPrompt(open.id, { ...prompt, body }, { kind: "new", cli });
    return { task: open, reused: true };
  }

  if (where === "main") {
    // The live checkout itself moves, which every main-checkout task, the
    // editor and any dev server share: said out loud, like the New Task
    // dialog's PR pick.
    const res = await checkoutPrInMain(projectId, branch);
    useUI.getState().pushToast(
      res.conflicted
        ? i18n.t("dialogs:newTask.prCheckedOutConflict", { branch })
        : res.stashed
          ? i18n.t("dialogs:newTask.prCheckedOutStashed", { branch })
          : i18n.t("dialogs:newTask.prCheckedOut", { branch }),
      res.conflicted ? "error" : "info",
    );
    if (res.conflicted) throw new Error(i18n.t("dialogs:newTask.prCheckedOutConflict", { branch }));
  }

  const task = await createQuickTask({
    projectId,
    mode: where === "main" ? "repo_root" : "worktree",
    cli,
    name: opts.name?.trim() || branch,
    ...(where === "worktree" ? { branch, checkoutExisting: true } : {}),
  });
  // A worktree runs its setup script first, so the agent may not spawn for
  // a while: the long deadline, as the issue path uses.
  seedPromptWhenReady(task.id, body, SETUP_SPAWN_DEADLINE_MS);
  await groupReview(task, opts.group ?? "");
  return { task, reused: false };
}
