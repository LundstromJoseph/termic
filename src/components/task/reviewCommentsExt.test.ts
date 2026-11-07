// @vitest-environment happy-dom
//
// GH #157: the gutter drifted out of step with the code, ~12px per review
// comment, cumulative. CodeMirror fills its height map from each block widget's
// BORDER BOX, so vertical margin on the element `toDOM` returns is space it
// never counts, and a widget that grows after being measured goes stale.
//
// No layout engine here, so these pin the structure that makes the geometry
// correct, not the geometry: the measured element keeps the card's spacing
// inside itself, and a growing composer re-syncs the height map. Real pixel
// alignment is the "review comment alignment" case in e2e/specs/git.e2e.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { reviewCommentsExtension, dispatchFileComment, dispatchSelectionComment } from "./reviewCommentsExt";
import { sendReviewComments, resolveReviewThread } from "@/lib/sendReviewComments";
import { useReviewComments } from "@/store/reviewComments";
import { useReviews } from "@/store/reviews";
import type { Review, ReviewThread } from "@/lib/types";

vi.mock("@/lib/sendReviewComments", () => ({
  sendReviewComments: vi.fn(async () => true),
  resolveReviewThread: vi.fn(async () => {}),
}));

const TASK = "task-157";
const FILE = "src/thing.ts";
const DOC = "one\ntwo\nthree\nfour\nfive\n";

let views: EditorView[] = [];

const EDITOR_SURFACE = { selection: "gutter", hoverGutter: false, source: "editor" } as const;

function mount(surface?: Parameters<typeof reviewCommentsExtension>[2]) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc: DOC,
    extensions: [reviewCommentsExtension(TASK, FILE, surface)],
  });
  views.push(view);
  return view;
}

/** storeSyncPlugin seeds on a microtask, and widgets mount on the next tick. */
const settle = () => new Promise(r => setTimeout(r, 0));

function addComment(line: number, body: string) {
  return useReviewComments.getState().add({
    taskId: TASK, file: FILE, startLine: line, endLine: line, quote: "x", body,
  });
}

/** The element CodeMirror measures for a widget: the shell we mounted it in. */
const measuredBox = (inner: Element) => inner.parentElement!;

/** happy-dom leaves unset lengths as "", which is 0 for our purposes. */
const px = (v: string) => parseFloat(v) || 0;

/**
 * Does this element hold a child's vertical margin inside its border box? We
 * use `flow-root`, but padding or any other block formatting context works too,
 * so assert the property rather than the implementation.
 */
function containsChildMargins(el: Element): boolean {
  const s = getComputedStyle(el);
  return ["flow-root", "flex", "grid", "table", "inline-block"].includes(s.display)
    || (s.overflow !== "" && s.overflow !== "visible")
    || px(s.paddingTop) > 0;
}

/** The invariant the gutter depends on, asserted on the element CM measures. */
function expectMeasuredBox(inner: Element, view: EditorView) {
  const box = measuredBox(inner);
  expect(box, "widget is not wrapped in a shell").not.toBe(view.contentDOM);
  expect(containsChildMargins(box), `${box.firstElementChild?.className} shell is not a BFC`).toBe(true);
  expect({ top: px(getComputedStyle(box).marginTop), bottom: px(getComputedStyle(box).marginBottom) })
    .toEqual({ top: 0, bottom: 0 });
}

beforeEach(() => {
  useReviewComments.getState().clear(TASK);
});

afterEach(() => {
  for (const v of views) v.destroy();
  views = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("review comment block widgets", () => {
  it("mounts a comment card in a measured box that owns its spacing", async () => {
    addComment(2, "look at this");
    const view = mount();
    await settle();

    const card = view.contentDOM.querySelector(".tc-comment-card");
    expect(card).toBeTruthy();
    expectMeasuredBox(card!, view);

    // Guards against passing vacuously: if the spacing were simply deleted, a
    // zero-margin measured box would prove nothing. The margin must still exist,
    // just contained.
    const s = getComputedStyle(card!);
    expect(px(s.marginTop)).toBeGreaterThan(0);
    expect(px(s.marginBottom)).toBeGreaterThan(0);
  });

  it("mounts the composer the same way", async () => {
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle();

    const composer = view.contentDOM.querySelector(".tc-comment-composer");
    expect(composer).toBeTruthy();
    expectMeasuredBox(composer!, view);
  });

  it("holds for every block widget once several comments stack up", async () => {
    // The reported case: drift was invisible at one comment and obvious at
    // three, so assert the invariant across all of them at once.
    addComment(1, "a");
    addComment(3, "b");
    addComment(5, "c");
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle();

    expect(view.contentDOM.querySelectorAll(".tc-comment-card")).toHaveLength(3);

    // Anything in the content column that is not a line is a block widget, so
    // this also catches a NEW widget added later without a shell.
    const blocks = Array.from(view.contentDOM.children).filter(el => !el.classList.contains("cm-line"));
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) expectMeasuredBox(b.firstElementChild!, view);
  });

  it("re-measures when the composer's textarea grows", async () => {
    // The other half of the fix: the textarea auto-grows past the height
    // CodeMirror measured on mount, which leaves a stale height in the map.
    const view = mount();
    await settle();
    dispatchFileComment(view);
    await settle(); // mount's own autoGrow has run by here

    const ta = view.contentDOM.querySelector<HTMLTextAreaElement>(".tc-comment-textarea")!;
    const requestMeasure = vi.spyOn(view, "requestMeasure");

    ta.value = "one\ntwo\nthree";
    ta.dispatchEvent(new Event("input"));

    expect(requestMeasure).toHaveBeenCalled();
  });
});

describe("composer payload", () => {
  /** Put a selection on lines 2-3 and open the composer on it. */
  function composeOnLines2to3(view: EditorView) {
    const from = view.state.doc.line(2).from;
    const to = view.state.doc.line(3).to;
    view.dispatch({ selection: { anchor: from, head: to } });
    return dispatchSelectionComment(view);
  }

  it("shows the selected code above the box, not just its line range", async () => {
    // The composer used to show "thing.ts · lines 2-3" and nothing else, so a
    // send looked like it was sending line numbers at a file the agent would
    // have to go read. The snippet that actually travels is on screen now.
    const view = mount(EDITOR_SURFACE);
    await settle();
    expect(composeOnLines2to3(view)).toBe(true);
    await settle();

    const quote = view.contentDOM.querySelector(".tc-comment-quote");
    expect(quote?.textContent).toBe("two\nthree");
    expect(view.contentDOM.querySelector(".tc-comment-loc")?.textContent).toContain("lines 2–3");
  });

  it("captures the exact selection, partial lines included", async () => {
    // Whole-line widening would send the agent code the user did not point at,
    // and show them a snippet that isn't the one they highlighted.
    const view = mount(EDITOR_SURFACE);
    await settle();
    view.dispatch({ selection: {
      anchor: view.state.doc.line(2).from + 1,   // "wo"
      head: view.state.doc.line(3).from + 3,     // "thr"
    } });
    dispatchSelectionComment(view);
    await settle();

    expect(view.contentDOM.querySelector(".tc-comment-quote")?.textContent).toBe("wo\nthr");
    view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();
    // Stored verbatim, with the line range that locates it.
    expect(useReviewComments.getState().byTask[TASK][0])
      .toMatchObject({ quote: "wo\nthr", startLine: 2, endLine: 3 });
  });

  it("omits the snippet for a whole-file comment", async () => {
    const view = mount(EDITOR_SURFACE);
    await settle();
    dispatchFileComment(view);
    await settle();
    expect(view.contentDOM.querySelector(".tc-comment-quote")).toBeNull();
  });

  it("tags a queued comment with the surface it was made on", async () => {
    for (const [surface, source] of [[EDITOR_SURFACE, "editor"], [undefined, "diff"]] as const) {
      useReviewComments.getState().clear(TASK);
      const view = mount(surface);
      await settle();
      composeOnLines2to3(view);
      await settle();

      const ta = view.contentDOM.querySelector<HTMLTextAreaElement>(".tc-comment-textarea")!;
      ta.value = "look";
      view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();

      const queued = useReviewComments.getState().byTask[TASK];
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ source, quote: "two\nthree", startLine: 2, endLine: 3 });
    }
  });

  it("queues a selection with no comment written on it", async () => {
    // "Look at this" is a whole thought. Bouncing focus back to an empty box
    // made the selection un-queueable without inventing something to say.
    const view = mount(EDITOR_SURFACE);
    await settle();
    composeOnLines2to3(view);
    await settle();

    view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();
    await settle();

    const queued = useReviewComments.getState().byTask[TASK];
    expect(queued).toHaveLength(1);
    expect(queued[0].body).toBe("");
    // The composer closed, and the card that replaced it says what it holds
    // rather than rendering as an empty box.
    expect(view.contentDOM.querySelector(".tc-comment-textarea")).toBeNull();
    expect(view.contentDOM.querySelector(".tc-comment-card")?.textContent).toContain("Selection only");
  });

  it("still refuses an empty whole-file comment, which would say nothing", async () => {
    const view = mount(EDITOR_SURFACE);
    await settle();
    dispatchFileComment(view);
    await settle();

    view.contentDOM.querySelector<HTMLButtonElement>(".tc-btn-queue")!.click();
    await settle();

    expect(useReviewComments.getState().byTask[TASK] ?? []).toHaveLength(0);
    expect(view.contentDOM.querySelector(".tc-comment-textarea")).toBeTruthy();
  });
});

describe("selection gutter", () => {
  it("floats over the line numbers instead of widening the editor", () => {
    // A column that appears when you select and vanishes when you don't would
    // shove every line sideways mid-selection. Float mode is what prevents it,
    // and only the diff pane (button on every hovered line) keeps a real column.
    const editor = mount(EDITOR_SURFACE);
    const diff = mount();
    const gutterOf = (v: EditorView) => v.dom.querySelector(".tc-comment-gutter")!;
    expect(gutterOf(editor).classList.contains("tc-comment-gutter-float")).toBe(true);
    expect(gutterOf(diff).classList.contains("tc-comment-gutter-float")).toBe(false);
  });

  it("labels the button on hover with no browser delay, and cleans up after itself", async () => {
    const view = mount(EDITOR_SURFACE);
    await settle();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from, head: view.state.doc.line(2).to } });
    await settle();

    const btn = view.dom.querySelector<HTMLElement>(".tc-line-add-btn");
    expect(btn, "no comment button for a standing selection").toBeTruthy();
    // `title` would be the browser's tooltip: ~1s of stillness, by which point
    // the selection this button belongs to is usually gone.
    expect(btn!.hasAttribute("title")).toBe(false);
    expect(btn!.getAttribute("aria-label")).toBe("Send selection to agent");

    btn!.dispatchEvent(new Event("mouseenter"));
    expect(view.dom.querySelector(".tc-instant-tip")?.textContent).toBe("Send selection to agent");

    btn!.dispatchEvent(new Event("mouseleave"));
    expect(view.dom.querySelector(".tc-instant-tip")).toBeNull();

    // A tip left open when the button is torn down (selection cleared, editor
    // closed) would hang over the code with nothing to dismiss it.
    btn!.dispatchEvent(new Event("mouseenter"));
    view.dispatch({ selection: { anchor: 0 } });
    await settle();
    expect(view.dom.querySelector(".tc-instant-tip")).toBeNull();
  });
});

describe("agent-presented review threads in a review: diff", () => {
  const REVIEW = "r1";

  function thread(id: string, file: string, lines: [number, number] | null, ...by: ("agent" | "user")[]): ReviewThread {
    return {
      id, file, start_line: lines?.[0] ?? null, end_line: lines?.[1] ?? null, quote: lines ? "x" : "",
      comments: by.map((b, i) => ({ seq: i + 1, by: b, author: b === "agent" ? "claude" : "", body: `${b} ${i}`, at: "" })),
    };
  }

  function putReview(seq: number, threads: ReviewThread[], dirName = "") {
    const review: Review = {
      version: 1, id: REVIEW, task_id: TASK, dir_name: dirName, base: "a", head: "b", base_ref: "main",
      head_ref: "HEAD", title: null, author: "claude", recipient_tab: null, created_at: "", seq,
      files: [FILE], files_truncated: false, threads,
    };
    useReviews.getState().apply(TASK, review);
  }

  function mountReview(file = FILE) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      doc: DOC,
      extensions: [reviewCommentsExtension(TASK, file, undefined, REVIEW)],
    });
    views.push(view);
    return view;
  }

  const cards = (view: EditorView) => Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".tc-thread-card"));
  const authors = (card: HTMLElement) =>
    Array.from(card.querySelectorAll(".tc-thread-author")).map(e => e.textContent);

  beforeEach(() => {
    useReviews.setState({ byKey: {}, idsByTask: {}, awaiting: {}, loaded: {}, shown: {} });
  });

  it("renders each of this file's threads as a card with an author line per comment, the user as You", async () => {
    putReview(3, [
      thread("r1-t1", FILE, [2, 3], "agent", "user"),
      thread("r1-t2", "src/other.ts", [1, 1], "agent"),
    ]);

    const view = mountReview();
    await settle();

    const [card, ...rest] = cards(view);
    expect(rest).toHaveLength(0);
    expect(card.dataset.threadId).toBe("r1-t1");
    expect(authors(card)).toEqual(["claude", "You"]);
    expect(Array.from(card.querySelectorAll(".tc-comment-body")).map(e => e.textContent)).toEqual(["agent 0", "user 1"]);
    expect(view.contentDOM.querySelectorAll(".tc-commented-line")).toHaveLength(2);
    expectMeasuredBox(card, view);
  });

  it("puts a file-level thread above the first line", async () => {
    putReview(1, [thread("r1-t1", FILE, null, "agent")]);

    const view = mountReview();
    await settle();

    const first = view.contentDOM.firstElementChild!;
    expect(first.querySelector(".tc-thread-card")?.getAttribute("data-thread-id")).toBe("r1-t1");
    expect(view.contentDOM.querySelectorAll(".tc-commented-line")).toHaveLength(0);
  });

  it("matches a member repo's threads by the review's dir_name prefix", async () => {
    putReview(1, [thread("r1-t1", FILE, [1, 1], "agent")], "api");

    const atRoot = mountReview(FILE);
    const inMember = mountReview(`api/${FILE}`);
    await settle();

    expect(cards(atRoot)).toHaveLength(0);
    expect(cards(inMember)).toHaveLength(1);
  });

  const draftCards = (view: EditorView) =>
    Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".tc-comment-card:not(.tc-thread-card)"));
  const clickReply = (view: EditorView, threadId: string) =>
    view.contentDOM.querySelector<HTMLButtonElement>(`[data-thread-id="${threadId}"] .tc-btn-reply`)!.click();
  const typeAndClick = (view: EditorView, body: string, btn: string) => {
    view.contentDOM.querySelector<HTMLTextAreaElement>(".tc-comment-textarea")!.value = body;
    view.contentDOM.querySelector<HTMLButtonElement>(btn)!.click();
  };

  it("shows only this review's drafts, never a plain draft or another review's", async () => {
    addComment(2, "plain draft");
    useReviewComments.getState().add({ taskId: TASK, file: FILE, startLine: 3, endLine: 3, quote: "x", body: "mine", reviewId: REVIEW });
    useReviewComments.getState().add({ taskId: TASK, file: FILE, startLine: 3, endLine: 3, quote: "x", body: "r2's", reviewId: "r2" });
    putReview(1, [thread("r1-t1", FILE, [4, 4], "agent")]);

    const view = mountReview();
    await settle();

    expect(draftCards(view).map(c => c.querySelector(".tc-comment-body")!.textContent)).toEqual(["mine"]);
  });

  it("keeps a review draft out of the plain diff of the same file", async () => {
    useReviewComments.getState().add({ taskId: TASK, file: FILE, startLine: 3, endLine: 3, quote: "x", body: "mine", reviewId: REVIEW });

    const view = mount();
    await settle();

    expect(draftCards(view)).toHaveLength(0);
  });

  it("offers the selection pill and the line gutter, so a new thread can start on any line", async () => {
    const view = mountReview();
    await settle();
    view.dispatch({ selection: { anchor: view.state.doc.line(1).from, head: view.state.doc.line(2).to } });
    await settle();

    expect(view.dom.querySelector(".tc-comment-gutter")).not.toBeNull();
    expect(view.dom.querySelector(".tc-add-comment-btn")).not.toBeNull();
  });

  it("queues a new thread with the review id and no thread id", async () => {
    const view = mountReview();
    await settle();
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from, head: view.state.doc.line(3).to } });
    dispatchSelectionComment(view);
    await settle();

    typeAndClick(view, "split this", ".tc-btn-queue");

    expect(useReviewComments.getState().byTask[TASK]).toEqual([expect.objectContaining({
      file: FILE, startLine: 2, endLine: 3, quote: "two\nthree", body: "split this", reviewId: REVIEW, threadId: undefined,
    })]);
  });

  it("opens a Reply composer under the thread, and its pending card stacks between the thread and a new composer", async () => {
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent")]);
    const view = mountReview();
    await settle();

    clickReply(view, "r1-t1");
    await settle();
    expect(view.contentDOM.querySelector(".tc-comment-composer .tc-comment-loc")?.textContent).toBe("Reply to r1-t1 · thing.ts · line 2");
    typeAndClick(view, "it was flaky", ".tc-btn-queue");
    await settle();
    clickReply(view, "r1-t1");
    await settle();

    expect(useReviewComments.getState().byTask[TASK]).toEqual([expect.objectContaining({
      body: "it was flaky", reviewId: REVIEW, threadId: "r1-t1", startLine: 2, endLine: 2,
    })]);
    const order = Array.from(view.contentDOM.querySelectorAll(".tc-thread-card, .tc-comment-card, .tc-comment-composer"))
      .filter((e, i, all) => !all.some((o, j) => j !== i && o.contains(e) && o !== e))
      .map(e => e.classList.contains("tc-thread-card") ? "thread" : e.classList.contains("tc-comment-composer") ? "composer" : "draft");
    expect(order).toEqual(["thread", "draft", "composer"]);
    expect(draftCards(view)[0].querySelector(".tc-comment-loc")?.textContent).toBe("Pending reply to r1-t1 · thing.ts · line 2");
  });

  it("stacks a reply to the first of two file-level threads above line 1 as threads, then its draft, then a new composer, each naming its thread", async () => {
    putReview(1, [thread("r1-t1", FILE, null, "agent"), thread("r1-t2", FILE, null, "agent")]);
    const view = mountReview();
    await settle();

    clickReply(view, "r1-t1");
    await settle();
    typeAndClick(view, "first", ".tc-btn-queue");
    await settle();
    clickReply(view, "r1-t1");
    await settle();

    const order = Array.from(view.contentDOM.querySelectorAll(".tc-thread-card, .tc-comment-card, .tc-comment-composer"))
      .filter((e, i, all) => !all.some((o, j) => j !== i && o.contains(e) && o !== e))
      .map(e => e.classList.contains("tc-thread-card") ? e.getAttribute("data-thread-id") : e.classList.contains("tc-comment-composer") ? "composer" : "draft");
    expect(order).toEqual(["r1-t1", "r1-t2", "draft", "composer"]);
    expect(draftCards(view)[0].querySelector(".tc-comment-loc")?.textContent).toBe("Pending reply to r1-t1 · thing.ts · whole file");
    expect(view.contentDOM.querySelector(".tc-comment-composer .tc-comment-loc")?.textContent).toBe("Reply to r1-t1 · thing.ts · whole file");
  });

  it("puts a sent reply back as a pending review draft when the post is refused", async () => {
    vi.mocked(sendReviewComments).mockResolvedValueOnce(false);
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent")]);
    const view = mountReview();
    await settle();
    clickReply(view, "r1-t1");
    await settle();

    typeAndClick(view, "too long", ".tc-btn-send");
    await settle();

    expect(useReviewComments.getState().byTask[TASK]).toEqual([expect.objectContaining({
      body: "too long", reviewId: REVIEW, threadId: "r1-t1", startLine: 2, endLine: 2,
    })]);
  });

  it("refuses an empty review comment even with a quote, and sends a written one through sendReviewComments", async () => {
    vi.mocked(sendReviewComments).mockClear();
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent")]);
    const view = mountReview();
    await settle();
    clickReply(view, "r1-t1");
    await settle();

    typeAndClick(view, "  ", ".tc-btn-send");
    typeAndClick(view, "", ".tc-btn-queue");
    const stillOpen = !!view.contentDOM.querySelector(".tc-comment-textarea");
    typeAndClick(view, "ship it", ".tc-btn-send");

    expect(stillOpen).toBe(true);
    expect(useReviewComments.getState().byTask[TASK] ?? []).toHaveLength(0);
    expect(vi.mocked(sendReviewComments).mock.calls).toEqual([[TASK, REVIEW, [expect.objectContaining({
      body: "ship it", threadId: "r1-t1", reviewId: REVIEW,
    })]]]);
  });

  it("grows an open card live when a reply lands in the store", async () => {
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent")]);
    const view = mountReview();
    await settle();

    putReview(2, [thread("r1-t1", FILE, [2, 2], "agent", "user")]);
    await settle();

    expect(authors(cards(view)[0])).toEqual(["claude", "You"]);
  });

  const resolvedBy = (th: ReviewThread, by: "agent" | "user"): ReviewThread =>
    ({ ...th, resolved: { by, author: by === "agent" ? "claude" : "", at: "" } });
  const stripedLines = (view: EditorView) => view.contentDOM.querySelectorAll(".tc-commented-line").length;

  it("mounts a resolved thread collapsed behind a Resolved chip naming who resolved it, with no line stripe", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 3], "agent"), "agent")]);
    const view = mountReview();
    await settle();

    const card = cards(view)[0];
    expect(card.dataset.resolved).toBe("true");
    expect(card.dataset.collapsed).toBe("true");
    expect(card.querySelector(".tc-thread-chip")?.textContent).toBe("Resolved");
    expect(card.querySelector<HTMLElement>(".tc-thread-chip")?.title).toBe("Resolved by claude");
    expect(card.querySelector(".tc-thread-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(card.querySelector(".tc-btn-resolve")?.textContent).toBe("Unresolve");
    expect(stripedLines(view)).toBe(0);
  });

  it("names the user as You in a user-resolved thread's chip title", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "user")]);
    const view = mountReview();
    await settle();

    expect(cards(view)[0].querySelector<HTMLElement>(".tc-thread-chip")?.title).toBe("Resolved by You");
  });

  it("expands and collapses a resolved thread from its location toggle by rebuilding the card", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "user")]);
    const view = mountReview();
    await settle();
    const first = cards(view)[0];
    const toggle = () => cards(view)[0].querySelector<HTMLButtonElement>(".tc-thread-toggle")!;
    const read = () => ({
      collapsed: cards(view)[0].dataset.collapsed, expanded: toggle().getAttribute("aria-expanded"), text: toggle().textContent,
    });

    toggle().click();
    const opened = { ...read(), rebuilt: cards(view)[0] !== first };
    toggle().click();

    expect(opened).toEqual({ collapsed: "false", expanded: "true", text: "▾ thing.ts · line 2", rebuilt: true });
    expect(read()).toEqual({ collapsed: "true", expanded: "false", text: "▸ thing.ts · line 2" });
  });

  it("keeps a thread expanded across a push that grows it, and collapses it again after a reopen and re-resolve", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "user")]);
    const view = mountReview();
    await settle();
    cards(view)[0].querySelector<HTMLButtonElement>(".tc-thread-toggle")!.click();

    putReview(2, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent", "user"), "user")]);
    await settle();
    const afterGrow = cards(view)[0].dataset.collapsed;
    putReview(3, [thread("r1-t1", FILE, [2, 2], "agent", "user")]);
    await settle();
    putReview(4, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent", "user"), "user")]);
    await settle();

    expect(afterGrow).toBe("false");
    expect(cards(view)[0].dataset.collapsed).toBe("true");
  });

  it("resolves an open thread and reopens a resolved one through resolveReviewThread, never through a send", async () => {
    vi.mocked(resolveReviewThread).mockClear();
    vi.mocked(sendReviewComments).mockClear();
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent"), resolvedBy(thread("r1-t2", FILE, [4, 4], "agent"), "user")]);
    const view = mountReview();
    await settle();
    const resolveBtn = (id: string) => view.contentDOM.querySelector<HTMLButtonElement>(`[data-thread-id="${id}"] .tc-btn-resolve`)!;

    const openLabel = resolveBtn("r1-t1").textContent;
    resolveBtn("r1-t1").click();
    resolveBtn("r1-t2").click();
    await settle();

    expect(openLabel).toBe("Resolve");
    expect(vi.mocked(resolveReviewThread).mock.calls).toEqual([[TASK, "r1-t1", true], [TASK, "r1-t2", false]]);
    expect(sendReviewComments).not.toHaveBeenCalled();
  });

  it("keeps focus where it was when the resolve button or toggle is pressed", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "user")]);
    const view = mountReview();
    await settle();
    const card = cards(view)[0];

    const pressed = [".tc-btn-resolve", ".tc-thread-toggle"].map(sel => {
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      card.querySelector(sel)!.dispatchEvent(e);
      return e.defaultPrevented;
    });

    expect(pressed).toEqual([true, true]);
  });

  it("hands focus to the tab host when the toggle is pressed from the keyboard, as the card it sits on is rebuilt", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "user")]);
    const view = mountReview();
    await settle();
    const host = view.dom.parentElement!;
    host.dataset.mainTabId = "tab-1";
    host.tabIndex = -1;
    const toggle = cards(view)[0].querySelector<HTMLButtonElement>(".tc-thread-toggle")!;
    toggle.focus();

    toggle.click();

    expect(toggle.isConnected).toBe(false);
    expect(document.activeElement).toBe(host);
  });

  it("expands a collapsed resolved thread when Reply is pressed on it, with the composer open under it", async () => {
    putReview(1, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "user")]);
    const view = mountReview();
    await settle();

    clickReply(view, "r1-t1");
    await settle();

    expect(cards(view)[0].dataset.collapsed).toBe("false");
    expect(view.contentDOM.querySelector(".tc-comment-composer .tc-comment-loc")?.textContent).toBe("Reply to r1-t1 · thing.ts · line 2");
  });

  it("rebuilds the card and its stripe when a push resolves or reopens a thread with no new comment", async () => {
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent")]);
    const view = mountReview();
    await settle();
    const openStripes = stripedLines(view);

    putReview(2, [resolvedBy(thread("r1-t1", FILE, [2, 2], "agent"), "agent")]);
    await settle();
    const resolvedState = { resolved: cards(view)[0].dataset.resolved, stripes: stripedLines(view) };
    putReview(3, [thread("r1-t1", FILE, [2, 2], "agent")]);
    await settle();

    expect(openStripes).toBe(1);
    expect(resolvedState).toEqual({ resolved: "true", stripes: 0 });
    expect(cards(view)[0].dataset.resolved).toBe("false");
    expect(stripedLines(view)).toBe(1);
  });

  it("does not dispatch when a push leaves this file's threads unchanged", async () => {
    putReview(1, [thread("r1-t1", FILE, [2, 2], "agent"), thread("r1-t2", "src/other.ts", [1, 1], "agent")]);
    const view = mountReview();
    await settle();
    const dispatch = vi.spyOn(view, "dispatch");

    putReview(2, [thread("r1-t1", FILE, [2, 2], "agent"), thread("r1-t2", "src/other.ts", [1, 1], "agent", "user")]);
    await settle();

    expect(dispatch).not.toHaveBeenCalled();
  });
});
