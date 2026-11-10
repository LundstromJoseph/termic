// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureViewState, claim, hydrate, renderDoc, restoreViewState } from "./engine";
import { SLOT_ATTR } from "@/lib/markdown/trust";
import { copyToClipboard } from "@/lib/clipboard";
import { revealInDetails } from "./extensions/details";
import { findHeading, headingText } from "./extensions/headingLinks";
import { applyFolds, DEFAULT_ATTR, FOLD_CLOSED, FOLD_HIDDEN, foldedNames, revealInFolds } from "./extensions/folds";

// same sacrificial first line as markdown.test.ts: DOMPurify under happy-dom
// unwraps the first element it sees.
function render(src: string) {
  const host = document.createElement("div");
  const doc = renderDoc(`x\n\n${src}`);
  host.innerHTML = doc.html;
  claim(host);
  return { host, model: doc.model };
}
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: vi.fn(() => Promise.resolve()) }));
beforeEach(() => vi.mocked(copyToClipboard).mockClear());

/** render + hydrate, the way the preview does it. */
function mount(src: string, filePath?: string) {
  const r = render(src);
  const cleanup = hydrate(r.host, { themeDark: true, canEdit: false, isAlive: () => true, claim, filePath });
  return { ...r, cleanup };
}
const lines = (el: Element | null) => [el?.getAttribute("data-src-line"), el?.getAttribute("data-src-end")];

describe("alerts", () => {
  it("renders each GitHub type, any case, with a title and the stamps on the blockquote", () => {
    for (const kind of ["NOTE", "tip", "Important", "WARNING", "caution"]) {
      const { host } = render(`> [!${kind}]\n> Body text\n> more\n`);
      const bq = host.querySelector("blockquote")!;
      expect(bq.classList.contains(`markdown-alert-${kind.toLowerCase()}`)).toBe(true);
      expect(bq.querySelector(".markdown-alert-title")!.textContent).toMatch(/^[A-Z]/);
      expect(lines(bq)).toEqual(["3", "5"]);
      const p = bq.querySelector("p:not(.markdown-alert-title)")!;
      expect(p.textContent).toBe("Body text\nmore");
      // the paragraph starts after the marker line
      expect(lines(p)).toEqual(["4", "5"]);
    }
  });

  it("a marker alone in its paragraph leaves no empty paragraph behind", () => {
    const { host } = render("> [!TIP]\n>\n> Body\n");
    const bq = host.querySelector("blockquote")!;
    expect(Array.from(bq.querySelectorAll("p")).map(p => p.textContent)).toEqual(["Tip", "Body"]);
  });

  it("leaves plain blockquotes and markers that are not alone on their line", () => {
    for (const src of ["> just a quote\n", "> [!NOTE] inline text\n", "> [!BOGUS]\n> x\n", "para [!NOTE]\n"]) {
      const { host } = render(src);
      expect(host.querySelector(".markdown-alert, .markdown-alert-title")).toBeNull();
    }
  });
});

describe("details", () => {
  const DOC = (top = "") => [
    top,
    "<details>",
    "<summary>Rejected alternatives</summary>",
    "",
    "Stash refs.",
    "",
    "</details>",
    "",
    "<details open>",
    "<summary>Already open</summary>",
    "",
    "Body.",
    "",
    "</details>",
    "",
  ].join("\n");
  const byText = (host: HTMLElement, s: string) =>
    Array.from(host.querySelectorAll("details")).find(d => d.querySelector("summary")!.textContent === s)!;

  it("keeps the reader's open and closed state through a rebuild, even when lines shift above", () => {
    const a = render(DOC()).host;
    byText(a, "Rejected alternatives").open = true;
    byText(a, "Already open").open = false;
    const saved = captureViewState(a);
    const b = render(DOC("new line\n\nanother\n")).host;
    restoreViewState(b, saved);
    expect(byText(b, "Rejected alternatives").open).toBe(true);
    expect(byText(b, "Already open").open).toBe(false);
  });

  it("matches duplicate summaries by the closest line", () => {
    const src = "<details>\n<summary>S</summary>\n\nfirst\n\n</details>\n\n<details>\n<summary>S</summary>\n\nsecond\n\n</details>\n";
    const a = render(src).host;
    a.querySelectorAll("details")[1].open = true;
    const b = render(src).host;
    restoreViewState(b, captureViewState(a));
    expect(Array.from(b.querySelectorAll("details"), d => d.open)).toEqual([false, true]);
  });

  it("revealInDetails opens every ancestor", () => {
    const host = document.createElement("div");
    host.innerHTML = "<details><summary>a</summary><details><summary>b</summary><p><mark>hit</mark></p></details></details>";
    revealInDetails(host.querySelector("mark")!);
    expect(Array.from(host.querySelectorAll("details"), d => d.open)).toEqual([true, true]);
  });
});

describe("frontMatter", () => {
  const FM = [
    "---",
    "title: \"Task snapshots\"",
    "status: draft",
    "reviewers: [bob, carol]",
    "tags:",
    "  - storage",
    "# a comment",
    "---",
    "",
    "# Heading",
  ].join("\n");

  it("parses flat pairs, keeps the rest raw, and is one block in the model", () => {
    // no sacrificial line here: front matter only counts on line 1, so
    // happy-dom's DOMPurify unwraps the card itself and its children remain.
    const doc = renderDoc(FM);
    expect(doc.model.frontMatter).toEqual({
      pairs: [["title", "Task snapshots"], ["status", "draft"], ["reviewers", "bob, carol"]],
      raw: ["tags:", "  - storage", "# a comment"],
      startLine: 1,
      endLine: 8,
    });
    expect(doc.model.blocks[0]).toMatchObject({ kind: "front_matter", startLine: 1, endLine: 8 });
    expect(doc.model.headings[0]).toMatchObject({ text: "Heading", line: 10 });
    const host = document.createElement("div");
    host.innerHTML = doc.html;
    expect(Array.from(host.querySelectorAll(".fm-pair"), p => p.textContent)).toEqual(["title Task snapshots", "status draft", "reviewers bob, carol"]);
    expect(host.querySelector(".fm-pill")!.textContent).toBe("draft");
    expect(host.querySelector("details.fm-raw code")!.textContent).toBe("tags:\n  - storage\n# a comment");
    expect(host.querySelector("hr")).toBeNull();
  });

  it("accepts ... as the closing fence", () => {
    expect(renderDoc("---\na: 1\n...\n").model.frontMatter?.pairs).toEqual([["a", "1"]]);
  });

  it("only on the first line, only when closed", () => {
    expect(render(FM).model.frontMatter).toBeNull(); // not line 1 any more
    expect(render(FM).host.querySelector(".front-matter")).toBeNull();
    expect(renderDoc("---\nnot closed\n").model.frontMatter).toBeNull();
    expect(renderDoc("> ---\n> a: 1\n> ---\n").model.frontMatter).toBeNull();
  });
});

describe("codeHeader", () => {
  it("adds a text-free chrome header before each markdown code block", () => {
    const { host } = mount("```rust\nfn main() {}\n```\n\n    indented\n\n```mermaid\ngraph LR\n```\n\n<pre>raw</pre>\n");
    const heads = Array.from(host.querySelectorAll<HTMLElement>(".md-code-head"));
    expect(heads.map(h => h.dataset.lang)).toEqual(["rust", ""]);
    for (const h of heads) {
      expect(h.hasAttribute(SLOT_ATTR)).toBe(true);
      expect(h.nextElementSibling!.tagName).toBe("PRE");
      expect(h.textContent).toBe(""); // label + caption are CSS content
    }
  });

  it("Copy copies the code without its trailing newline", () => {
    const { host, cleanup } = mount("```sh\necho hi\necho there\n```\n");
    host.querySelector<HTMLElement>(".md-code-copy")!.click();
    expect(copyToClipboard).toHaveBeenCalledWith("echo hi\necho there", "code");
    cleanup();
    host.querySelector<HTMLElement>(".md-code-copy")!.click();
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
  });
});

describe("codeHeader hidden characters", () => {
  it("flags a block whose bytes are not what it shows, and leaves emoji and plain code alone", () => {
    const { host } = mount("```sh\nrm -rf /tmp/x \u202E; ls\n```\n\n```sh\necho \u200Bhi\n```\n\n```\nfamily \u{1F468}\u200D\u{1F469}\n```\n\n```sh\necho hi\n```\n");
    const heads = Array.from(host.querySelectorAll<HTMLElement>(".md-code-head"));
    expect(heads.map(h => !!h.querySelector(".md-code-warn"))).toEqual([true, true, false, false]);
    // still chrome without text: find and copy never see the warning
    expect(heads.every(h => h.textContent === "")).toBe(true);
  });
});

describe("headingLinks", () => {
  it("copies path#slug with the same duplicate numbering as #fragment links", () => {
    const { host } = mount("# Usage\n\n## Usage\n\n### Step 04 *x*\n", "docs/spec.md");
    const btns = Array.from(host.querySelectorAll<HTMLElement>(".md-heading-link"));
    // chrome, and no text: the heading reads the same to find, copy and slugging
    expect(btns.every(b => b.hasAttribute(SLOT_ATTR) && b.textContent === "")).toBe(true);
    expect(host.querySelector("h2")!.textContent).toBe("Usage");
    for (const b of btns) b.click();
    expect(vi.mocked(copyToClipboard).mock.calls.map(c => c[0])).toEqual(["docs/spec.md#usage", "docs/spec.md#usage-1", "docs/spec.md#step-04-x"]);
    // and each lands back on its own heading
    expect(findHeading(host, (_h, s) => s === "usage-1")!.el).toBe(host.querySelector("h2"));
  });

  it("a heading with math keeps one slug before and after KaTeX renders, the model's", async () => {
    const { host, model } = mount("## The $\\alpha$ value\n");
    const before = findHeading(host, () => true)!.slug;
    await vi.waitFor(() => expect(host.querySelector("h2 math")).not.toBeNull(), { timeout: 5000 });
    host.querySelector<HTMLElement>(".md-heading-link")!.click();
    expect(before).toBe("the-alpha-value");
    expect(model.headings[0]).toMatchObject({ text: "The \\alpha value", slug: "the-alpha-value" });
    expect(copyToClipboard).toHaveBeenCalledWith("#the-alpha-value", "link");
    expect(headingText(host.querySelector("h2")!)).toBe("The \\alpha value");
    // what a #fragment link resolves through, after render
    expect(findHeading(host, (_h, s) => s === "the-alpha-value")?.el).toBe(host.querySelector("h2"));
  });

  it("without a file it copies the bare fragment", () => {
    const { host } = mount("## Notes\n");
    host.querySelector<HTMLElement>(".md-heading-link")!.click();
    expect(copyToClipboard).toHaveBeenCalledWith("#notes", "link");
  });
});

describe("footnotes", () => {
  const SRC = [
    "Claim one.[^a] Claim two.[^b] Again.[^a] Inline.^[right here]", // 3
    "",
    "[^a]: Hashing uses BLAKE3.",                                      // 5
    "    Still note a.",                                                // 6
    "",
    "[^b]: Measured over 20 runs.",                                     // 8
    "",
  ].join("\n");

  it("renders refs and notes with trusted attrs, no ids, and stamps on each definition", () => {
    const { host, model } = render(SRC);
    expect(host.querySelector("[id]")).toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLElement>("sup a[data-fnref]"), a => [a.dataset.fnref, a.textContent]))
      .toEqual([["1:0", "1"], ["2:0", "2"], ["1:1", "1"], ["3:0", "3"]]);
    const notes = Array.from(host.querySelectorAll<HTMLElement>("ol.footnotes > li"));
    expect(notes.map(li => li.dataset.fn)).toEqual(["1", "2", "3"]);
    expect(notes.map(lines)).toEqual([["5", "6"], ["8", "8"], [null, null]]);
    // note 1 has two references, so two back links
    expect(Array.from(notes[0].querySelectorAll<HTMLElement>(".footnote-backref"), a => a.dataset.fnref)).toEqual(["1:0", "1:1"]);
    expect(model.blocks.filter(b => b.kind === "footnote").map(b => [b.startLine, b.endLine])).toEqual([[5, 6], [8, 8]]);
  });

  it("hover shows the note, a click jumps to it and the back link returns to that reference", () => {
    const { host } = mount(SRC);
    const refs = host.querySelectorAll<HTMLElement>("sup a[data-fnref]");
    expect(refs[1].title).toBe("Measured over 20 runs.");
    refs[2].click(); // the second reference to note 1
    const note1 = host.querySelector<HTMLElement>('li[data-fn="1"]')!;
    expect(note1.classList.contains("md-flash")).toBe(true);
    note1.querySelectorAll<HTMLElement>(".footnote-backref")[1].click();
    expect(refs[2].classList.contains("md-flash")).toBe(true);
    expect(refs[0].classList.contains("md-flash")).toBe(false);
  });
});

describe("deflist and mark", () => {
  it("definition lists, with a term stamped on its own line", () => {
    const { host, model } = render("Snapshot\n: A manifest plus blobs.\n\nManifest\n: The sorted list.\n: Second sense.\n");
    expect(Array.from(host.querySelectorAll("dl > *"), el => `${el.tagName}:${el.textContent}`)).toEqual([
      "DT:Snapshot", "DD:A manifest plus blobs.", "DT:Manifest", "DD:The sorted list.", "DD:Second sense.",
    ]);
    expect(Array.from(host.querySelectorAll("dt"), lines)).toEqual([["3", "3"], ["6", "6"]]);
    for (const b of model.blocks) expect(b.endLine).toBeGreaterThanOrEqual(b.startLine);
  });

  it("==highlight== becomes <mark>, and a lone = does not", () => {
    const { host } = render("a ==just a manifest== b, x = y, ==\n");
    expect(Array.from(host.querySelectorAll("mark"), m => m.textContent)).toEqual(["just a manifest"]);
  });
});

describe("math", () => {
  const inline = (src: string) => Array.from(render(src).host.querySelectorAll(".math-inline"), e => e.textContent);

  it("inline: GitHub's dollar rules", () => {
    expect(inline("with $B$ the bytes and $\\frac{B}{W}$ the time\n")).toEqual(["B", "\\frac{B}{W}"]);
    expect(inline("costs $5 and $10 today\n")).toEqual([]);
    expect(inline("costs $5 and $10 and $20\n")).toEqual([]);
    expect(inline("$ x$ and $x $\n")).toEqual([]);
    expect(inline("$x$5 is not math\n")).toEqual([]);
    expect(inline("\\$x$ escaped\n")).toEqual([]);
    expect(inline("code `$x$` stays code\n")).toEqual([]);
    expect(inline("inline $$x$$ is not math\n")).toEqual([]);
    expect(inline("a $p \\$ q$ b\n")).toEqual(["p \\$ q"]);
  });

  it("blocks: $$ lines, one-line $$ x $$, and ```math, each stamped", () => {
    const { host, model } = render("$$\nt = a + b\n$$\n\n$$ x^2 $$\n\n```math\ny\n```\n\n$$\nnever closed\n");
    const blocks = Array.from(host.querySelectorAll(".math-block"));
    expect(blocks.map(b => b.textContent)).toEqual(["t = a + b", "x^2", "y"]);
    expect(blocks.map(lines)).toEqual([["3", "5"], ["7", "7"], ["9", "11"]]);
    expect(host.querySelector("pre")).toBeNull(); // the math fence is not a code block
    expect(model.blocks.filter(b => b.kind === "math_block")).toHaveLength(3);
    expect(host.textContent).toContain("$$\nnever closed");
  });

  it("hydrate renders MathML, keeps the source on a parse error", async () => {
    const { host } = mount("$x^2$ and $\\frac{1$\n\n$$\n\\sqrt{2}\n$$\n");
    await vi.waitFor(() => expect(host.querySelectorAll("math")).toHaveLength(2), { timeout: 5000 });
    expect(host.querySelector(".math-block math")!.getAttribute("display")).toBe("block");
    const bad = host.querySelectorAll<HTMLElement>(".math-inline")[1];
    expect(bad.classList.contains("math-error")).toBe(true);
    expect(bad.textContent).toBe("\\frac{1");
    expect(bad.title).toMatch(/^Math error: /);
    // loaded now: a rebuild renders in the same task, no frame of raw TeX
    const again = mount("$y$\n").host;
    expect(again.querySelector("math")).not.toBeNull();
  });
});

describe("folds", () => {
  // front matter only counts on line 1, so no sacrificial line: happy-dom's
  // DOMPurify unwraps the card itself, and the headings after it are intact.
  function renderFm(src: string) {
    const host = document.createElement("div");
    host.innerHTML = renderDoc(src).html;
    claim(host);
    return host;
  }
  /** a rebuild the way the preview does one: capture off the old DOM, then
   *  render, claim, restore, hydrate. */
  function rebuild(src: string, old?: HTMLElement) {
    const saved = old ? captureViewState(old) : [];
    const host = renderFm(src);
    restoreViewState(host, saved);
    hydrate(host, { themeDark: true, canEdit: false, isAlive: () => true, claim });
    return host;
  }
  const heading = (host: HTMLElement, text: string) =>
    Array.from(host.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")).find(h => h.textContent === text)!;
  const para = (host: HTMLElement, text: string) =>
    Array.from(host.querySelectorAll("p")).find(p => p.textContent === text)!;
  const hidden = (el: Element) => el.classList.contains(FOLD_HIDDEN);
  const closed = (el: Element) => el.classList.contains(FOLD_CLOSED);
  // "x" is the sacrificial first element when there is no front matter
  const SECTIONS = "x\n\n## A\n\npa\n\n### B\n\npb\n\n#### C\n\npc\n\n### D\n\npd\n\n## E\n\npe\n";

  it("foldedNames reads the first folded key, any case, and strips brackets, quotes and spacing", () => {
    const doc = renderDoc("---\nFolded: [ Details , \"Open Questions\", 'Risks' ,, ]\nfolded: Ignored\n---\n");
    expect(foldedNames(doc.model.frontMatter!.pairs)).toEqual(new Set(["details", "open questions", "risks"]));
    expect(foldedNames([["title", "x"]])).toEqual(new Set());
  });

  it("stamps the folded default only on top-level h2 and h3 whose text matches, ignoring case", () => {
    const host = renderFm([
      "---", "folded: details, inner, notes", "---", "",
      "# Details", "", "## DETAILS", "", "### Inner", "", "#### Notes", "",
      "- ## Notes", "", "> ## Notes", "", "<h2>Notes</h2>", "", "## Notes", "",
    ].join("\n"));
    const stamped = Array.from(host.querySelectorAll(`[${DEFAULT_ATTR}]`), el => `${el.tagName}:${el.textContent}`);
    expect(stamped).toEqual(["H2:DETAILS", "H3:Inner", "H2:Notes"]);
    expect(host.querySelector(`[${DEFAULT_ATTR}]`)!.getAttribute(DEFAULT_ATTR)).toBe("1");
  });

  it("stamps nothing without front matter", () => {
    const { host } = render("folded: Details\n\n## Details\n");
    expect(host.querySelector(`[${DEFAULT_ATTR}]`)).toBeNull();
  });

  it("claim strips a fold class and default attr the document wrote itself", () => {
    const { host } = render('<h2 class="tc-fold-closed" data-fold-default="1">Fake</h2>\n\n<p class="tc-fold-hidden">shown</p>\n');
    expect(host.querySelector(`.${FOLD_CLOSED}, .${FOLD_HIDDEN}, [${DEFAULT_ATTR}]`)).toBeNull();
  });

  it("a first render collapses the folded sections and hides their blocks", () => {
    const host = rebuild(`---\nfolded: B\n---\n\n${SECTIONS}`);
    expect(closed(heading(host, "B"))).toBe(true);
    expect(closed(heading(host, "A"))).toBe(false);
    expect(hidden(heading(host, "B"))).toBe(false);
    expect([para(host, "pb"), heading(host, "C"), para(host, "pc")].every(hidden)).toBe(true);
    expect([para(host, "pa"), heading(host, "D"), para(host, "pd")].some(hidden)).toBe(false);
  });

  it("keeps the reader's toggles through a rebuild that shifts every line", () => {
    const a = rebuild(`---\nfolded: B\n---\n\n${SECTIONS}`);
    heading(a, "B").classList.remove(FOLD_CLOSED);
    heading(a, "D").classList.add(FOLD_CLOSED);
    const b = rebuild(`---\nfolded: B\n---\n\nnew\n\nlines\n\n${SECTIONS}`, a);
    expect(closed(heading(b, "B"))).toBe(false);
    expect(closed(heading(b, "D"))).toBe(true);
    expect(hidden(para(b, "pd"))).toBe(true);
    expect(hidden(para(b, "pb"))).toBe(false);
  });

  it("a folded default the author changed wins over the state it was saved in", () => {
    const a = rebuild(`---\nfolded: B\n---\n\n${SECTIONS}`);
    // the author moves the default from B to D; the reader touched neither
    const b = rebuild(`---\nfolded: D\n---\n\n${SECTIONS}`, a);
    expect(closed(heading(b, "B"))).toBe(false);
    expect(closed(heading(b, "D"))).toBe(true);
    // with the default unchanged, the reader's toggle is what is kept
    heading(b, "D").classList.remove(FOLD_CLOSED);
    const c = rebuild(`---\nfolded: D\n---\n\n${SECTIONS}`, b);
    expect(closed(heading(c, "D"))).toBe(false);
  });

  it("applyFolds: an h2 hides its h3s, an h4 does not end an h3, a slot follows its block", () => {
    const host = rebuild(SECTIONS);
    const slot = document.createElement("div");
    slot.setAttribute(SLOT_ATTR, "");
    para(host, "pc").after(slot);
    heading(host, "B").classList.add(FOLD_CLOSED);
    applyFolds(host);
    expect([heading(host, "C"), para(host, "pc"), slot].every(hidden)).toBe(true);
    expect(hidden(heading(host, "D"))).toBe(false);
    heading(host, "B").classList.remove(FOLD_CLOSED);
    heading(host, "A").classList.add(FOLD_CLOSED);
    applyFolds(host);
    expect([para(host, "pa"), heading(host, "B"), heading(host, "D"), para(host, "pd"), slot].every(hidden)).toBe(true);
    expect([heading(host, "A"), heading(host, "E"), para(host, "pe")].some(hidden)).toBe(false);
    // nothing closed any more: everything shows again
    heading(host, "A").classList.remove(FOLD_CLOSED);
    applyFolds(host);
    expect(host.querySelector(`.${FOLD_HIDDEN}`)).toBeNull();
  });

  it("the footnotes list stays visible under a collapsed last section", () => {
    const host = rebuild("---\nfolded: Last\n---\n\n## Last\n\nSee note.[^1]\n\n[^1]: The note.\n");
    expect(hidden(para(host, "See note.1"))).toBe(true);
    expect(hidden(host.querySelector("ol.footnotes")!)).toBe(false);
  });

  it("revealInFolds opens the h3 and the h2 around a block and syncs their chevrons", () => {
    const host = rebuild(`---\nfolded: A, B\n---\n\n${SECTIONS}`);
    revealInFolds(para(host, "pc"));
    expect(host.querySelector(`.${FOLD_CLOSED}, .${FOLD_HIDDEN}`)).toBeNull();
    expect(Array.from(host.querySelectorAll(".md-fold-toggle"), b => b.getAttribute("aria-expanded"))).toEqual(["true", "true", "true", "true"]);
  });

  it("the chevron toggles its section and aria-expanded follows", () => {
    const host = rebuild(SECTIONS);
    const btn = heading(host, "A").querySelector<HTMLElement>(".md-fold-toggle")!;
    // chrome with no text: find, copy and slugs read the heading unchanged
    expect(btn.hasAttribute(SLOT_ATTR) && btn.textContent === "").toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    btn.click();
    expect(closed(heading(host, "A"))).toBe(true);
    expect(hidden(para(host, "pa"))).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.title).toBe("Expand section");
    btn.click();
    expect(host.querySelector(`.${FOLD_HIDDEN}`)).toBeNull();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.title).toBe("Collapse section");
  });

  it("only markdown h2 and h3 at the top level get a chevron", () => {
    const { host } = mount("# H1\n\n## H2\n\n### H3\n\n#### H4\n\n- ## Listed\n\n<h2>Raw</h2>\n");
    expect(Array.from(host.querySelectorAll(".md-fold-toggle"), b => b.parentElement!.textContent)).toEqual(["H2", "H3"]);
  });
});
