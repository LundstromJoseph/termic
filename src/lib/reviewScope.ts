// A review diff's scope string and which threads it draws. `review:<id>`
// follows the review's latest round; `review:<id>:to:<N>` pins an older round
// and draws only the threads opened on it, at the anchor they were opened on.
// `:from:<K>` after the id compares from round K's change instead of the base.

import type { Review, ReviewAnchor, ReviewThread } from "./types";

export interface ParsedReviewScope {
  reviewId: string;
  /** Null compares from the round's base. */
  from: number | null;
  /** Null follows the latest round. */
  to: number | null;
}

export function parseReviewScope(scope?: string | null): ParsedReviewScope | null {
  const m = scope?.match(/^review:(r[1-9]\d*)(?::from:([1-9]\d*))?(?::to:([1-9]\d*))?$/);
  return m ? { reviewId: m[1], from: m[2] ? Number(m[2]) : null, to: m[3] ? Number(m[3]) : null } : null;
}

/** The scope of `review` from round `from` (the base when null) to round
 *  `to`; the latest round is left out, and a from not below to is dropped. */
export function reviewScope(review: Review, from: number | null, to: number | null): `review:${string}` {
  const n = review.rounds.length;
  const end = to == null || to >= n ? null : to;
  const start = from != null && from < (end ?? n) ? `:from:${from}` : "";
  return `review:${review.id}${start}${end == null ? "" : `:to:${end}`}`;
}

export interface ReviewView {
  from: number | null;
  to: number | null;
}

/** The view Compare shows: the viewer's pick while the review has the rounds
 *  it was made at, else the agent's `default_from` against the latest round. */
export function effectiveView(review: Review, pick?: ReviewView & { rounds: number }): ReviewView {
  const n = review.rounds.length;
  const v = pick && pick.rounds === n ? pick : { from: review.default_from ?? null, to: null };
  const to = v.to != null && v.to < n ? v.to : null;
  const from = v.from != null && v.from < (to ?? n) ? v.from : null;
  return { from, to };
}

/** The view after picking To round `to` of `n`: the latest is stored as null,
 *  and a From at or past the new To would compare backwards, so it resets to Base. */
export function pickTo(from: number | null, to: number, n: number): ReviewView {
  return { from: from != null && from >= to ? null : from, to: to === n ? null : to };
}

/** A new-thread draft written on a round the review has since moved past.
 *  Its lines are that round's head's, so it waits to be rewritten on the new
 *  diff and is never sent. A reply has no lines and is never stale. */
export function isStaleDraft(c: { threadId?: string; reviewRound?: number }, review: Review | null | undefined): boolean {
  return !c.threadId && c.reviewRound != null && !!review && c.reviewRound < review.rounds.length;
}

/** Where a thread was opened. */
export function threadAnchor(th: ReviewThread): ReviewAnchor {
  return th.origin ?? { file: th.file, start_line: th.start_line, end_line: th.end_line };
}

/** The threads a review diff of `path` (dir-prefixed) draws. The latest round
 *  draws live threads where they are now; an older round draws the threads
 *  opened on it, moved back to where they were opened. */
export function threadsInView(review: Review, path: string, to: number | null): ReviewThread[] {
  const dir = review.dir_name ? `${review.dir_name}/` : "";
  if (to == null || to >= review.rounds.length) {
    return review.threads.filter(th => !th.outdated && dir + th.file === path);
  }
  return review.threads
    .filter(th => th.round === to && dir + threadAnchor(th).file === path)
    .map(th => ({ ...th, ...threadAnchor(th) }));
}
