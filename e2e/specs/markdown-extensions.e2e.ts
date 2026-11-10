import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { archiveTask, openTask, readClipboard, requireTermicApi, snap, waitForAppShell } from "../helpers";

// the markdown extensions (lib/markdown/extensions, docs/markdown.md) on the
// real preview: one synthetic doc exercising every one of them, rendered,
// then the interactive ones driven. Parsing edge cases are unit-tested in
// src/lib/markdown/extensions.test.ts; this is the DOM, CSS and hydrate
// side that only a real WebKit has (MathML, masks, scroll, open state).

const fixture = process.env.E2E_FIXTURE ?? path.join(process.cwd(), ".e2e", "fixture-repo");
const DOC = "md-extensions.md";
const SOURCE = readFileSync(path.join(process.cwd(), "e2e", "fixtures", "markdown-extensions.md"), "utf8");

declare global {
  interface Window {
    /** the on-screen `.markdown-body` of this spec's task. */
    __mdExt?: () => HTMLElement;
  }
}

describe("markdown extensions", () => {
  let taskId!: string;

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    writeFileSync(path.join(fixture, DOC), SOURCE);
    taskId = await openTask("e2e-md-ext");
    await browser.execute((id, p) => {
      window.__mdExt = () => Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] .markdown-body`))
        .find(el => el.getBoundingClientRect().width > 0)!;
      const app = window.__termic!.useApp.getState();
      app.bumpFsRevision(id);
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.persistTab(id, tab.id);
      app.setActiveTabId(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "preview" });
    }, taskId, DOC);
    await browser.waitUntil(
      () => browser.execute(() => !!window.__mdExt?.()?.querySelector("dl")),
      { timeout: 15_000, timeoutMsg: `${DOC} preview never rendered` },
    );
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
    try {
      execSync(`git -C "${fixture}" clean -fd`);
    } catch { /* best effort */ }
  });

  it("renders every extension", async () => {
    // math becomes MathML after a lazy import
    await browser.waitUntil(
      () => browser.execute(() => window.__mdExt!().querySelectorAll("math").length === 5),
      { timeout: 10_000, timeoutMsg: "math never rendered to MathML" },
    );
    const r = await browser.execute(() => {
      const host = window.__mdExt!();
      const all = (s: string) => Array.from(host.querySelectorAll<HTMLElement>(s));
      return {
        pairs: all(".front-matter .fm-pair").map(p => p.textContent),
        fmLine: host.querySelector(".front-matter")?.getAttribute("data-src-line"),
        hr: host.querySelectorAll("hr").length,
        alerts: all(".markdown-alert").map(a => a.className.replace("markdown-alert ", "")),
        alertBorders: all(".markdown-alert").map(a => getComputedStyle(a).borderLeftColor),
        alertIcon: getComputedStyle(host.querySelector(".markdown-alert-title")!, "::before").webkitMaskImage,
        codeLangs: all(".md-code-head").map(h => h.dataset.lang),
        codeHeadText: all(".md-code-head").map(h => h.textContent).join(""),
        headingLinks: all(".md-heading-link").map(b => b.parentElement!.tagName),
        mathError: all(".math-error").map(e => e.textContent),
        dollarsText: host.textContent!.includes("$5 and $10"),
        marks: all("mark").map(m => m.textContent),
        dts: all("dt").map(d => d.textContent),
        notes: all("ol.footnotes > li[data-src-line]").length,
        refs: all("sup a[data-fnref]").map(a => a.title),
        // a mermaid SVG carries mermaid's own ids (its style scope, its markers)
        ids: host.querySelectorAll("[id]:not(.mermaid-block *)").length,
      };
    });
    expect(r.pairs).toEqual([
      "title Task snapshots", "status draft", "owner alice", "reviewers bob, carol",
      "summary Automatic snapshots of a task's worktree, taken each time an agent settles",
    ]);
    expect(r.fmLine).toBe("1");
    expect(r.hr).toBe(0);
    expect(r.alerts).toEqual(["markdown-alert-note", "markdown-alert-tip", "markdown-alert-important", "markdown-alert-warning", "markdown-alert-caution"]);
    expect(new Set(r.alertBorders).size).toBe(5); // one colour per type
    expect(r.alertIcon).toContain("data:image/svg+xml");
    expect(r.codeLangs).toEqual(["rust", ""]);
    expect(r.codeHeadText).toBe("");
    expect(r.headingLinks).toEqual(["H1", "H2", "H2", "H3", "H2", "H3"]);
    // the slug is made at click time, from the rendered page: each copies its own
    for (const [i, slug] of ["task-snapshots", "design", "latency-budget", "glossary"].entries()) {
      await browser.execute((i) => (window.__mdExt!().querySelectorAll<HTMLElement>(".md-heading-link")[i]).click(), i);
      await browser.waitUntil(() => readClipboard().trimEnd().endsWith(`#${slug}`), {
        timeout: 5_000, timeoutMsg: `heading link ${i} never copied #${slug}`,
      });
    }
    expect(r.mathError).toEqual(["\\frac{1"]);
    expect(r.dollarsText).toBe(true);
    expect(r.marks).toEqual(["just a manifest"]);
    expect(r.dts).toEqual(["Snapshot", "Manifest"]);
    expect(r.notes).toBe(2);
    expect(r.refs).toEqual(["Hashing kept up with disk reads on every machine tried.", "Measured over 20 runs on a 1 GB checkout."]);
    expect(r.ids).toBe(0);
    await snap("md-extensions.png");
  });

  it("front matter is a strip of chips, folded: is not shown, and a long value spans the strip", async () => {
    const r = await browser.execute(() => {
      const fm = window.__mdExt!().querySelector<HTMLElement>(".front-matter")!;
      const pair = (k: string) => Array.from(fm.querySelectorAll<HTMLElement>(".fm-pair")).find(p => p.querySelector(".fm-k")!.textContent === k)!;
      const chip = getComputedStyle(pair("owner"));
      const wide = pair("summary");
      return {
        keys: Array.from(fm.querySelectorAll(".fm-k"), k => k.textContent),
        label: !!fm.querySelector(".fm-label"),
        chipRadius: chip.borderTopLeftRadius,
        chipBorder: chip.borderTopWidth,
        chipNarrower: pair("owner").getBoundingClientRect().width < fm.clientWidth / 2,
        wide: wide.classList.contains("fm-wide"),
        wideBorder: getComputedStyle(wide).borderTopWidth,
        wideWidth: wide.getBoundingClientRect().width,
        cardWidth: fm.clientWidth,
      };
    });
    expect(r.keys).toEqual(["title", "status", "owner", "reviewers", "summary"]);
    expect(r.label).toBe(false);
    expect(r).toMatchObject({ chipRadius: "999px", chipBorder: "1px", chipNarrower: true, wide: true, wideBorder: "0px" });
    expect(Math.abs(r.wideWidth - r.cardWidth)).toBeLessThanOrEqual(1);
    await browser.execute(() => window.__mdExt!().querySelector(".front-matter")!.scrollIntoView({ block: "start" }));
    await snap("md-front-matter.png");
  });

  // mermaid zoom: the expand button opens a clone of the rendered SVG in a
  // dialog. The arrowheads are markers the clone must resolve from its own
  // <defs>, so that is measured, not only looked at.
  const zoom = () => browser.execute(() => {
    const dlg = document.querySelector<HTMLElement>('[data-testid="mermaid-zoom"]');
    const stage = dlg?.querySelector<HTMLElement>('[data-testid="mermaid-zoom-stage"]');
    const svg = stage?.querySelector("svg");
    const refs = svg ? Array.from(svg.querySelectorAll("[marker-end]"), el => el.getAttribute("marker-end")!.match(/#([^)]+)/)![1]) : [];
    const m = stage ? getComputedStyle(stage).transform.match(/^matrix\(([^,]+)/) : null;
    return {
      open: !!dlg,
      role: dlg?.getAttribute("role") ?? null,
      markers: refs.length,
      markersInClone: refs.filter(id => svg!.querySelector(`[id="${id}"]`) instanceof SVGMarkerElement).length,
      scale: m ? Number(m[1]) : null,
      pct: dlg?.querySelector('[data-testid="mermaid-zoom-pct"]')?.textContent ?? null,
      width: svg?.getBoundingClientRect().width ?? 0,
    };
  });

  it("a diagram's expand button opens it in a dialog, fitted, with its arrowheads", async () => {
    await browser.waitUntil(
      () => browser.execute(() => !!window.__mdExt!().querySelector(".mermaid-block > svg + .md-mermaid-expand")),
      { timeout: 15_000, timeoutMsg: "the diagram never rendered with an expand button" },
    );
    // an edit tab's preview is editable: a click on the diagram itself stays a click
    await browser.execute(() => window.__mdExt!().querySelector<SVGElement>(".mermaid-block > svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect((await zoom()).open).toBe(false);
    await browser.execute(() => window.__mdExt!().querySelector(".mermaid-block")!.scrollIntoView({ block: "center" }));
    await snap("md-mermaid-block.png");
    await browser.execute(() => window.__mdExt!().querySelector<HTMLElement>(".md-mermaid-expand")!.click());
    await browser.waitUntil(async () => (await zoom()).scale !== null && (await zoom()).pct !== "", { timeout: 5_000, timeoutMsg: "the zoom dialog never painted" });
    const z = await zoom();
    expect(z.role).toBe("dialog");
    expect(z.markers).toBeGreaterThan(0);
    expect(z.markersInClone).toBe(z.markers);
    expect(z.width).toBeGreaterThan(300); // fitted to the window, not the column
    await snap("md-mermaid-zoom.png");
  });

  it("Zoom in raises the scale and 0 fits again", async () => {
    const fitted = (await zoom()).scale!;
    await browser.execute(() => document.querySelector<HTMLElement>('[data-testid="mermaid-zoom-in"]')!.click());
    await browser.waitUntil(async () => ((await zoom()).scale ?? 0) > fitted * 1.2, { timeout: 5_000, timeoutMsg: "Zoom in never raised the scale" });
    expect((await zoom()).pct).toBe(`${Math.round(fitted * 125)}%`);
    await snap("md-mermaid-zoomed.png");
    await browser.keys(["0"]);
    await browser.waitUntil(async () => Math.abs(((await zoom()).scale ?? 0) - fitted) < 1e-6, { timeout: 5_000, timeoutMsg: "0 never fitted the diagram again" });
  });

  it("the open dialog keeps its arrowheads when the agent rewrites the file", async () => {
    writeFileSync(path.join(fixture, DOC), SOURCE.replace("# Task snapshots\n", "# Task snapshots\n\nRewritten under the zoom.\n"));
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    await browser.waitUntil(
      () => browser.execute(() => window.__mdExt!().textContent!.includes("Rewritten under the zoom.")
        && !!window.__mdExt!().querySelector(".mermaid-block > svg")),
      { timeout: 10_000, timeoutMsg: "the preview never re-rendered under the dialog" },
    );
    const z = await zoom();
    expect(z.open).toBe(true);
    expect(z.markersInClone).toBe(z.markers);
    await snap("md-mermaid-zoom-after-rewrite.png");
  });

  it("Esc closes the dialog and focus returns to the preview", async () => {
    await browser.keys(["Escape"]);
    await browser.waitUntil(async () => !(await zoom()).open, { timeout: 5_000, timeoutMsg: "Esc did not close the zoom dialog" });
    expect(await browser.execute(() => document.activeElement === window.__mdExt!().closest("[tabindex]"))).toBe(true);
  });

  it("a footnote reference jumps to its note and the back link returns", async () => {
    const flashed = await browser.execute(() => {
      const host = window.__mdExt!();
      host.querySelectorAll<HTMLElement>("sup a[data-fnref]")[1].click();
      const note = host.querySelector<HTMLElement>('li[data-fn="2"]')!;
      const atNote = note.classList.contains("md-flash");
      note.querySelector<HTMLElement>(".footnote-backref")!.click();
      return { atNote, atRef: host.querySelectorAll<HTMLElement>("sup a[data-fnref]")[1].classList.contains("md-flash") };
    });
    expect(flashed).toEqual({ atNote: true, atRef: true });
  });

  it("an open <details> stays open when the file changes under it", async () => {
    await browser.execute(() => { window.__mdExt!().querySelector("details")!.open = true; });
    writeFileSync(path.join(fixture, DOC), SOURCE.replace("# Task snapshots\n", "# Task snapshots\n\nA line the agent added.\n"));
    await browser.execute((id) => window.__termic!.useApp.getState().bumpFsRevision(id), taskId);
    await browser.waitUntil(
      () => browser.execute(() => window.__mdExt!().textContent!.includes("A line the agent added.")),
      { timeout: 10_000, timeoutMsg: "the preview never picked up the rewrite" },
    );
    expect(await browser.execute(() => window.__mdExt!().querySelector("details")!.open)).toBe(true);
    await snap("md-extensions-details-open.png");
  });

  // folds: `folded: Folded section` in the fixture's front matter. What a
  // reader sees is computed display, so that is what is asserted.
  const fold = () => browser.execute(() => {
    const host = window.__mdExt!();
    const h2 = Array.from(host.querySelectorAll("h2")).find(h => h.textContent === "Folded section")!;
    const inner = Array.from(host.querySelectorAll("h3")).find(h => h.textContent === "Inner")!;
    const para = (t: string) => Array.from(host.querySelectorAll("p")).find(p => p.textContent!.startsWith(t));
    const shown = (el: Element | null | undefined) => !!el && getComputedStyle(el).display !== "none";
    return {
      closed: h2.classList.contains("tc-fold-closed"),
      expanded: h2.querySelector(".md-fold-toggle")?.getAttribute("aria-expanded"),
      innerClosed: inner.classList.contains("tc-fold-closed"),
      heading: shown(h2),
      lead: shown(para("Collapsed on open")),
      // the breakout wrapper sets its own display: the fold has to beat it
      table: shown(host.querySelector("table")?.closest(".md-wide")),
      inner: shown(inner),
      innerPara: shown(para("The inner paragraph")),
      glossary: shown(host.querySelector("dl")),
      footnotes: shown(host.querySelector("ol.footnotes")),
    };
  });
  const FOLDED = { closed: true, expanded: "false", heading: true, lead: false, table: false, inner: false, innerPara: false, glossary: true, footnotes: true };
  const OPEN = { closed: false, expanded: "true", heading: true, lead: true, table: true, inner: true, innerPara: true, glossary: true, footnotes: true };
  const chevron = (heading: string) => browser.execute((t) => {
    const h = Array.from(window.__mdExt!().querySelectorAll("h2, h3")).find(h => h.textContent === t)!;
    h.querySelector<HTMLElement>(".md-fold-toggle")!.click();
  }, heading);
  const waitFold = (want: Partial<Awaited<ReturnType<typeof fold>>>, msg: string) =>
    browser.waitUntil(async () => {
      const f = await fold();
      return Object.entries(want).every(([k, v]) => f[k as keyof typeof f] === v);
    }, { timeout: 5_000, timeoutMsg: msg });
  /** the folded section at the top of the pane, for a snap that shows it */
  const snapFold = async (name: string) => {
    await browser.execute(() => Array.from(window.__mdExt!().querySelectorAll("h2")).find(h => h.textContent === "Folded section")!
      .scrollIntoView({ block: "start" }));
    await snap(name);
  };
  const lineOf = (text: string) => String(readFileSync(path.join(fixture, DOC), "utf8").split("\n").indexOf(text) + 1);
  const focusDoc = (key: string) => browser.execute((k) => {
    window.__mdExt!().closest<HTMLElement>("[tabindex]")!.focus();
    const mac = /^(mac|darwin)/i.test(navigator.platform);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: k, [mac ? "metaKey" : "ctrlKey"]: true, bubbles: true, cancelable: true }));
  }, key);
  const typeInto = (testid: string, value: string, key?: string) => browser.execute((id, tid, v, k) => {
    const input = document.querySelector<HTMLInputElement>(`[data-task-id="${id}"] [data-testid="${tid}"] input`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (k) input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  }, taskId, testid, value, key ?? "");

  it("a section named in folded: opens collapsed, its blocks display: none, the rest untouched", async () => {
    expect(await fold()).toMatchObject({ ...FOLDED, innerClosed: false });
    await snapFold("md-fold-collapsed.png");
  });

  it("the chevron unfolds the section and folds it again", async () => {
    await chevron("Folded section");
    await waitFold(OPEN, "the chevron did not unfold the section");
    await snapFold("md-fold-expanded.png");
    await chevron("Folded section");
    await waitFold(FOLDED, "the chevron did not fold the section again");
  });

  it("a folded h3 inside an open h2 hides only its own blocks", async () => {
    await chevron("Folded section");
    await chevron("Inner");
    await waitFold({ closed: false, innerClosed: true, lead: true, table: true, inner: true, innerPara: false },
      "folding Inner hid more or less than its own section");
    await snapFold("md-fold-inner.png");
    await chevron("Inner");
    await chevron("Folded section");
    await waitFold(FOLDED, "could not reset to the folded default");
  });

  it("the chevron sits after the heading text, inside the column, clear of the line-number gutter", async () => {
    // a gutter label's right edge is 10px left of its block's column
    // (lineGutter.ts), so anything inside the column cannot collide with it
    const r = await browser.execute(() => {
      const h2 = Array.from(window.__mdExt!().querySelectorAll("h2")).find(h => h.textContent === "Folded section")!;
      const btn = h2.querySelector(".md-fold-toggle")!;
      const text = document.createRange();
      text.selectNodeContents(h2.firstChild!);
      return {
        insideColumn: btn.getBoundingClientRect().left >= h2.getBoundingClientRect().left,
        afterText: btn.getBoundingClientRect().left >= text.getBoundingClientRect().right,
        beforeLink: btn.nextElementSibling?.classList.contains("md-heading-link") ?? false,
        shown: getComputedStyle(btn).opacity,
      };
    });
    // collapsed, so shown without a hover
    expect(r).toEqual({ insideColumn: true, afterText: true, beforeLink: true, shown: "1" });
  });

  it("find inside a folded section unfolds it", async () => {
    const counter = () => browser.execute((id) =>
      document.querySelector(`[data-task-id="${id}"] [data-testid="md-find"]`)?.textContent ?? null, taskId);
    await focusDoc("f");
    await browser.waitUntil(async () => (await counter()) !== null, { timeout: 5_000, timeoutMsg: "find never opened" });
    await typeInto("md-find", "inner paragraph");
    await browser.waitUntil(async () => (await counter())?.includes("1/1") ?? false, { timeout: 5_000, timeoutMsg: "find never matched inside the fold" });
    await waitFold({ ...OPEN }, "a find match inside the fold did not unfold it");
    await typeInto("md-find", "", "Escape");
    await chevron("Folded section");
    await waitFold(FOLDED, "could not refold after find");
  });

  it("an outline click on a heading inside a fold unfolds it", async () => {
    const toggle = () => browser.execute((id) => Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] [data-testid="md-outline-toggle"]`))
      .find(b => b.getBoundingClientRect().width > 0)!.click(), taskId);
    const line = lineOf("### Inner");
    await toggle();
    try {
      await browser.waitUntil(
        () => browser.execute((id, l) => !!document.querySelector(`[data-task-id="${id}"] [data-outline-line="${l}"]`), taskId, line),
        { timeout: 5_000, timeoutMsg: "the outline never listed Inner" },
      );
      await browser.execute((id, l) => Array.from(document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"] [data-outline-line="${l}"]`))
        .find(b => b.getBoundingClientRect().width > 0)!.click(), taskId, line);
      await waitFold({ ...OPEN }, "an outline jump into the fold did not unfold it");
    } finally {
      await toggle();
    }
    await chevron("Folded section");
    await waitFold(FOLDED, "could not refold after the outline jump");
  });

  it("go to line into a folded section unfolds it and flashes the block", async () => {
    const line = lineOf("The inner paragraph under the fold.");
    await focusDoc("g");
    await browser.waitUntil(
      () => browser.execute((id) => !!document.querySelector(`[data-task-id="${id}"] [data-testid="md-goto"]`), taskId),
      { timeout: 5_000, timeoutMsg: "go to line never opened" },
    );
    await typeInto("md-goto", line, "Enter");
    await browser.waitUntil(
      () => browser.execute((l) => window.__mdExt!().querySelector<HTMLElement>(".md-flash")?.dataset.srcLine === l, line),
      { timeout: 5_000, timeoutMsg: `line ${line} never flashed` },
    );
    expect(await fold()).toMatchObject(OPEN);
    await chevron("Folded section");
    await waitFold(FOLDED, "could not refold after go to line");
  });

  it("the reader's folds survive an edit in split view", async () => {
    // opposite of the default on both: Folded section open, Inner closed
    await chevron("Folded section");
    await chevron("Inner");
    await waitFold({ closed: false, innerClosed: true, innerPara: false }, "could not set up the reader's folds");
    const setView = (v: string) => browser.execute((id, p, v) => {
      const app = window.__termic!.useApp.getState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = app.tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.patchTab(id, tab.id, { mdView: v });
    }, taskId, DOC, v);
    await setView("split");
    try {
      await browser.waitUntil(
        () => browser.execute(() => Array.from(document.querySelectorAll(".cm-editor")).some(el => !el.closest(".markdown-body") && el.getBoundingClientRect().width > 0)),
        { timeout: 10_000, timeoutMsg: "split view never showed the editor" },
      );
      await browser.execute(() => {
        const dom = Array.from(document.querySelectorAll(".cm-editor"))
          .find(el => !el.closest(".markdown-body") && el.getBoundingClientRect().width > 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const view = (dom as unknown as { __cmView: any }).__cmView;
        // above every section, so each heading's line shifts
        const at = view.state.doc.toString().indexOf("# Task snapshots\n") + "# Task snapshots\n".length;
        view.dispatch({ changes: { from: at, insert: "\nTyped in split view.\n" } });
      });
      await browser.waitUntil(
        () => browser.execute(() => window.__mdExt!().textContent!.includes("Typed in split view.")),
        { timeout: 10_000, timeoutMsg: "the preview never picked up the edit" },
      );
      expect(await fold()).toMatchObject({ closed: false, innerClosed: true, lead: true, inner: true, innerPara: false });
      await snapFold("md-fold-split-edit.png");
    } finally {
      // save, so the archive in after() meets a clean tab
      await browser.execute(() => {
        const mac = /^(mac|darwin)/i.test(navigator.platform);
        window.__mdExt!().dispatchEvent(new KeyboardEvent("keydown", { key: "s", [mac ? "metaKey" : "ctrlKey"]: true, bubbles: true }));
      });
      await browser.waitUntil(() => readFileSync(path.join(fixture, DOC), "utf8").includes("Typed in split view."),
        { timeout: 5_000, timeoutMsg: "⌘S never saved the split edit" });
      await setView("preview");
    }
  });

  it("a recycled preview tab opens the next file on its own defaults, not the last file's folds", async () => {
    const BODY = "## Folded section\n\nA body.\n\n### Inner\n\nInner body.\n";
    writeFileSync(path.join(fixture, "md-fold-a.md"), `---\nfolded: Folded section\n---\n\n${BODY}`);
    writeFileSync(path.join(fixture, "md-fold-b.md"), `---\ntitle: b\n---\n\n${BODY.replace("A body.", "B body.")}`);
    const open = (p: string, text: string) => browser.execute((id, p) => {
      const app = window.__termic!.useApp.getState();
      app.bumpFsRevision(id);
      app.openPreviewTab(id, { type: "edit", path: p, title: p });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tab = window.__termic!.useApp.getState().tabs[id].find((t: any) => t.type === "edit" && t.path === p);
      app.setActiveTabId(id, tab.id);
      app.patchTab(id, tab.id, { mdView: "preview" });
      return tab.id as string;
    }, taskId, p).then(async (tabId) => {
      await browser.waitUntil(() => browser.execute((t) => window.__mdExt?.()?.textContent?.includes(t) ?? false, text),
        { timeout: 10_000, timeoutMsg: `${p} never rendered` });
      return tabId;
    });
    const state = () => browser.execute(() => Array.from(window.__mdExt!().querySelectorAll("h2, h3"), h => `${h.textContent}:${h.classList.contains("tc-fold-closed")}`));
    const a = await open("md-fold-a.md", "A body.");
    expect(await state()).toEqual(["Folded section:true", "Inner:false"]);
    // the reader flips both
    await chevron("Folded section");
    await chevron("Inner");
    expect(await state()).toEqual(["Folded section:false", "Inner:true"]);
    const b = await open("md-fold-b.md", "B body.");
    expect(b).toBe(a); // the same preview slot, recycled
    expect(await state()).toEqual(["Folded section:false", "Inner:false"]);
  });
});
