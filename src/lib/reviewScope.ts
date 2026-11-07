// A review diff's scope string and which threads it draws. `review:<id>`
// follows the review's latest round; `review:<id>:to:<N>` pins an older round
// and draws only the threads opened on it, at the anchor they were opened on.

import type { Review, ReviewAnchor, ReviewThread } from "./types";

export interface ParsedReviewScope {
  reviewId: string;
  /** Always null until the From/To picker lands. */
  from: number | null;
  /** Null follows the latest round. */
  to: number | null;
}

export function parseReviewScope(scope?: string | null): ParsedReviewScope | null {
  const m = scope?.match(/^review:(r[1-9]\d*)(?::to:([1-9]\d*))?$/);
  return m ? { reviewId: m[1], from: null, to: m[2] ? Number(m[2]) : null } : null;
}

/** The scope of round `to` of `review`; the latest round is the plain form. */
export function reviewScope(review: Review, to: number | null): `review:${string}` {
  return to == null || to >= review.rounds.length ? `review:${review.id}` : `review:${review.id}:to:${to}`;
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
