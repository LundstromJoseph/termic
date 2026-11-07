// The user's side of an agent-presented review: post the comments to the
// review file (Rust owns it), then tell the review's agent tab through its
// prompt queue. Posting comes first and is what counts: the agent can always
// catch up with `present show`, so a missing or dead recipient loses nothing.

import { queueOrDeliver } from "./agentDelivery";
import { tabLabel, workDoneCapable } from "./agents";
import { reviewPost, reviewResolve } from "./ipc";
import { composeReviewMessage } from "./reviewMessage";
import { agentTargets, sendCommentsToAgent } from "./sendComments";
import { i18n } from "./i18n";
import { useReviews, selectReview } from "@/store/reviews";
import { isStaleDraft } from "./reviewScope";
import { useUI } from "@/store/ui";
import type { ReviewComment } from "@/store/reviewComments";
import type { ReviewPostItem } from "./types";

/**
 * Post `drafts` (all written in review `reviewId`'s diffs) and deliver them to
 * the review's recipient tab as one message. Never switches tab or takes focus.
 *
 * Resolves true once the comments are in the review file, whatever happened to
 * the delivery after that.
 */
export async function sendReviewComments(taskId: string, reviewId: string, drafts: ReviewComment[]): Promise<boolean> {
  const pushToast = useUI.getState().pushToast;
  const shown = selectReview(taskId, reviewId)(useReviews.getState());
  const pfx = shown?.dir_name ? `${shown.dir_name}/` : "";
  const items: ReviewPostItem[] = drafts.map(d => d.threadId
    ? { thread_id: d.threadId, file: null, start_line: null, end_line: null, quote: null, body: d.body }
    : {
      thread_id: null,
      file: pfx && d.file.startsWith(pfx) ? d.file.slice(pfx.length) : d.file,
      start_line: d.startLine,
      end_line: d.endLine,
      quote: d.quote || null,
      body: d.body,
      round: d.reviewRound ?? null,
    });

  let result: Awaited<ReturnType<typeof reviewPost>>;
  try {
    result = await reviewPost(taskId, reviewId, items);
  } catch (e) {
    pushToast(i18n.t("backend:review.postFailed", { id: reviewId, error: String(e) }), "error");
    return false;
  }
  const { review, posted } = result;
  useReviews.getState().apply(taskId, review);

  const tab = agentTargets(taskId).find(t => t.id === review.recipient_tab);
  if (!tab?.ptyId) {
    pushToast(i18n.t("backend:review.savedNoRecipient", { id: review.id }), "warning");
    return true;
  }
  const message = composeReviewMessage(review, posted.map(p => {
    const thread = review.threads.find(t => t.id === p.thread_id)!;
    return { thread, comment: thread.comments.find(c => c.seq === p.seq)!, newThread: p.new_thread };
  }));
  const name = tabLabel(tab);
  const what = i18n.t(posted.length === 1 ? "backend:sendComments.commentsOne" : "backend:sendComments.commentsOther", { count: posted.length });
  try {
    const mode = await queueOrDeliver(taskId, tab, message, { capable: workDoneCapable(tab.cli) });
    pushToast(i18n.t(mode === "delivered" ? "backend:sendComments.sent" : "backend:sendComments.queued", { what, name }), "success");
  } catch {
    pushToast(i18n.t("backend:review.deliveryFailed", { id: review.id, name }), "error");
  }
  return true;
}

/** Resolve or reopen a thread as the user. Tells the agent nothing: a resolve
 *  means nothing is left to do, and a reply is how the user asks for more. */
export async function resolveReviewThread(taskId: string, threadId: string, resolved: boolean): Promise<void> {
  try {
    useReviews.getState().apply(taskId, await reviewResolve(taskId, threadId, resolved));
  } catch (e) {
    useUI.getState().pushToast(i18n.t("backend:review.resolveFailed", { id: threadId, error: String(e) }), "error");
  }
}

/**
 * Send the pending list: plain comments as one message to `tabId` (the bar's
 * pick), and each review's comments as one message to that review's agent.
 * Returns the ids that left the list, so a failed group stays pending. A
 * stale draft stays too: Rust would refuse it, and with it the whole batch.
 */
export async function sendPendingComments(taskId: string, comments: ReviewComment[], tabId: string | null): Promise<string[]> {
  const plain = comments.filter(c => !c.reviewId);
  const byReview = new Map<string, ReviewComment[]>();
  const reviews = useReviews.getState();
  for (const c of comments) {
    if (!c.reviewId || isStaleDraft(c, selectReview(taskId, c.reviewId)(reviews))) continue;
    byReview.set(c.reviewId, [...(byReview.get(c.reviewId) ?? []), c]);
  }
  const sent: string[] = [];
  if (plain.length && await sendCommentsToAgent(taskId, plain, { tabId })) sent.push(...plain.map(c => c.id));
  for (const [reviewId, list] of byReview) {
    if (await sendReviewComments(taskId, reviewId, list)) sent.push(...list.map(c => c.id));
  }
  return sent;
}
