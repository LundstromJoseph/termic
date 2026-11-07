// Mirror of the task's agent-presented reviews (data-model.md, "Review").
// Rust owns the file; this store only ever holds what a `review_changed`
// push, `review_list`, `review_post` or `review_resolve` handed it. Separate from useApp so a
// comment landing does not copy useApp's state and re-run every selector.

import { create } from "zustand";
import { reviewList } from "@/lib/ipc";
import type { Review } from "@/lib/types";

const reviewKey = (taskId: string, reviewId: string) => `${taskId}/${reviewId}`;

export interface ReviewsState {
  byKey: Record<string, Review>;
  idsByTask: Record<string, string[]>;
  /** Open threads whose last comment is the agent's, across the task's reviews. */
  awaiting: Record<string, number>;
  loaded: Record<string, true>;
  /** The review Compare shows for a task; null or absent is branch compare. */
  shown: Record<string, string | null>;
  apply: (taskId: string, review: Review) => void;
  setList: (taskId: string, reviews: Review[]) => void;
  ensureLoaded: (taskId: string) => void;
  setShown: (taskId: string, reviewId: string | null) => void;
}

type Data = Pick<ReviewsState, "byKey" | "idsByTask" | "awaiting">;

const reviewNumber = (id: string) => Number(id.slice(1));

/** `s` itself when the review's seq is not newer, so the caller can bail
 *  without notifying (bear trap 8). Rust bumps seq on every change, claims
 *  and resolves included, so seq alone orders a push against a late `review_list`. */
function merge<S extends Data>(s: S, taskId: string, review: Review): S {
  const k = reviewKey(taskId, review.id);
  const old = s.byKey[k];
  if (old && old.seq >= review.seq) return s;
  const byKey = { ...s.byKey, [k]: review };
  const ids = s.idsByTask[taskId] ?? [];
  // By number, as `review_list` sorts: a push can land before the list does.
  const at = ids.findIndex(id => reviewNumber(id) > reviewNumber(review.id));
  const idsByTask = old
    ? s.idsByTask
    : { ...s.idsByTask, [taskId]: at < 0 ? [...ids, review.id] : [...ids.slice(0, at), review.id, ...ids.slice(at)] };
  let count = 0;
  for (const id of idsByTask[taskId]) {
    for (const t of byKey[reviewKey(taskId, id)].threads) {
      if (!t.resolved && t.comments[t.comments.length - 1]?.by === "agent") count++;
    }
  }
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
  apply: (taskId, review) => set(s => merge(s, taskId, review)),
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

/** Forget which tasks were fetched. Tests only. */
export function resetReviewsLoaded() {
  requested.clear();
}
