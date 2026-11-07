// @vitest-environment happy-dom
//
// `termic present`: the CLI server writes the review file, then pushes the
// whole review through `review_changed`. Driven through the REAL handler
// against the REAL stores.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  tasksList: vi.fn().mockResolvedValue([]),
  detectClis: vi.fn().mockResolvedValue([]),
  reviewList: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn(), focusMainTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { reviewChangedHandler } from "@/lib/reviewsCli";
import { useApp } from "@/store/app";
import { useReviews } from "@/store/reviews";
import { useUI } from "@/store/ui";
import type { Review, Task } from "@/lib/types";

function review(seq: number, over: Partial<Review> = {}): Review {
  return {
    version: 1, id: "r1", task_id: "a", dir_name: "", base: "a", head: "b", base_ref: "main", head_ref: "HEAD",
    title: "Tidy the parser", author: "claude", recipient_tab: "tab-1", created_at: "", seq, files: ["a.ts"],
    files_truncated: false, threads: [], rounds: [], ...over,
  };
}

beforeEach(() => {
  useApp.setState({
    tasks: [{ id: "a", project_id: "p1", name: "a", archived: false } as Task],
    activeTaskId: null,
    rightPanelHidden: true,
  });
  useReviews.setState({ byKey: {}, idsByTask: {}, awaiting: {}, loaded: {}, shown: {} });
  useUI.setState({ reviewReveal: null, toasts: [] });
});

describe("reviewChangedHandler", () => {
  it("with reveal: mirrors the review, shows it in Compare, requests the reveal and toasts, without switching task or un-hiding the panel", async () => {
    const r = await reviewChangedHandler({ taskId: "a", review: review(0), reveal: true });

    expect(r).toBeNull();
    expect(useReviews.getState().byKey["a/r1"].seq).toBe(0);
    expect(useReviews.getState().shown.a).toBe("r1");
    expect(useUI.getState().reviewReveal).toMatchObject({ taskId: "a", reviewId: "r1" });
    const [toast] = useUI.getState().toasts;
    expect(toast.msg).toBe("claude opened a review: Tidy the parser");
    expect(useApp.getState().activeTaskId).toBeNull();
    expect(useApp.getState().rightPanelHidden).toBe(true);
  });

  it("names an untitled review by its id in the toast", async () => {
    await reviewChangedHandler({ taskId: "a", review: review(0, { title: null }), reveal: true });

    expect(useUI.getState().toasts[0].msg).toBe("claude opened review r1");
  });

  it("says a review with a second round started that round, titled or not", async () => {
    const round = { base: "a", head: "b", base_ref: "main", head_ref: "HEAD", at: "" };

    await reviewChangedHandler({ taskId: "a", review: review(1, { rounds: [round, round] }), reveal: true });
    await reviewChangedHandler({ taskId: "a", review: review(2, { title: null, rounds: [round, round] }), reveal: true });

    expect(useUI.getState().toasts.map(t => t.msg)).toEqual([
      "claude started round 2 of Tidy the parser",
      "claude started round 2 of review r1",
    ]);
  });

  it("the toast's Open un-hides the right panel, activates the task and reveals the review again", async () => {
    await reviewChangedHandler({ taskId: "a", review: review(0), reveal: true });
    useReviews.getState().setShown("a", null);
    useUI.getState().clearReviewReveal();

    useUI.getState().toasts[0].action!.onClick();

    expect(useApp.getState().rightPanelHidden).toBe(false);
    expect(useApp.getState().activeTaskId).toBe("a");
    expect(useReviews.getState().shown.a).toBe("r1");
    expect(useUI.getState().reviewReveal).toMatchObject({ taskId: "a", reviewId: "r1" });
  });

  it("without reveal: mirrors the review and neither reveals nor toasts", async () => {
    await reviewChangedHandler({ taskId: "a", review: review(1) });

    expect(useReviews.getState().byKey["a/r1"].seq).toBe(1);
    expect(useReviews.getState().shown.a).toBeUndefined();
    expect(useUI.getState().reviewReveal).toBeNull();
    expect(useUI.getState().toasts).toEqual([]);
  });

  it("a stale push leaves the reviews store untouched", async () => {
    await reviewChangedHandler({ taskId: "a", review: review(2) });
    const before = useReviews.getState();

    await reviewChangedHandler({ taskId: "a", review: review(1) });

    expect(useReviews.getState()).toBe(before);
  });

  it("refuses params without a taskId or a review with an id and seq", async () => {
    for (const bad of [null, {}, { taskId: "a" }, { taskId: "", review: review(0) }, { taskId: "a", review: { id: "r1" } }]) {
      await expect(reviewChangedHandler(bad)).rejects.toThrow("review_changed requires a taskId and a review");
    }
  });
});
