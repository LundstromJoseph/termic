// Mirror of the task's agent-presented reviews (data-model.md, "Review").
// Rust owns the file; this store only ever holds what a `review_changed`
// push, `review_list`, `review_post` or `review_resolve` handed it, less what
// a deletion took out. Separate from useApp so a
// comment landing does not copy useApp's state and re-run every selector.

import { create } from "zustand";
import { reviewList } from "@/lib/ipc";
import type { Review } from "@/lib/types";
import type { ReviewView } from "@/lib/reviewScope";

const reviewKey = (taskId: string, reviewId: string) => `${taskId}/${reviewId}`;

export interface ReviewsState {
  byKey: Record<string, Review>;
  idsByTask: Record<string, string[]>;
  /** Open threads whose last comment is the agent's, across the task's reviews. */
  awaiting: Record<string, number>;
  loaded: Record<string, true>;
  /** The review Compare shows for a task; null or absent is branch compare. */
  shown: Record<string, string | null>;
  /** The viewer's From/To pick per review, for this session only, with the
   *  iteration count it was made at: a new iteration drops it (`effectiveView`). */
  view: Record<string, ReviewView & { iterations: number }>;
  apply: (taskId: string, review: Review) => void;
  /** Drops a deleted review, and with it Compare's pick of it. */
  remove: (taskId: string, reviewId: string) => void;
  setList: (taskId: string, reviews: Review[]) => void;
  ensureLoaded: (taskId: string) => void;
  setShown: (taskId: string, reviewId: string | null) => void;
  setView: (taskId: string, reviewId: string, from: number | null, to: number | null, iterations: number) => void;
}

type Data = Pick<ReviewsState, "byKey" | "idsByTask" | "awaiting">;

const reviewNumber = (id: string) => Number(id.slice(1));

/** Keys of reviews deleted this session. Ids are never reused, so a review
 *  that arrives here again is a stale copy (a `review_list` sent before the
 *  delete) and is never stored. */
const deleted = new Set<string>();

function countAwaiting(byKey: Record<string, Review>, taskId: string, ids: readonly string[]): number {
  let count = 0;
  for (const id of ids) {
    for (const t of byKey[reviewKey(taskId, id)].threads) {
      if (!t.resolved && t.comments[t.comments.length - 1]?.by === "agent") count++;
    }
  }
  return count;
}

/** `s` itself when the review's seq is not newer, so the caller can bail
 *  without notifying (bear trap 8). Rust bumps seq on every change, claims
 *  and resolves included, so seq alone orders a push against a late `review_list`. */
function merge<S extends Data>(s: S, taskId: string, review: Review): S {
  const k = reviewKey(taskId, review.id);
  const old = s.byKey[k];
  if (deleted.has(k) || (old && old.seq >= review.seq)) return s;
  const byKey = { ...s.byKey, [k]: review };
  const ids = s.idsByTask[taskId] ?? [];
  // By number, as `review_list` sorts: a push can land before the list does.
  const at = ids.findIndex(id => reviewNumber(id) > reviewNumber(review.id));
  const idsByTask = old
    ? s.idsByTask
    : { ...s.idsByTask, [taskId]: at < 0 ? [...ids, review.id] : [...ids.slice(0, at), review.id, ...ids.slice(at)] };
  const count = countAwaiting(byKey, taskId, idsByTask[taskId]);
  const awaiting = s.awaiting[taskId] === count ? s.awaiting : { ...s.awaiting, [taskId]: count };
  return { ...s, byKey, idsByTask, awaiting };
}

/** Tasks whose list was requested this session, so a remount does not refetch. */
const requested = new Set<string>();

export const useReviews = create<ReviewsState>((set, get) => ({
  byKey: {},
  idsByTask: {},
  awaiting: {},
  loaded: {},
  shown: {},
  view: {},
  apply: (taskId, review) => set(s => merge(s, taskId, review)),
  remove: (taskId, reviewId) => set(s => {
    const k = reviewKey(taskId, reviewId);
    deleted.add(k);
    const stored = k in s.byKey;
    const shown = s.shown[taskId] === reviewId;
    const picked = k in s.view;
    if (!stored && !shown && !picked) return s;
    const next: Partial<ReviewsState> = {};
    if (stored) {
      const { [k]: _gone, ...byKey } = s.byKey;
      const ids = (s.idsByTask[taskId] ?? []).filter(id => id !== reviewId);
      const count = countAwaiting(byKey, taskId, ids);
      next.byKey = byKey;
      next.idsByTask = { ...s.idsByTask, [taskId]: ids };
      if (s.awaiting[taskId] !== count) next.awaiting = { ...s.awaiting, [taskId]: count };
    }
    if (shown) next.shown = { ...s.shown, [taskId]: null };
    if (picked) {
      const { [k]: _pick, ...view } = s.view;
      next.view = view;
    }
    return next;
  }),
  setList: (taskId, reviews) => set(s => {
    const next = reviews.reduce((acc, r) => merge(acc, taskId, r), s);
    return next.loaded[taskId] ? next : { ...next, loaded: { ...next.loaded, [taskId]: true } };
  }),
  ensureLoaded: taskId => {
    if (requested.has(taskId)) return;
    requested.add(taskId);
    reviewList(taskId).then(
      reviews => get().setList(taskId, reviews),
      () => requested.delete(taskId),
    );
  },
  setShown: (taskId, reviewId) => set(s =>
    (s.shown[taskId] ?? null) === reviewId ? s : { shown: { ...s.shown, [taskId]: reviewId } }),
  setView: (taskId, reviewId, from, to, iterations) => set(s => {
    const k = reviewKey(taskId, reviewId);
    const o = s.view[k];
    return o && o.from === from && o.to === to && o.iterations === iterations ? s : { view: { ...s.view, [k]: { from, to, iterations } } };
  }),
}));

export const EMPTY_REVIEW_IDS: readonly string[] = Object.freeze([]);

export const selectTaskReviewIds = (taskId: string) => (s: ReviewsState): readonly string[] =>
  s.idsByTask[taskId] ?? EMPTY_REVIEW_IDS;
export const selectReview = (taskId: string, reviewId: string | null) => (s: ReviewsState): Review | null =>
  (reviewId ? s.byKey[reviewKey(taskId, reviewId)] ?? null : null);
export const selectAwaiting = (taskId: string) => (s: ReviewsState): number => s.awaiting[taskId] ?? 0;

export const useTaskReviewIds = (taskId: string) => useReviews(selectTaskReviewIds(taskId));
export const useReview = (taskId: string, reviewId: string | null) => useReviews(selectReview(taskId, reviewId));
export const useAwaiting = (taskId: string) => useReviews(selectAwaiting(taskId));

/** Forget which tasks were fetched and which reviews were deleted. Tests only. */
export function resetReviewsLoaded() {
  requested.clear();
  deleted.clear();
}
