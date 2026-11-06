import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({ reviewList: vi.fn() }));

import { useReviews, resetReviewsLoaded } from "@/store/reviews";
import * as ipc from "@/lib/ipc";
import type { Review, ReviewThread } from "@/lib/types";

function thread(id: string, ...by: ("agent" | "user")[]): ReviewThread {
  return {
    id, file: "a.ts", start_line: 1, end_line: 1, quote: "x",
    comments: by.map((b, i) => ({ seq: i + 1, by: b, author: b === "agent" ? "claude" : "", body: "b", at: "" })),
  };
}

function review(id: string, seq: number, over: Partial<Review> = {}): Review {
  return {
    version: 1, id, task_id: "t1", dir_name: "", base: "a", head: "b", base_ref: "main", head_ref: "HEAD",
    title: null, author: "claude", recipient_tab: "tab-1", created_at: "", seq, files: ["a.ts"],
    files_truncated: false, threads: [], ...over,
  };
}

beforeEach(() => {
  useReviews.setState({ byKey: {}, idsByTask: {}, awaiting: {}, loaded: {}, shown: {} });
  resetReviewsLoaded();
  vi.mocked(ipc.reviewList).mockReset();
});

describe("useReviews.apply", () => {
  it("stores a new review and lists its id under the task", () => {
    useReviews.getState().apply("t1", review("r1", 0));

    const s = useReviews.getState();
    expect(s.byKey["t1/r1"].id).toBe("r1");
    expect(s.idsByTask.t1).toEqual(["r1"]);
  });

  it("returns the same state for an equal or older seq with the same recipient and author", () => {
    useReviews.getState().apply("t1", review("r1", 3));
    const before = useReviews.getState();

    useReviews.getState().apply("t1", review("r1", 3));
    useReviews.getState().apply("t1", review("r1", 2));

    expect(useReviews.getState()).toBe(before);
  });

  it("ignores an older review with a different recipient that lands after a claim (late review_list)", () => {
    useReviews.getState().apply("t1", review("r1", 3, { recipient_tab: "tab-2", author: "codex" }));
    const before = useReviews.getState();

    useReviews.getState().apply("t1", review("r1", 2, { recipient_tab: "tab-1", author: "claude" }));

    expect(useReviews.getState()).toBe(before);
  });

  it("lists a new id in numeric order when a push lands ahead of the list", () => {
    useReviews.getState().apply("t1", review("r10", 0));
    useReviews.getState().apply("t1", review("r2", 0));
    useReviews.getState().setList("t1", [review("r1", 0), review("r2", 0), review("r10", 0)]);

    expect(useReviews.getState().idsByTask.t1).toEqual(["r1", "r2", "r10"]);
  });

  it("keeps the id list's identity when an existing review updates", () => {
    useReviews.getState().apply("t1", review("r1", 0));
    const ids = useReviews.getState().idsByTask;

    useReviews.getState().apply("t1", review("r1", 1));

    expect(useReviews.getState().idsByTask).toBe(ids);
  });

  it("counts awaiting threads across the task's reviews: those whose last comment is the agent's", () => {
    useReviews.getState().apply("t1", review("r1", 3, { threads: [thread("r1-t1", "agent"), thread("r1-t2", "agent", "user")] }));
    useReviews.getState().apply("t1", review("r2", 2, { threads: [thread("r2-t1", "user", "agent")] }));
    useReviews.getState().apply("t2", review("r1", 1, { threads: [thread("r1-t1", "agent")] }));

    expect(useReviews.getState().awaiting).toEqual({ t1: 2, t2: 1 });
  });
});

describe("useReviews.setList", () => {
  it("applies every review and marks the task loaded", () => {
    useReviews.getState().setList("t1", [review("r1", 0), review("r2", 0)]);

    const s = useReviews.getState();
    expect(s.idsByTask.t1).toEqual(["r1", "r2"]);
    expect(s.loaded.t1).toBe(true);
  });

  it("returns the same state when the task is loaded and nothing is newer", () => {
    useReviews.getState().setList("t1", [review("r1", 2)]);
    const before = useReviews.getState();

    useReviews.getState().setList("t1", [review("r1", 2)]);

    expect(useReviews.getState()).toBe(before);
  });
});

describe("useReviews.ensureLoaded", () => {
  it("calls review_list once per task however often it is asked, and stores the result", async () => {
    vi.mocked(ipc.reviewList).mockResolvedValue([review("r1", 0)]);

    useReviews.getState().ensureLoaded("t1");
    useReviews.getState().ensureLoaded("t1");
    await vi.waitFor(() => expect(useReviews.getState().loaded.t1).toBe(true));
    useReviews.getState().ensureLoaded("t1");

    expect(ipc.reviewList).toHaveBeenCalledTimes(1);
    expect(useReviews.getState().idsByTask.t1).toEqual(["r1"]);
  });

  it("asks again after a failed load", async () => {
    vi.mocked(ipc.reviewList).mockRejectedValueOnce(new Error("io")).mockResolvedValue([]);

    useReviews.getState().ensureLoaded("t1");
    await vi.waitFor(() => {
      useReviews.getState().ensureLoaded("t1");
      expect(ipc.reviewList).toHaveBeenCalledTimes(2);
    });
  });
});

describe("useReviews.setShown", () => {
  it("returns the same state when the shown review is unchanged, null matching absent", () => {
    const before = useReviews.getState();

    useReviews.getState().setShown("t1", null);
    expect(useReviews.getState()).toBe(before);

    useReviews.getState().setShown("t1", "r1");
    const shown = useReviews.getState();
    useReviews.getState().setShown("t1", "r1");
    expect(useReviews.getState()).toBe(shown);
    expect(shown.shown.t1).toBe("r1");
  });
});
