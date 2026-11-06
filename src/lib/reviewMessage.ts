// The message a user's review comments arrive as in the agent's terminal.
// It names every thread id, because the agent answers with
// `present reply <thread>`, and says so, because an agent left to itself
// answers in the terminal where the user is not reading.

import { fenceQuote } from "@/store/reviewComments";
import type { Review, ReviewThread, ReviewThreadComment } from "./types";

export interface PostedItem {
  thread: ReviewThread;
  comment: ReviewThreadComment;
  newThread: boolean;
}

export function composeReviewMessage(review: Review, posted: PostedItem[]): string {
  const title = review.title ? ` "${review.title}"` : "";
  const n = posted.length;
  const head =
    `[Termic review ${review.id}${title} ${review.base.slice(0, 7)}..${review.head.slice(0, 7)}] `
    + `The user left ${n} ${n === 1 ? "comment" : "comments"}.\n`
    + `Answer each in its thread with "$TERMIC_CLI" present reply <thread> -m "...", not here. `
    + `Full review: "$TERMIC_CLI" present show ${review.id}.`;
  const blocks = posted.map(({ thread, comment, newThread }) => {
    const { file, start_line: s, end_line: e } = thread;
    const loc = s == null ? file : e != null && e !== s ? `${file}:${s}-${e}` : `${file}:${s}`;
    let block = `${loc} (thread ${thread.id}${newThread ? ", new thread" : ""})`;
    if (thread.quote.trim()) block += `\n${fenceQuote(thread.quote)}`;
    return `${block}\n${comment.body}`;
  });
  return `${head}\n\n${blocks.join("\n\n")}`;
}
