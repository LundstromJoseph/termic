// Full-window pan and zoom for a rendered mermaid diagram. It shows a CLONE
// of the preview's SVG, so there is no second mermaid render. The clone keeps
// mermaid's id: its <style> is scoped `#mmd-N`, and its own <defs> keep the
// arrowheads resolving even if a rebuild removes the original.
//
// The view lives in a ref and is written straight to the stage's transform,
// so a drag or a pinch never re-renders React.

import { useCallback, useImperativeHandle, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface MermaidZoomHandle { open(svg: SVGSVGElement): void }

export type View = { x: number; y: number; s: number };
type Size = { w: number; h: number };

const MIN = 0.1;
const MAX = 8;
const STEP = 1.25;

/** the box centred in the viewport, at 95% of the tighter fit, never above 2x. */
export function fitView(box: Size, vp: Size): View {
  const s = Math.min(Math.min(vp.w / box.w, vp.h / box.h) * 0.95, 2);
  return { x: (vp.w - box.w * s) / 2, y: (vp.h - box.h * s) / 2, s };
}

/** scale by `factor` (clamped to [0.1, 8]) keeping the point (px, py) fixed. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const s = Math.min(MAX, Math.max(MIN, v.s * factor));
  const k = s / v.s;
  return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

function cloneForZoom(svg: SVGSVGElement): { el: SVGSVGElement; box: Size } {
  const el = svg.cloneNode(true) as SVGSVGElement;
  const vb = svg.viewBox.baseVal;
  const box = vb && vb.width > 0 && vb.height > 0 ? { w: vb.width, h: vb.height } : (() => {
    const b = svg.getBBox();
    return { w: b.width || 1, h: b.height || 1 };
  })();
  el.style.maxWidth = "none";
  el.setAttribute("width", String(box.w));
  el.setAttribute("height", String(box.h));
  return { el, box };
}

export function MermaidZoom({ ref, returnFocus }: {
  ref: React.Ref<MermaidZoomHandle>;
  /** focused on close: a click on a diagram leaves no trigger to return to */
  returnFocus: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation("panels");
  const [clone, setClone] = useState<{ el: SVGSVGElement; box: Size } | null>(null);
  useImperativeHandle(ref, () => ({ open: svg => setClone(cloneForZoom(svg)) }), []);

  const view = useRef<View>({ x: 0, y: 0, s: 1 });
  const contentRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pctRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  // a direct write, not a rAF: WebKit batches it into the next frame anyway,
  // and rAF stops on an occluded window (and in the e2e harness)
  const set = useCallback((v: View) => {
    view.current = v;
    innerRef.current!.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`;
    pctRef.current!.textContent = `${Math.round(v.s * 100)}%`;
  }, []);
  const fit = useCallback(() => {
    const vp = vpRef.current;
    if (vp && clone) set(fitView(clone.box, { w: vp.clientWidth, h: vp.clientHeight }));
  }, [clone, set]);
  const zoomCentre = useCallback((factor: number) => {
    const vp = vpRef.current;
    if (vp) set(zoomAt(view.current, factor, vp.clientWidth / 2, vp.clientHeight / 2));
  }, [set]);

  // a callback ref: the Portal mounts its children a commit after open, so
  // an effect keyed on `clone` would run before the viewport exists
  const attach = useCallback((vp: HTMLDivElement | null) => {
    vpRef.current = vp;
    if (!vp || !clone) return;
    vp.firstElementChild!.replaceChildren(clone.el);
    fit();
    // non-passive, so the page under the dialog never scrolls
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = vp.getBoundingClientRect();
        set(zoomAt(view.current, Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top));
      } else {
        set({ ...view.current, x: view.current.x - e.deltaX, y: view.current.y - e.deltaY });
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [clone, fit, set]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomCentre(STEP);
    else if (e.key === "-") zoomCentre(1 / STEP);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  }

  const btn = "flex h-7 w-7 items-center justify-center rounded text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]";
  return (
    <Dialog.Root open={!!clone} onOpenChange={o => { if (!o) setClone(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/65" />
        <Dialog.Content
          ref={contentRef}
          data-testid="mermaid-zoom"
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          // the dialog itself, not the first button: the keys work at once and
          // no focus ring lands on Zoom out
          onOpenAutoFocus={e => { e.preventDefault(); contentRef.current?.focus(); }}
          onCloseAutoFocus={e => { e.preventDefault(); returnFocus.current?.focus({ preventScroll: true }); }}
          className="fixed inset-6 z-50 flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl outline-none"
        >
          <Dialog.Title className="sr-only">{t("mdExt.mermaid.dialogTitle")}</Dialog.Title>
          <div className="flex items-center justify-end gap-1 border-b border-[var(--color-border-soft)] px-2 py-1.5">
            <button type="button" data-testid="mermaid-zoom-out" onClick={() => zoomCentre(1 / STEP)} title={t("mdExt.mermaid.zoomOut")} aria-label={t("mdExt.mermaid.zoomOut")} className={btn}>
              <ZoomOut className="h-4 w-4" />
            </button>
            <span ref={pctRef} data-testid="mermaid-zoom-pct" className="min-w-[3rem] text-center text-[12px] tabular-nums text-[var(--color-fg-dim)]" />
            <button type="button" data-testid="mermaid-zoom-in" onClick={() => zoomCentre(STEP)} title={t("mdExt.mermaid.zoomIn")} aria-label={t("mdExt.mermaid.zoomIn")} className={btn}>
              <ZoomIn className="h-4 w-4" />
            </button>
            <button type="button" data-testid="mermaid-zoom-fit" onClick={fit} title={t("mdExt.mermaid.fit")} aria-label={t("mdExt.mermaid.fit")} className={btn}>
              <Maximize className="h-4 w-4" />
            </button>
            <Dialog.Close data-testid="mermaid-zoom-close" title={t("mdExt.mermaid.close")} aria-label={t("mdExt.mermaid.close")} className={btn}>
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div
            ref={attach}
            className="md-zoom-viewport relative min-h-0 flex-1 overflow-hidden"
            onDoubleClick={fit}
            onPointerDown={e => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              e.currentTarget.classList.add("md-zoom-dragging");
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            }}
            onPointerMove={e => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              set({ ...view.current, x: view.current.x + e.clientX - d.x, y: view.current.y + e.clientY - d.y });
              d.x = e.clientX;
              d.y = e.clientY;
            }}
            onPointerUp={e => {
              if (drag.current?.id !== e.pointerId) return;
              drag.current = null;
              e.currentTarget.classList.remove("md-zoom-dragging");
            }}
            onPointerCancel={e => {
              drag.current = null;
              e.currentTarget.classList.remove("md-zoom-dragging");
            }}
          >
            <div ref={innerRef} data-testid="mermaid-zoom-stage" className="absolute left-0 top-0 origin-top-left will-change-transform" />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
