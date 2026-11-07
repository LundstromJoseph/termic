// @vitest-environment happy-dom
//
// foldAt and the a-side mapping lean on @codemirror/merge internals (the fold
// widget's type string, a copy of its mapPos). These run against the real
// package, so an upgrade that moves either fails here instead of leaving the
// thread list's reveal landing on a fold bar.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { foldAt, revealThread } from "./revealThread";
import { reviewCommentsExtension } from "./reviewCommentsExt";
import { useReviews } from "@/store/reviews";
import type { Review, ReviewThread } from "@/lib/types";

vi.mock("@/lib/sendReviewComments", () => ({
  sendReviewComments: vi.fn(async () => true),
  resolveReviewThread: vi.fn(async () => {}),
}));

const ORIGINAL = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
const MODIFIED = ORIGINAL.replace("line 190", "line 190 changed");
const COLLAPSE = { margin: 3, minSize: 6 };

let destroy: (() => void)[] = [];
afterEach(() => { destroy.forEach(d => d()); destroy = []; });

function parent() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function unified() {
  const view = new EditorView({
    parent: parent(),
    doc: MODIFIED,
    extensions: [unifiedMergeView({ original: ORIGINAL, collapseUnchanged: COLLAPSE })],
  });
  destroy.push(() => view.destroy());
  return view;
}

function thread(id: string, start: number | null, end: number | null = start, resolved = false): ReviewThread {
  return {
    id, file: "f.txt", start_line: start, end_line: end, quote: "", round: 1,
    comments: [{ seq: 1, by: "agent", author: "claude", body: "b", at: "", round: 1 }],
    ...(resolved ? { resolved: { by: "agent" as const, author: "claude", at: "" } } : {}),
  };
}

const lineFrom = (view: EditorView, n: number) => view.state.doc.line(n).from;

describe("foldAt", () => {
  it("finds the unchanged-lines fold covering line 20 and none on the changed line 190", () => {
    const view = unified();

    const at20 = foldAt(view.state, lineFrom(view, 20));
    const at190 = foldAt(view.state, lineFrom(view, 190));

    expect(at20).toBe(0);
    expect(at190).toBeNull();
  });
});

describe("revealThread", () => {
  it("removes the fold a line thread sits in and reports that it scrolled", () => {
    const view = unified();

    const scrolled = revealThread(view, thread("r1-t1", 20));

    expect(scrolled).toBe(true);
    expect(foldAt(view.state, lineFrom(view, 20))).toBeNull();
  });

  it("removes the matching fold on both panes of a side-by-side MergeView", () => {
    const mv = new MergeView({
      parent: parent(),
      a: { doc: ORIGINAL },
      b: { doc: MODIFIED },
      collapseUnchanged: COLLAPSE,
    });
    destroy.push(() => mv.destroy());
    const before = { a: foldAt(mv.a.state, lineFrom(mv.a, 20)), b: foldAt(mv.b.state, lineFrom(mv.b, 20)) };

    revealThread(mv.b, thread("r1-t1", 20));

    expect(before).toEqual({ a: 0, b: 0 });
    expect(foldAt(mv.a.state, lineFrom(mv.a, 20))).toBeNull();
    expect(foldAt(mv.b.state, lineFrom(mv.b, 20))).toBeNull();
  });

  it("returns false and dispatches nothing for an open file-level thread", () => {
    const view = unified();
    const dispatch = vi.spyOn(view, "dispatch");

    const scrolled = revealThread(view, thread("r1-t1", null));

    expect(scrolled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("clamps an end line past the end of the doc instead of throwing", () => {
    const view = unified();

    const scrolled = revealThread(view, thread("r1-t1", 198, 9999));

    expect(scrolled).toBe(true);
  });
});

describe("revealThread on a resolved thread's card", () => {
  const TASK = "task-reveal";
  const FILE = "f.txt";

  beforeEach(() => {
    useReviews.setState({ byKey: {}, idsByTask: {}, awaiting: {}, loaded: {}, shown: {} });
  });

  async function mountWithResolvedThread() {
    const th = thread("r1-t1", 2, 2, true);
    const review: Review = {
      version: 1, id: "r1", task_id: TASK, dir_name: "", base: "a", head: "b", base_ref: "main",
      head_ref: "HEAD", title: null, author: "claude", recipient_tab: null, created_at: "", seq: 1,
      files: [FILE], files_truncated: false, threads: [th], rounds: [],
    };
    useReviews.getState().apply(TASK, review);
    const view = new EditorView({
      parent: parent(),
      doc: "one\ntwo\nthree\n",
      extensions: [reviewCommentsExtension(TASK, FILE, undefined, "r1")],
    });
    destroy.push(() => view.destroy());
    await new Promise(r => setTimeout(r, 0));
    const collapsed = () => view.contentDOM.querySelector<HTMLElement>(".tc-thread-card")?.dataset.collapsed;
    return { view, th, collapsed };
  }

  it("expands the collapsed card, and a second reveal leaves it expanded", async () => {
    const { view, th, collapsed } = await mountWithResolvedThread();
    const before = collapsed();

    revealThread(view, th);
    const afterFirst = collapsed();
    revealThread(view, th);

    expect(before).toBe("true");
    expect(afterFirst).toBe("false");
    expect(collapsed()).toBe("false");
  });
});
