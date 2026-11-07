import { i18n } from "@/lib/i18n";
import { useApp } from "@/store/app";
import { useReviews } from "@/store/reviews";
import { useUI } from "@/store/ui";
import type { Review } from "@/lib/types";

function reveal(taskId: string, reviewId: string) {
  useReviews.getState().setShown(taskId, reviewId);
  useUI.getState().revealReview(taskId, reviewId);
}

/** `review_changed`: the CLI server already wrote the review file; mirror
 *  it. `reveal` (from `present new` and `present update`) points the task's Compare at it
 *  and toasts, without un-hiding the panel or switching task: the toast's
 *  Open does both. */
export async function reviewChangedHandler(params: unknown): Promise<null> {
  const p = params as { taskId?: unknown; review?: Review; reveal?: unknown };
  if (typeof p?.taskId !== "string" || !p.taskId
    || typeof p.review?.id !== "string" || typeof p.review.seq !== "number") {
    throw new Error("review_changed requires a taskId and a review");
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
