// Scroll a review diff to one thread's card (the Compare thread list), opening
// whatever hides it: the merge view's "N unchanged lines" fold on both panes,
// and a resolved thread's collapsed card.

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { getChunks, mergeViewSiblings, uncollapseUnchanged, type Chunk } from "@codemirror/merge";
import type { ReviewThread } from "@/lib/types";
import { expandThreadEffects } from "./reviewCommentsExt";

/** Start of the collapsed-unchanged fold covering `pos`, or null. The fold's
 *  widget type string is @codemirror/merge internal (6.12.1). */
export function foldAt(state: EditorState, pos: number): number | null {
  for (const src of state.facet(EditorView.decorations)) {
    if (typeof src === "function") continue;
    let found: number | null = null;
    src.between(pos, pos, (from, to, deco) => {
      if ((deco.spec.widget as { type?: string } | undefined)?.type === "collapsed-unchanged-code" && from <= pos && pos <= to) {
        found = from;
        return false;
      }
    });
    if (found !== null) return found;
  }
  return null;
}

/** A `b`-side position on the `a` side. Copy of @codemirror/merge 6.12.1's
 *  unexported `mapPos` with isA=false, which its own fold click uses. */
function mapToA(pos: number, chunks: readonly Chunk[]): number {
  let startOur = 0, startOther = 0;
  for (const next of chunks) {
    if (next.fromB >= pos) break;
    startOur = next.toB;
    startOther = next.toA;
  }
  return startOther + (pos - startOur);
}

/** Reveal `th` in `view` (the modified side). Returns false for a file-level
 *  thread, whose card sits above line 1: the caller scrolls to the top. */
export function revealThread(view: EditorView, th: ReviewThread): boolean {
  const expand = expandThreadEffects(view.state, th);
  if (th.start_line === null) {
    if (expand.length) view.dispatch({ effects: expand });
    return false;
  }
  const doc = view.state.doc;
  const clamp = (n: number) => Math.min(Math.max(n, 1), doc.lines);
  const start = doc.line(clamp(th.start_line)).from;
  const end = doc.line(clamp(th.end_line ?? th.start_line)).to;
  const folds = [...new Set([foldAt(view.state, start), foldAt(view.state, end)])].filter((p): p is number => p !== null);
  const sibling = mergeViewSiblings(view)?.a;
  const chunks = getChunks(view.state)?.chunks;
  if (folds.length && sibling && sibling !== view && chunks) {
    sibling.dispatch({ effects: folds.map(p => uncollapseUnchanged.of(mapToA(p, chunks))) });
  }
  view.dispatch({
    effects: [
      ...folds.map(p => uncollapseUnchanged.of(p)),
      ...expand,
      EditorView.scrollIntoView(end, { y: "center" }),
    ],
  });
  return true;
}
