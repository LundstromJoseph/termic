import { i18n } from "@/lib/i18n";
import { parseReviewScope } from "@/lib/reviewScope";
import { useApp } from "@/store/app";
import { useReviews } from "@/store/reviews";
import { useReviewComments } from "@/store/reviewComments";
import { useUI } from "@/store/ui";
import type { Review } from "@/lib/types";

function reveal(taskId: string, reviewId: string) {
  useReviews.getState().setShown(taskId, reviewId);
  useUI.getState().revealReview(taskId, reviewId);
}

/** Forgets a deleted review: the store's copy, the drafts written for it and
 *  its open diff tabs, which are closed like a deleted file's. */
export function dropReview(taskId: string, reviewId: string) {
  useReviews.getState().remove(taskId, reviewId);
  const comments = useReviewComments.getState();
  const drafts = (comments.byTask[taskId] ?? []).filter(c => c.reviewId === reviewId).map(c => c.id);
  if (drafts.length) comments.removeMany(taskId, drafts);
  const app = useApp.getState();
  for (const tab of app.tabs[taskId] ?? []) {
    if (tab.type === "diff" && parseReviewScope(tab.scope)?.reviewId === reviewId) app.closeTab(taskId, tab.id);
  }
}

/** `review_changed`: the CLI server already wrote the review file, or with
 *  `deleted` removed one; mirror it. `reveal` (from `present new` and `present update`)
 *  points the task's Compare at it and toasts, without un-hiding the panel or
 *  switching task: the toast's Open does both. */
export async function reviewChangedHandler(params: unknown): Promise<null> {
  const p = params as { taskId?: unknown; review?: Review; reveal?: unknown; deleted?: unknown };
  if (typeof p?.taskId === "string" && p.taskId && typeof p.deleted === "string") {
    dropReview(p.taskId, p.deleted);
    return null;
  }
  if (typeof p?.taskId !== "string" || !p.taskId
    || typeof p.review?.id !== "string" || typeof p.review.seq !== "number") {
    throw new Error("review_changed requires a taskId and a review or a deleted id");
  }
  const taskId = p.taskId;
  const review = p.review;
  useReviews.getState().apply(taskId, review);
  if (p.reveal !== true) return null;
  reveal(taskId, review.id);
  // Only `present update` reveals a review that has a second iteration.
  const n = review.iterations.length;
  const msg = n >= 2
    ? review.title
      ? i18n.t("backend:review.updated", { agent: review.author, title: review.title, n })
      : i18n.t("backend:review.updatedUntitled", { agent: review.author, id: review.id, n })
    : review.title
      ? i18n.t("backend:review.opened", { agent: review.author, title: review.title })
      : i18n.t("backend:review.openedUntitled", { agent: review.author, id: review.id });
  useUI.getState().pushToast(msg, "info", {
    action: {
      label: i18n.t("backend:review.open"),
      onClick: () => {
        const app = useApp.getState();
        if (app.rightPanelHidden) app.toggleRightPanel();
        app.setActiveTask(taskId);
        reveal(taskId, review.id);
      },
    },
  });
  return null;
}
