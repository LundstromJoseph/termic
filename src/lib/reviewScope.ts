// A review diff's scope string and which threads it draws. `review:<id>`
// follows the review's latest iteration; `review:<id>:to:<N>` pins an older iteration
// and draws only the threads opened on it, at the anchor they were opened on.
// `:from:<K>` after the id compares from iteration K's change instead of the base.

import type { Review, ReviewAnchor, ReviewThread } from "./types";

export interface ParsedReviewScope {
  reviewId: string;
  /** Null compares from the iteration's base. */
  from: number | null;
  /** Null follows the latest iteration. */
  to: number | null;
}

export function parseReviewScope(scope?: string | null): ParsedReviewScope | null {
  const m = scope?.match(/^review:(r[1-9]\d*)(?::from:([1-9]\d*))?(?::to:([1-9]\d*))?$/);
  return m ? { reviewId: m[1], from: m[2] ? Number(m[2]) : null, to: m[3] ? Number(m[3]) : null } : null;
}

/** The scope of `review` from iteration `from` (the base when null) to iteration
 *  `to`; the latest iteration is left out, and a from not below to is dropped. */
export function reviewScope(review: Review, from: number | null, to: number | null): `review:${string}` {
  const n = review.iterations.length;
  const end = to == null || to >= n ? null : to;
  const start = from != null && from < (end ?? n) ? `:from:${from}` : "";
  return `review:${review.id}${start}${end == null ? "" : `:to:${end}`}`;
}

export interface ReviewView {
  from: number | null;
  to: number | null;
}

/** The view Compare shows: the viewer's pick while the review has the iterations
 *  it was made at, else the agent's `default_from` against the latest iteration. */
export function effectiveView(review: Review, pick?: ReviewView & { iterations: number }): ReviewView {
  const n = review.iterations.length;
  const v = pick && pick.iterations === n ? pick : { from: review.default_from ?? null, to: null };
  const to = v.to != null && v.to < n ? v.to : null;
  const from = v.from != null && v.from < (to ?? n) ? v.from : null;
  return { from, to };
}

/** The view after picking To iteration `to` of `n`: the latest is stored as null,
 *  and a From at or past the new To would compare backwards, so it resets to Base. */
export function pickTo(from: number | null, to: number, n: number): ReviewView {
  return { from: from != null && from >= to ? null : from, to: to === n ? null : to };
}

/** A new-thread draft written on an iteration the review has since moved past.
 *  Its lines are that iteration's head's, so it waits to be rewritten on the new
 *  diff and is never sent. A reply has no lines and is never stale. */
export function isStaleDraft(c: { threadId?: string; reviewIteration?: number }, review: Review | null | undefined): boolean {
  return !c.threadId && c.reviewIteration != null && !!review && c.reviewIteration < review.iterations.length;
}

/** Where a thread was opened. */
export function threadAnchor(th: ReviewThread): ReviewAnchor {
  return th.origin ?? { file: th.file, start_line: th.start_line, end_line: th.end_line };
}

/** The threads a review diff of `path` (dir-prefixed) draws. The latest iteration
 *  draws live threads where they are now; an older iteration draws the threads
 *  opened on it, moved back to where they were opened. */
export function threadsInView(review: Review, path: string, to: number | null): ReviewThread[] {
  const dir = review.dir_name ? `${review.dir_name}/` : "";
  if (to == null || to >= review.iterations.length) {
    return review.threads.filter(th => !th.outdated && dir + th.file === path);
  }
  return review.threads
    .filter(th => th.iteration === to && dir + threadAnchor(th).file === path)
    .map(th => ({ ...th, ...threadAnchor(th) }));
}
