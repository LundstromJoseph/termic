// The review-comment composer and card, as framework-free DOM. Two surfaces
// host them: the CodeMirror review extension (as block widgets, see
// reviewCommentsExt) and the rendered markdown preview (in slots it places
// after the commented block, see previewComments). Both write the same
// reviewComments store, so the boxes own the store calls and the host only
// says where they go and what happens when one closes. Styles are the
// `.tc-comment-*` rules in index.css.

import { i18n } from "@/lib/i18n";
import { useReviewComments, type ReviewComment } from "@/store/reviewComments";
import { sendCommentsToAgent } from "@/lib/sendComments";
import { sendReviewComments } from "@/lib/sendReviewComments";
import type { ReviewThread } from "@/lib/types";

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`panels:reviewExt.${key}`, opts);

function locLabel(start: number | null, end: number | null, file: string): string {
  const base = file.split("/").pop() || file;
  if (start == null) return t("locWholeFile", { file: base });
  if (end != null && end !== start) return t("locLines", { file: base, start, end });
  return t("locLine", { file: base, start });
}

/** Where a comment goes: the task, its file, and the surface that made it
 *  (decides how the batch is worded to the agent, see composeCommentsMessage).
 *  `reviewId` when the file is a `review:` diff: the comment joins that review,
 *  written on its iteration `reviewIteration`. `drawIteration` is the iteration whose head the
 *  view shows, which differs from `reviewIteration` on a pinned older iteration. */
export interface CommentTarget {
  taskId: string;
  file: string;
  source: "diff" | "editor";
  reviewId?: string;
  reviewIteration?: number;
  drawIteration?: number;
}

/** A comment being written. `id` is set when it edits a queued one, and
 *  `threadId` when it replies to a review thread. */
export interface ComposerSpec {
  id?: string;
  threadId?: string;
  startLine: number | null;
  endLine: number | null;
  quote: string;
  body: string;
}

// lucide `send` — the same glyph the pending-comments bar puts on its Send
// button, so "this goes to the agent now" looks the same everywhere.
const SEND_ICON_SVG =
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>` +
  `<path d="m21.854 2.147-10.94 10.939"/></svg>`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

export function buildComposer(spec: ComposerSpec, target: CommentTarget, host: {
  /** The composer is done. `sent` = the comment went to the agent. A send
   *  never takes focus, so the host refocuses itself either way. */
  onClose: (sent: boolean) => void;
  /** The box changed height after mounting (the textarea grew). */
  onResize?: () => void;
}): HTMLElement {
  const wrap = el("div", "tc-comment-composer");
  const loc = locLabel(spec.startLine, spec.endLine, target.file);
  const label = spec.threadId ? t("reply", { thread: spec.threadId, loc }) : loc;
  wrap.appendChild(el("div", "tc-comment-loc", label));
  // A review comment is a message in a thread, so it needs words. The
  // selection-only send of a plain comment has no thread to land in.
  const review = target.reviewId;

  // The selected code, shown as the first "message" in the box. It always
  // travelled with the comment (composeCommentsMessage fences it), but the
  // composer only ever showed a line range, so the send looked like it was
  // sending line numbers. Now the payload is on screen before you commit to
  // it, and the comment below is plainly the second half of the message.
  const quote = spec.quote.replace(/\n+$/, "");
  if (quote) wrap.appendChild(el("div", "tc-comment-quote", quote));

  const ta = el("textarea", "tc-comment-textarea");
  // Send takes the selection with an empty body, so say so rather than
  // implying a comment is required.
  ta.placeholder = quote && !review ? t("placeholderOptional") : t("placeholder");
  ta.value = spec.body;
  // Rough starting height (no layout yet, so `scrollHeight` is 0 here) to
  // keep an edit composer from mounting at one line and popping open a frame
  // later; `autoGrow` corrects for wrapping once it is in the document.
  ta.rows = Math.min(spec.body.split("\n").length, 8);
  ta.spellcheck = false;
  ta.autocapitalize = "off";
  ta.setAttribute("autocorrect", "off");
  wrap.appendChild(ta);

  // Grow with content (Shift+Enter newlines) up to a cap.
  const autoGrow = () => {
    ta.style.height = "auto";
    // border-box, and scrollHeight leaves the borders out: sizing to it alone
    // left the box 2px short of its text, which overflowed into scrollbars
    // (visible once zoom or a classic-scrollbar setting shows them). Scroll
    // only once the cap is actually reached.
    const borders = ta.offsetHeight - ta.clientHeight;
    let want = ta.scrollHeight + borders;
    ta.style.height = `${Math.min(want, 220)}px`;
    // At a fractional devicePixelRatio (Windows at 125%) the borders snap to
    // device pixels and the integer measurements above miss one: top up
    // whatever the text still overflows by.
    want += Math.max(0, ta.scrollHeight - ta.clientHeight);
    ta.style.height = `${Math.min(want, 220)}px`;
    ta.style.overflowY = want > 220 ? "auto" : "hidden";
    host.onResize?.();
  };
  ta.addEventListener("input", autoGrow);

  // Two ways out, because a remark on code is sometimes the whole thought
  // and sometimes one of five. "Add to pending" queues it with the rest;
  // "Send" (the accent CTA) ships this one immediately, and the comment body
  // is OPTIONAL there — the selected code alone is a legitimate message.
  // Editing an existing queued comment offers Update only: it is already in
  // the queue, and the bar is where a queue gets sent.
  const editing = !!spec.id;

  const commit = () => {
    const body = ta.value.trim();
    // The selection IS the message; a comment is something you may add to
    // it. So only a comment with nothing in it at all — no quote either,
    // i.e. an empty whole-file remark — has nothing to queue, and that is
    // the one case worth bouncing back to the box.
    if (!body && (!quote || review)) { ta.focus(); return; }
    const store = useReviewComments.getState();
    if (spec.id) store.update(target.taskId, spec.id, body);
    else store.add({ ...target, startLine: spec.startLine, endLine: spec.endLine, quote: spec.quote, body, threadId: spec.threadId });
    host.onClose(false);
  };
  const sendNow = () => {
    const body = ta.value.trim();
    if (review && !body) { ta.focus(); return; }
    const draft: ReviewComment = {
      ...target, id: spec.id ?? "draft", startLine: spec.startLine, endLine: spec.endLine, quote: spec.quote, body,
      threadId: spec.threadId,
    };
    // The composer closes before the post resolves, so a refused post puts
    // the text back as a pending draft rather than losing it to a toast.
    if (review) void sendReviewComments(target.taskId, review, [draft]).then(ok => {
      if (!ok) useReviewComments.getState().add({ ...target, startLine: spec.startLine, endLine: spec.endLine, quote: spec.quote, body, threadId: spec.threadId });
    });
    else void sendCommentsToAgent(target.taskId, [draft], { label });
    host.onClose(true);
  };
  const cancel = () => host.onClose(false);

  const row = el("div", "tc-comment-actions");
  row.appendChild(el("span", "tc-comment-hint", t("hint")));
  row.appendChild(button("tc-btn tc-btn-ghost tc-btn-cancel", i18n.t("common:cancel"), cancel));
  row.appendChild(button("tc-btn tc-btn-ghost tc-btn-queue", editing ? t("update") : t("addToPending"), commit));
  if (!editing) {
    const send = button("tc-btn tc-btn-primary tc-btn-send", "", sendNow);
    send.innerHTML = SEND_ICON_SVG;
    send.appendChild(el("span", "", t("send")));
    send.title = t("sendNowTip");
    row.appendChild(send);
  }
  wrap.appendChild(row);

  ta.addEventListener("keydown", (e) => {
    // Enter takes the accent action (send now), Shift+Enter inserts a
    // newline — chat-composer muscle memory, and the CTA is what Enter
    // should mean. Editing a queued comment has no send button, so there
    // Enter still updates it in place.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (editing) commit(); else sendNow();
    }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    e.stopPropagation(); // keep keystrokes out of the host's keymap
  });

  setTimeout(() => {
    // The composer can mount outside the visible viewport (a file-level
    // comment anchors at doc start). Reveal it before focusing: focus() on an
    // off-screen child of a scroller does not scroll it in.
    wrap.scrollIntoView({ block: "nearest" });
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    autoGrow();
  }, 0);
  return wrap;
}

export function buildCard(comment: ReviewComment, onEdit: () => void): HTMLElement {
  const wrap = el("div", "tc-comment-card");
  const head = el("div", "tc-comment-card-head");
  const loc = locLabel(comment.startLine, comment.endLine, comment.file);
  head.appendChild(el("span", "tc-comment-loc", comment.threadId ? t("pendingReply", { thread: comment.threadId, loc }) : loc));
  const tools = el("div", "tc-comment-tools");
  const edit = button("tc-icon-btn", i18n.t("common:edit"), onEdit);
  edit.title = t("editComment");
  tools.appendChild(edit);
  const del = button("tc-icon-btn tc-icon-btn-danger", i18n.t("common:delete"),
    () => useReviewComments.getState().remove(comment.taskId, comment.id));
  del.title = t("deleteComment");
  tools.appendChild(del);
  head.appendChild(tools);
  wrap.appendChild(head);

  // A queued selection with no remark on it is legitimate (the code is the
  // message), but an empty card looks broken. Say what it is instead; the
  // quote itself is right above, in the file.
  const body = comment.body.trim();
  wrap.appendChild(el("div", body ? "tc-comment-body" : "tc-comment-body tc-comment-body-empty",
    body || i18n.t("panels:reviewBar.selectionOnly")));
  return wrap;
}

/** One thread of an agent-presented review: its location, then every comment
 *  in order under an author line (the agent's name, or "You"). A resolved
 *  thread shows only its header unless `expanded`, with a toggle on the
 *  location. The host owns `expanded` and rebuilds the card to change it. */
export function buildThreadCard(thread: ReviewThread, expanded: boolean, host: {
  onReply: () => void;
  onResolve: (resolved: boolean) => Promise<void>;
  onToggle: () => void;
}): HTMLElement {
  const wrap = el("div", "tc-comment-card tc-thread-card");
  wrap.dataset.threadId = thread.id;
  wrap.dataset.resolved = String(!!thread.resolved);
  const head = el("div", "tc-comment-card-head");
  const loc = locLabel(thread.start_line, thread.end_line, thread.file);
  const resolved = thread.resolved;
  const lead = el("span", "");
  if (resolved) {
    wrap.dataset.collapsed = String(!expanded);
    const toggle = steadyButton("tc-comment-loc tc-thread-toggle", `${expanded ? "▾" : "▸"} ${loc}`, host.onToggle);
    toggle.setAttribute("aria-expanded", String(expanded));
    lead.appendChild(toggle);
    const chip = el("span", "tc-thread-chip", t("resolved"));
    chip.title = t("resolvedBy", { who: resolved.by === "user" ? t("you") : resolved.author });
    lead.appendChild(chip);
  } else {
    lead.appendChild(el("span", "tc-comment-loc", loc));
  }
  if (thread.outdated) {
    const chip = el("span", "tc-thread-chip tc-thread-chip-outdated", t("outdatedIn", { n: thread.outdated }));
    chip.title = t("outdatedTip", { iteration: thread.iteration });
    lead.appendChild(chip);
  }
  head.appendChild(lead);
  const tools = el("div", "tc-comment-tools");
  tools.appendChild(button("tc-icon-btn tc-btn-reply", t("replyAction"), host.onReply));
  const resolve = steadyButton("tc-icon-btn tc-btn-resolve", resolved ? t("unresolveAction") : t("resolveAction"), () => {
    resolve.disabled = true;
    void host.onResolve(!resolved).finally(() => { resolve.disabled = false; });
  });
  tools.appendChild(resolve);
  head.appendChild(tools);
  wrap.appendChild(head);
  for (const c of thread.comments) {
    const entry = el("div", "tc-thread-entry");
    entry.dataset.by = c.by;
    entry.appendChild(el("div", "tc-thread-author", c.by === "user" ? t("you") : c.author));
    entry.appendChild(el("div", "tc-comment-body", c.body));
    wrap.appendChild(entry);
  }
  return wrap;
}

/** A button whose press leaves focus in the pane. Its card is rebuilt by the
 *  press, and a focused button that leaves the DOM drops focus to <body>,
 *  which takes ⌘W and pane switching with it. A mouse press never takes
 *  focus; a keyboard press hands it to the tab host before the card goes. */
function steadyButton(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = button(cls, text, () => {
    if (b.ownerDocument.activeElement === b) {
      b.closest<HTMLElement>("[data-main-tab-id], [data-split-leaf]")?.focus({ preventScroll: true });
    }
    onClick();
  });
  b.addEventListener("mousedown", e => e.preventDefault());
  return b;
}
