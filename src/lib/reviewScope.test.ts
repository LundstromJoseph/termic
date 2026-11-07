// Which round a review diff shows, and which threads it draws there.
import { describe, it, expect } from "vitest";
import { parseReviewScope, reviewScope, threadAnchor, threadsInView } from "./reviewScope";
import type { Review, ReviewRound, ReviewThread } from "./types";

const ROUND: ReviewRound = { base: "a", head: "b", base_ref: "main", head_ref: "HEAD", at: "" };

function review(rounds: number, threads: ReviewThread[], dir = ""): Review {
  return {
    version: 1, id: "r1", task_id: "t", dir_name: dir, base: "a", head: "b", base_ref: "main", head_ref: "HEAD",
    title: null, author: "claude", recipient_tab: null, created_at: "", seq: 1, files: [], files_truncated: false,
    threads, rounds: Array.from({ length: rounds }, () => ROUND),
  };
}

function thread(id: string, file: string, line: number | null, extra: Partial<ReviewThread> = {}): ReviewThread {
  return { id, file, start_line: line, end_line: line, quote: "", comments: [], round: 1, ...extra };
}

describe("parseReviewScope / reviewScope", () => {
  it("reads the plain form as the latest round and the to form as that round", () => {
    expect(parseReviewScope("review:r1")).toEqual({ reviewId: "r1", from: null, to: null });
    expect(parseReviewScope("review:r12:to:3")).toEqual({ reviewId: "r12", from: null, to: 3 });
    for (const bad of [undefined, null, "base:abc", "review:r1:to:0", "review:r1:to:", "review:x", "review:r1:from:1"]) {
      expect(parseReviewScope(bad), String(bad)).toBeNull();
    }
  });

  it("builds the plain form for the latest round so the tab follows new rounds, and round trips an older one", () => {
    const r = review(3, []);

    expect(reviewScope(r, null)).toBe("review:r1");
    expect(reviewScope(r, 3)).toBe("review:r1");
    expect(parseReviewScope(reviewScope(r, 2))).toEqual({ reviewId: "r1", from: null, to: 2 });
  });
});

describe("threadsInView", () => {
  const moved = thread("r1-t1", "b.ts", 12, { origin: { file: "a.ts", start_line: 10, end_line: 10 } });
  const outdated = thread("r1-t2", "a.ts", 3, { outdated: 2 });
  const later = thread("r1-t3", "b.ts", 5, { round: 2 });

  it("draws live threads at their current anchor in the latest round and leaves outdated ones out", () => {
    const r = review(2, [moved, outdated, later], "api");

    expect(threadsInView(r, "api/b.ts", null).map(t => t.id)).toEqual(["r1-t1", "r1-t3"]);
    expect(threadsInView(r, "api/a.ts", null)).toEqual([]);
    expect(threadsInView(r, "b.ts", null), "the member dir prefixes the path").toEqual([]);
  });

  it("draws an older round's own threads, outdated included, at the anchor they were opened on", () => {
    const r = review(2, [moved, outdated, later]);

    const inA = threadsInView(r, "a.ts", 1);

    expect(inA.map(t => [t.id, t.file, t.start_line])).toEqual([["r1-t1", "a.ts", 10], ["r1-t2", "a.ts", 3]]);
    expect(threadsInView(r, "b.ts", 1), "a later round's thread and a moved one's new file stay out").toEqual([]);
  });

  it("threadAnchor is the origin when the thread moved and its own anchor otherwise", () => {
    expect(threadAnchor(moved)).toEqual({ file: "a.ts", start_line: 10, end_line: 10 });
    expect(threadAnchor(later)).toEqual({ file: "b.ts", start_line: 5, end_line: 5 });
  });
});
