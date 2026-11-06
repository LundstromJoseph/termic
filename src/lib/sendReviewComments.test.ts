// @vitest-environment happy-dom
//
// The user's side of an agent-presented review, against the REAL stores: post
// to the review file first, then deliver to the review's own agent tab through
// its queue. A missing recipient or a failed delivery never loses a comment.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyAlive: vi.fn().mockResolvedValue(true),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetTabPreviousSessionId: vi.fn().mockResolvedValue(undefined),
  detectClis: vi.fn().mockResolvedValue([]),
  reviewList: vi.fn().mockResolvedValue([]),
  reviewPost: vi.fn(),
}));
vi.mock("@/lib/tabFocus", () => ({ focusTerminalTab: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/agentSend", () => ({ deliverMessage: vi.fn().mockResolvedValue(undefined) }));

import { sendReviewComments, sendPendingComments } from "@/lib/sendReviewComments";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { useReviews } from "@/store/reviews";
import { deliverMessage } from "@/lib/agentSend";
import { reviewPost } from "@/lib/ipc";
import { focusTerminalTab } from "@/lib/tabFocus";
import type { ReviewComment } from "@/store/reviewComments";
import type { Review, ReviewPostItem, ReviewPostResult, Task, Tab, TerminalTab } from "@/lib/types";

function review(over: Partial<Review> = {}): Review {
  return {
    version: 1, id: "r1", task_id: "ws1", dir_name: "api", base: "aaaaaaa1", head: "bbbbbbb2", base_ref: "main",
    head_ref: "HEAD", title: "Split", author: "claude", recipient_tab: "t-rev", created_at: "", seq: 1,
    files: ["src/a.ts"], files_truncated: false,
    threads: [{ id: "r1-t1", file: "src/a.ts", start_line: 2, end_line: 2, quote: "beta",
      comments: [{ seq: 1, by: "agent", author: "claude", body: "why?", at: "" }] }],
    ...over,
  };
}

/** What Rust answers: the posted items appended as user comments. */
function answer(items: ReviewPostItem[], over: Partial<Review> = {}): ReviewPostResult {
  const r = review(over);
  const threads = r.threads.map(t => ({ ...t, comments: [...t.comments] }));
  const posted = items.map((it, i) => {
    const seq = r.seq + 1 + i;
    const c = { seq, by: "user" as const, author: "", body: it.body, at: "" };
    if (it.thread_id) {
      threads.find(t => t.id === it.thread_id)!.comments.push(c);
      return { thread_id: it.thread_id, seq, new_thread: false };
    }
    const id = `r1-t${threads.length + 1}`;
    threads.push({ id, file: it.file!, start_line: it.start_line, end_line: it.end_line, quote: it.quote ?? "", comments: [c] });
    return { thread_id: id, seq, new_thread: true };
  });
  return { review: { ...r, seq: r.seq + items.length, threads }, posted };
}

const REPLY: ReviewComment = {
  id: "c-reply", taskId: "ws1", file: "api/src/a.ts", startLine: 2, endLine: 2, quote: "", body: "it was flaky",
  source: "diff", reviewId: "r1", threadId: "r1-t1",
};
const NEW_THREAD: ReviewComment = {
  id: "c-new", taskId: "ws1", file: "api/src/a.ts", startLine: 4, endLine: 5, quote: "delta\nepsilon", body: "rename",
  source: "diff", reviewId: "r1",
};
const PLAIN: ReviewComment = {
  id: "c-plain", taskId: "ws1", file: "src/b.ts", startLine: 1, endLine: 1, quote: "x", body: "plain one", source: "diff",
};

function seed(revAgent: Record<string, unknown> | null = {}) {
  useApp.setState({
    tasks: [{ id: "ws1", project_id: "p1", name: "fix-auth", cli: "claude", archived: false, persisted_tabs: [] } as unknown as Task],
    tabs: {
      ws1: [
        { id: "t-main", type: "terminal", cli: "claude", title: "main", is_default: true, ptyId: "pty-main" } as unknown as Tab,
        ...(revAgent ? [{ id: "t-rev", type: "terminal", cli: "claude", title: "reviewer", ptyId: "pty-rev", ...revAgent } as unknown as Tab] : []),
        { id: "t-edit", type: "edit", path: "src/a.ts", title: "a.ts" } as unknown as Tab,
      ],
    },
    activeTab: { ws1: "t-edit" },
    mountedTasks: new Set(["ws1"]),
    agents: [{ id: "claude", name: "Claude Code", disabled: false }],
    detectedClis: {},
  } as never);
  useReviews.setState({ byKey: {}, idsByTask: {}, awaiting: {}, loaded: {}, shown: {} });
  useReviews.getState().apply("ws1", review());
}

const toasts = () => useUI.getState().toasts.map(t => ({ msg: t.msg, kind: t.kind }));
const tab = (id: string) => useApp.getState().tabs.ws1.find(t => t.id === id) as TerminalTab;

describe("sendReviewComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUI.setState({ toasts: [] });
    vi.mocked(reviewPost).mockImplementation(async (_t, _r, items) => answer(items));
  });

  it("posts replies and new threads with the member prefix stripped, then delivers one message to the review's tab", async () => {
    seed();

    const ok = await sendReviewComments("ws1", "r1", [REPLY, NEW_THREAD]);

    expect(ok).toBe(true);
    expect(vi.mocked(reviewPost).mock.calls[0]).toEqual(["ws1", "r1", [
      { thread_id: "r1-t1", file: null, start_line: null, end_line: null, quote: null, body: "it was flaky" },
      { thread_id: null, file: "src/a.ts", start_line: 4, end_line: 5, quote: "delta\nepsilon", body: "rename" },
    ]]);
    expect(deliverMessage).toHaveBeenCalledTimes(1);
    const [pty, text] = vi.mocked(deliverMessage).mock.calls[0];
    expect(pty).toBe("pty-rev");
    expect(text).toContain("(thread r1-t1)");
    expect(text).toContain("(thread r1-t2, new thread)");
    expect(text).toContain("present reply <thread>");
    expect(toasts()).toEqual([{ msg: "Sent 2 comments to reviewer", kind: "success" }]);
  });

  it("applies the posted review to the store, so the thread shows the reply before any push", async () => {
    seed();

    await sendReviewComments("ws1", "r1", [REPLY]);

    const stored = useReviews.getState().byKey["ws1/r1"];
    expect(stored.seq).toBe(2);
    expect(stored.threads[0].comments.map(c => c.by)).toEqual(["agent", "user"]);
  });

  it("queues behind a mid-turn recipient and never moves the user's tab or focus", async () => {
    seed({ workState: "working" });

    await sendReviewComments("ws1", "r1", [REPLY]);

    expect(deliverMessage).not.toHaveBeenCalled();
    expect(tab("t-rev").queue).toHaveLength(1);
    expect(useApp.getState().activeTab.ws1).toBe("t-edit");
    expect(focusTerminalTab).not.toHaveBeenCalled();
    expect(toasts()).toEqual([{ msg: "Queued 1 comment for reviewer. It goes in when the agent is free.", kind: "success" }]);
  });

  it("keeps the comment saved and points at claim when the recipient tab is gone", async () => {
    seed(null);

    const ok = await sendReviewComments("ws1", "r1", [REPLY]);

    expect(ok).toBe(true);
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(toasts()).toEqual([{
      msg: "Saved to review r1. It has no live agent tab: run termic present claim r1 from one to receive it.", kind: "warning",
    }]);
  });

  it("returns false and toasts when the review file refuses the post", async () => {
    seed();
    vi.mocked(reviewPost).mockRejectedValueOnce("line 9 is past the end of src/a.ts");

    const ok = await sendReviewComments("ws1", "r1", [NEW_THREAD]);

    expect(ok).toBe(false);
    expect(deliverMessage).not.toHaveBeenCalled();
    expect(toasts()).toEqual([{ msg: "Could not save to review r1: line 9 is past the end of src/a.ts", kind: "error" }]);
  });

  it("still returns true when the delivery fails after the post, since the comment is saved", async () => {
    seed();
    vi.mocked(deliverMessage).mockRejectedValueOnce(new Error("pty gone"));

    const ok = await sendReviewComments("ws1", "r1", [REPLY]);

    expect(ok).toBe(true);
    expect(toasts()).toEqual([{ msg: "Saved to review r1, but reviewer could not be reached.", kind: "error" }]);
  });
});

describe("sendPendingComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUI.setState({ toasts: [] });
    vi.mocked(reviewPost).mockImplementation(async (_t, _r, items) => answer(items));
  });

  it("sends plain comments to the picked tab and review comments to the review's tab, one message each", async () => {
    seed();

    const sent = await sendPendingComments("ws1", [PLAIN, REPLY, NEW_THREAD], "t-main");

    expect(sent.sort()).toEqual(["c-new", "c-plain", "c-reply"]);
    const calls = vi.mocked(deliverMessage).mock.calls.map(([pty, text]) => ({ pty, text }));
    expect(calls).toHaveLength(2);
    expect(calls[0].pty).toBe("pty-main");
    expect(calls[0].text).toContain("plain one");
    expect(calls[0].text).not.toContain("r1-t1");
    expect(calls[1].pty).toBe("pty-rev");
    expect(calls[1].text).toContain("it was flaky");
    expect(calls[1].text).not.toContain("plain one");
  });

  it("returns only the ids that left, so a refused review group stays pending", async () => {
    seed();
    vi.mocked(reviewPost).mockRejectedValueOnce("refused");

    const sent = await sendPendingComments("ws1", [PLAIN, REPLY], "t-main");

    expect(sent).toEqual(["c-plain"]);
  });
});
