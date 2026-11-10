// Section folding: a chevron after each top-level h2/h3 collapses everything
// up to the next heading of the same or a higher level. The front matter's
// `folded:` key names the sections that start collapsed.
//
// Folding toggles classes on the flat top-level siblings and never wraps a
// section: breakout, slot placement, copy, the block editor and scroll sync
// all read the flat structure. The `tc-` prefix means claim strips any copy a
// document writes, so a document can neither hide its content nor fake a
// fold. See docs/markdown.md "folds".

import type { MdExtension } from "../extension";
import { inlineText, type FrontMatter } from "../model";
import { SLOT_ATTR, stampAttr } from "../trust";
import { headingText } from "./headingLinks";
import { i18n } from "@/lib/i18n";

/** On a heading whose section is collapsed. */
export const FOLD_CLOSED = "tc-fold-closed";
/** On a top-level child inside a collapsed section. */
export const FOLD_HIDDEN = "tc-fold-hidden";
/** Trusted: the heading is named in `folded:`. */
export const DEFAULT_ATTR = "data-fold-default";
const BTN = "md-fold-toggle";

/** The lowercased section names in the first `folded:` pair. */
export function foldedNames(pairs: FrontMatter["pairs"]): Set<string> {
  const v = pairs.find(([k]) => k.toLowerCase() === "folded")?.[1] ?? "";
  const names = new Set<string>();
  for (const item of v.split(",")) {
    const s = item.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2").toLowerCase();
    if (s) names.add(s);
  }
  return names;
}

/** A markdown h2/h3 directly in the document, never a raw-HTML one (no
 *  trusted line stamp). */
export function isFoldable(el: Element, host: Element): el is HTMLElement {
  return el.parentElement === host && (el.tagName === "H2" || el.tagName === "H3") && el.hasAttribute("data-src-line");
}

/** The level a top-level child ends sections at: a heading's own, 0 for any
 *  other block. The footnotes list (always last) ends them all, or folding
 *  the last section would hide every note with it. */
const levelOf = (el: Element) =>
  /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : el.tagName === "OL" && el.classList.contains("footnotes") ? 1 : 0;

/** Hide every top-level child inside a closed section and show the rest.
 *  One pass over the host's children; a no-op on a document with no fold
 *  closed and nothing left hidden. */
export function applyFolds(host: HTMLElement): void {
  if (!host.querySelector(`:scope > .${FOLD_CLOSED}, :scope > .${FOLD_HIDDEN}`)) return;
  const stack: { level: number; closed: boolean }[] = [];
  let closed = 0;
  let lastHidden = false;
  for (const el of Array.from(host.children)) {
    // a slot sits right after its block (placeSlots), so it shares its fate
    if (el.hasAttribute(SLOT_ATTR)) { el.classList.toggle(FOLD_HIDDEN, lastHidden); continue; }
    const level = levelOf(el);
    if (level) {
      while (stack.length && stack[stack.length - 1].level >= level) if (stack.pop()!.closed) closed--;
    }
    lastHidden = closed > 0;
    el.classList.toggle(FOLD_HIDDEN, lastHidden);
    if (isFoldable(el, host)) {
      const c = el.classList.contains(FOLD_CLOSED);
      stack.push({ level, closed: c });
      if (c) closed++;
    }
  }
}

const labels = () => ({ expand: i18n.t("panels:mdExt.fold.expand"), collapse: i18n.t("panels:mdExt.fold.collapse") });

function setToggle(btn: Element, isClosed: boolean, l = labels()): void {
  const label = isClosed ? l.expand : l.collapse;
  btn.setAttribute("aria-expanded", String(!isClosed));
  btn.setAttribute("title", label);
  btn.setAttribute("aria-label", label);
}

function syncToggle(h: Element): void {
  const btn = h.querySelector(`:scope > .${BTN}`);
  if (btn) setToggle(btn, h.classList.contains(FOLD_CLOSED));
}

/** Open every fold hiding `el`, so a jump to it has a box to land on. */
export function revealInFolds(el: Element): void {
  const hidden = el.closest(`.${FOLD_HIDDEN}`);
  const host = hidden?.parentElement;
  if (!hidden || !host) return;
  let bound = 7;
  for (let p = hidden.previousElementSibling; p && bound > 1; p = p.previousElementSibling) {
    const level = levelOf(p);
    if (!level || level >= bound) continue;
    if (isFoldable(p, host) && p.classList.contains(FOLD_CLOSED)) {
      p.classList.remove(FOLD_CLOSED);
      syncToggle(p);
    }
    bound = level;
  }
  applyFolds(host);
}

type Saved = { key: string; line: number; closed: boolean; dflt: boolean };

const foldables = (host: HTMLElement) => Array.from(host.children).filter((el): el is HTMLElement => isFoldable(el, host));
const keyOf = (h: HTMLElement) => `${h.tagName[1]}:${headingText(h).trim().toLowerCase()}`;
const lineOf = (h: HTMLElement) => Number(h.getAttribute("data-src-line"));

export const folds: MdExtension = {
  name: "folds",
  trusted: { attrs: [DEFAULT_ATTR] },
  plugin(md) {
    md.core.ruler.after("inline", "fold_defaults", (state) => {
      const fm = state.tokens[0];
      if (fm?.type !== "front_matter") return;
      const names = foldedNames((fm.meta as Pick<FrontMatter, "pairs">).pairs);
      if (!names.size) return;
      const tokens = state.tokens;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === "heading_open" && t.level === 0 && (t.tag === "h2" || t.tag === "h3")
          && names.has(inlineText(tokens[i + 1]).trim().toLowerCase())) stampAttr(t, DEFAULT_ATTR, 1);
      }
    });
  },
  // the reader's toggles survive a rebuild; a heading whose `folded:`
  // default changed since (the author edited the list) takes the new one
  viewState: {
    capture(host): Saved[] {
      return foldables(host).map(h => ({
        key: keyOf(h), line: lineOf(h), closed: h.classList.contains(FOLD_CLOSED), dflt: h.hasAttribute(DEFAULT_ATTR),
      }));
    },
    restore(host, state) {
      const saved = (state as Saved[] | undefined) ?? [];
      const heads = foldables(host);
      const want = new Map<HTMLElement, boolean>(heads.map(h => [h, h.hasAttribute(DEFAULT_ATTR)]));
      // the details.ts matcher: per key, one forward cursor, closest line
      const free = new Map<string, HTMLElement[]>();
      for (const h of heads) {
        const k = keyOf(h);
        let bucket = free.get(k);
        if (!bucket) free.set(k, bucket = []);
        bucket.push(h);
      }
      const cursor = new Map<string, number>();
      for (const s of saved) {
        const bucket = free.get(s.key);
        let i = cursor.get(s.key) ?? 0;
        if (!bucket || i >= bucket.length) continue;
        const dist = (j: number) => Math.abs(lineOf(bucket[j]) - s.line);
        while (i + 1 < bucket.length && dist(i + 1) < dist(i)) i++;
        const h = bucket[i];
        if (s.dflt === h.hasAttribute(DEFAULT_ATTR)) want.set(h, s.closed);
        cursor.set(s.key, i + 1);
      }
      for (const [h, c] of want) h.classList.toggle(FOLD_CLOSED, c);
      applyFolds(host);
    },
  },
  hydrate(host) {
    const l = labels();
    for (const h of foldables(host)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = BTN;
      btn.setAttribute(SLOT_ATTR, "");
      setToggle(btn, h.classList.contains(FOLD_CLOSED), l);
      // after the text, not in the left margin: the line-number gutter
      // labels the hovered heading there
      h.insertBefore(btn, h.querySelector(":scope > .md-heading-link"));
    }
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element | null)?.closest?.(`.${BTN}`);
      const h = btn?.parentElement;
      if (!btn?.hasAttribute(SLOT_ATTR) || !h || !host.contains(btn)) return;
      setToggle(btn, h.classList.toggle(FOLD_CLOSED));
      applyFolds(host);
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  },
};
