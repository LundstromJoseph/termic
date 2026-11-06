// Pending inline review comments — PR-style feedback the user leaves on a
// diff/file, batched and then sent into an agent's PTY in one message
// (GH issue #28). Kept in its own transient store (like ui.ts) so adding a
// comment doesn't churn the task tree, and so the data survives tab
// switches (a DiffPane unmounts its CodeMirror view when you leave the tab,
// but the comments must persist until sent).
//
// A comment is anchored to a file path + a 1-based line range, plus the
// quoted source text at that range. The quote is what makes this robust:
// if the agent has since edited the file, line numbers drift but the quoted
// snippet stays greppable, so the agent can still locate the spot.

import { create } from "zustand";

export interface ReviewComment {
  id: string;
  /** Owning task. Comments are scoped per task. */
  taskId: string;
  /** Repo-relative file path (matches DiffTab.path / EditTab.path). */
  file: string;
  /** 1-based inclusive line range the comment targets. Null for a
   *  file-level comment (no specific lines — "comment on the whole file"). */
  startLine: number | null;
  endLine: number | null;
  /** The text the user actually selected, verbatim, captured once and never
   *  re-read. Partial lines included: if they highlighted half of line 40,
   *  that half is the quote. Empty for file-level comments. This is both what
   *  the composer shows and the drift-proof context the agent gets, so it must
   *  keep saying what the user pointed at even after the file moves under it
   *  (only the line numbers follow the code, see reanchor). */
  quote: string;
  /** The user's feedback. */
  body: string;
  /** Where the comment was made. A diff is a review surface, so a batch off
   *  one is announced as review feedback ("I reviewed your changes..."). A
   *  source file is not: there the user is pointing at code they are reading,
   *  which is not a review of anything, and the framing would be a lie. Absent
   *  = diff (the original surface). */
  source?: "diff" | "editor";
  /** Set when the comment was written in a `review:<id>` diff: it is posted
   *  to that review and goes to the review's agent, not the bar's pick. */
  reviewId?: string;
  /** A reply to this thread of `reviewId`; absent opens a new thread. */
  threadId?: string;
}

/** A comment-in-progress: range + quote captured, body not yet written.
 *  Lives separately from the committed list so an open composer doesn't
 *  count toward the pending total or get sent. */
export interface DraftComment {
  taskId: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
  quote: string;
}

interface ReviewCommentsState {
  /** Committed comments, keyed by task id. */
  byTask: Record<string, ReviewComment[]>;

  add: (c: Omit<ReviewComment, "id">) => string;
  update: (taskId: string, id: string, body: string) => void;
  /** Re-point a comment at where its code ended up. Called by the editor as
   *  it maps the original selection through edits (lib/commentAnchors.ts), so
   *  a comment made on line 12 still says 12 after three lines are typed above
   *  it. Moves the LOCATOR only: the quote stays exactly what was selected. */
  reanchor: (taskId: string, id: string, at: { startLine: number; endLine: number }) => void;
  remove: (taskId: string, id: string) => void;
  removeMany: (taskId: string, ids: readonly string[]) => void;
  clear: (taskId: string) => void;
}

export const useReviewComments = create<ReviewCommentsState>((set) => ({
  byTask: {},

  add: (c) => {
    const id = crypto.randomUUID();
    set((s) => ({
      byTask: { ...s.byTask, [c.taskId]: [...(s.byTask[c.taskId] ?? []), { ...c, id }] },
    }));
    return id;
  },

  update: (taskId, id, body) =>
    set((s) => ({
      byTask: {
        ...s.byTask,
        [taskId]: (s.byTask[taskId] ?? []).map((c) => (c.id === id ? { ...c, body } : c)),
      },
    })),

  reanchor: (taskId, id, at) =>
    set((s) => {
      const list = s.byTask[taskId];
      if (!list?.some((c) => c.id === id)) return s;
      return {
        byTask: {
          ...s.byTask,
          [taskId]: list.map((c) =>
            c.id === id ? { ...c, startLine: at.startLine, endLine: at.endLine } : c),
        },
      };
    }),

  remove: (taskId, id) =>
    set((s) => ({
      byTask: { ...s.byTask, [taskId]: (s.byTask[taskId] ?? []).filter((c) => c.id !== id) },
    })),

  removeMany: (taskId, ids) =>
    set((s) => {
      const list = s.byTask[taskId] ?? [];
      const next = list.filter((c) => !ids.includes(c.id));
      return next.length === list.length ? s : { byTask: { ...s.byTask, [taskId]: next } };
    }),

  clear: (taskId) =>
    set((s) => {
      if (!s.byTask[taskId]?.length) return s;
      const next = { ...s.byTask };
      delete next[taskId];
      return { byTask: next };
    }),
}));

/** Stable empty array so the per-task selector doesn't return a fresh
 *  reference each render (see docs/gotchas.md — Zustand selector trap). */
const EMPTY: ReviewComment[] = [];

/** Subscribe to one task's pending comments. */
export function useTaskComments(taskId: string): ReviewComment[] {
  return useReviewComments((s) => s.byTask[taskId] ?? EMPTY);
}

/** Fence quoted source so multi-line snippets stay intact and the agent reads
 *  them as a reference, not as instructions. The fence is longer than any
 *  backtick run inside the quote, so a quoted ``` line (e.g. from a markdown
 *  file) can't close the block early. */
export function fenceQuote(quote: string): string {
  const q = quote.replace(/\n+$/, "");
  const longest = (q.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${q}\n${fence}`;
}

/** Compose the batched comments into a single message for an agent. Groups
 *  by file, orders by line, and quotes the targeted source so the agent can
 *  locate each spot even if line numbers have since drifted.
 *
 *  Returns "" when there are no comments. */
export function composeCommentsMessage(comments: ReviewComment[]): string {
  if (!comments.length) return "";

  // Group by file, preserving first-seen file order; sort each file's
  // comments by start line (file-level comments — null line — float first).
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const arr = byFile.get(c.file) ?? [];
    arr.push(c);
    byFile.set(c.file, arr);
  }

  const lineOf = (c: ReviewComment) => c.startLine ?? -1;
  const blocks: string[] = [];

  for (const [file, list] of byFile) {
    list.sort((a, b) => lineOf(a) - lineOf(b));
    for (const c of list) {
      const loc =
        c.startLine == null
          ? file
          : c.endLine != null && c.endLine !== c.startLine
            ? `${file}:${c.startLine}-${c.endLine}`
            : `${file}:${c.startLine}`;

      let block = loc;
      if (c.quote.trim()) block += `\n${fenceQuote(c.quote)}`;
      // A comment body is optional when there is a quote: sending a selection
      // with nothing to say about it is a real gesture ("look at this"). Don't
      // leave a dangling blank line behind the fence for it.
      if (c.body.trim()) block += `\n${c.body.trim()}`;
      blocks.push(block);
    }
  }

  // Only a diff-born batch gets the review framing. Selections sent from a
  // source file are "here is some code, here is what I want" — prefixing them
  // with "I reviewed your changes" tells the agent it authored code it may
  // never have touched, and invites it to answer as if defending a diff.
  if (!comments.some(c => c.source !== "editor")) return blocks.join("\n\n");

  const intro =
    comments.length === 1
      ? "I reviewed your changes and left an inline comment:"
      : `I reviewed your changes and left ${comments.length} inline comments:`;

  return `${intro}\n\n${blocks.join("\n\n")}`;
}
