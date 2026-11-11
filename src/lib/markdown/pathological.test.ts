// @vitest-environment happy-dom
// hostile documents: the preview re-renders the whole doc on every typing
// debounce and agent write, so every pass must stay linear in the input.
//
// Two kinds of check, per docs/perf-ci.md (counts gate, timings do not):
// - block parsing is COUNTED: reads of markdown-it's line table, at n and
//   2n lines, in every block context (root, list item, quote, paragraph
//   continuation). Linear work doubles; a rescan quadruples. This gates CI.
// - the rest (slugs, footnote titles, regexes) has nothing cheap to count,
//   so it runs big locally, where vitest's 5s timeout is the ceiling, and at
//   1/50 size on CI, where only its answers are checked.
import { describe, it, expect, vi } from "vitest";
import MarkdownIt from "markdown-it";

// happy-dom's DOMPurify (and its querySelectorAll) are superlinear on their
// own, WebKit's are not; the passes under test are ours, so skip the
// sanitizer. Hydrate still runs on a happy-dom tree, which keeps those sizes
// smaller.
vi.mock("dompurify", () => ({ default: { sanitize: (s: string) => s, addHook: () => {}, removeHook: () => {} } }));

import { captureViewState, claim, EXTENSIONS, hydrate, renderDoc, restoreViewState } from "./engine";
import { headingSlugger } from "@/lib/markdownPaths";
import { newMathPass, renderTex } from "./extensions/math";
import { footnotes } from "./extensions/footnotes";
import { findHeading } from "./extensions/headingLinks";

const big = (n: number) => (process.env.CI ? Math.ceil(n / 50) : n);

/** Line-table reads to block-parse `src` with every extension's rules. */
function blockReads(src: string): number {
  const md = new MarkdownIt({ html: true });
  for (const e of EXTENSIONS) e.plugin?.(md);
  let reads = 0;
  const Base = md.block.State;
  md.block.State = class extends Base {
    constructor(...a: ConstructorParameters<typeof Base>) {
      super(...a);
      this.bMarks = new Proxy(this.bMarks, { get: (o, k) => { reads++; return Reflect.get(o, k); } });
    }
  } as typeof Base;
  md.parse(src, {});
  return reads;
}

// the same hostile lines, as each block context a rule can run in
const CONTEXTS: Record<string, (body: string) => string> = {
  root: b => b,
  list: b => "- " + b.replace(/\n(?=.)/g, "\n  "),
  quote: b => b.replace(/^(?=.)/gm, "> "),
  paragraph: b => "lead text\n" + b,
};

/** Fails when parsing `unit` x2n costs over 2.5x `unit` x n, in any context. */
function expectLinear(unit: string, n = 400) {
  for (const [name, wrap] of Object.entries(CONTEXTS)) {
    const a = blockReads(wrap(unit.repeat(n))), b = blockReads(wrap(unit.repeat(2 * n)));
    expect(b / a, `${JSON.stringify(unit)} in ${name}`).toBeLessThan(2.5);
  }
}

describe("block parsing is linear in every context", () => {
  it("unclosed $$ lines, one paragraph", () => expectLinear("$$a\n"));
  it("unclosed $$ lines alternating block start and paragraph terminator", () => expectLinear("$$a\n$$a\n# h\n"));
  it("$$ lines with blank lines between", () => expectLinear("$$a\n\n"));
  it("footnote definitions", () => expectLinear("[^a]: x\n"));
  it("alert markers", () => expectLinear("> [!NOTE]\n"));
  it("details blocks", () => expectLinear("<details>\n<summary>s</summary>\n\n"));
});

function mount(src: string) {
  const host = document.createElement("div");
  const doc = renderDoc(src);
  host.innerHTML = doc.html;
  claim(host);
  hydrate(host, { themeDark: true, canEdit: false, isAlive: () => true, claim });
  return { host, model: doc.model };
}

describe("heading slugs", () => {
  it("disambiguates duplicates the GitHub way, literal suffixes included", () => {
    const s = headingSlugger();
    expect(["Usage", "Usage", "Usage 1", "Usage", "Usage-2"].map(s)).toEqual(["usage", "usage-1", "usage-1-1", "usage-2", "usage-2-1"]);
    const t = headingSlugger();
    expect(["Usage 1", "Usage", "Usage", "Usage"].map(t)).toEqual(["usage-1", "usage", "usage-2", "usage-3"]);
    const e = headingSlugger();
    expect(["", "!", ""].map(e)).toEqual(["", "-1", "-2"]);
  });

  it("50k empty headings", () => {
    const n = big(50_000);
    const { model } = renderDoc("#\n".repeat(n));
    expect(model.headings).toHaveLength(n);
    expect(model.headings.at(-1)!.slug).toBe(`-${n - 1}`);
  });
});

describe("nested raw-html headings", () => {
  // each heading's text holds every heading inside it: slugging them all is
  // depth x size. Counted by what hydrate touched, not timed.
  it("only the outermost is slugged and gets a link", () => {
    const depth = 200;
    const { host } = mount("<h2><div>".repeat(depth) + "deep text" + "</div></h2>".repeat(depth));
    expect(host.querySelectorAll("h2")).toHaveLength(depth);
    expect(host.querySelectorAll(".md-heading-link")).toHaveLength(1);
    expect(findHeading(host, () => false)).toBeNull();
    let seen = 0;
    findHeading(host, () => { seen++; return false; });
    expect(seen).toBe(1);
  });
});

describe("$$ blocks", () => {
  it("stop at a blank line, so prose $$ does not swallow up to a later $$", () => {
    const { host } = mount("$$ is the shell PID\n\nlater text $$\n");
    expect(host.querySelector(".math-block")).toBeNull();
    expect(host.textContent).toContain("later text $$");
    expect(mount("$$\na\n\nb\n$$\n").host.querySelector(".math-block")).toBeNull();
    expect(mount("$$\na\nb\n$$\n").host.querySelector(".math-block")!.textContent).toBe("a\nb");
  });

  it("unclosed $$ lines stay one paragraph", () => {
    const { model } = renderDoc("$$a\n".repeat(big(20_000)));
    expect(model.blocks.map(b => b.kind)).toEqual(["paragraph"]);
  });
});

describe("katex cache", () => {
  const fake = () => ({ renderToString: vi.fn(() => "<math><mi>x</mi></math>") });

  it("is an LRU: a recently used formula survives the cap", () => {
    const k = fake();
    const run = (tex: string) => renderTex(k as never, tex, false);
    newMathPass();
    run("lru-keep");
    for (let i = 0; i < 999; i++) run(`lru-${i}`);
    newMathPass();
    run("lru-keep"); // touched: now the newest
    run("lru-overflow"); // evicts the oldest, lru-0
    k.renderToString.mockClear();
    run("lru-keep");
    expect(k.renderToString).not.toHaveBeenCalled();
    run("lru-0");
    expect(k.renderToString).toHaveBeenCalledTimes(1);
  });

  it("a doc over the cap re-renders only the overflow, not every formula", () => {
    const k = fake();
    const pass = () => { newMathPass(); for (let i = 0; i <= 1000; i++) renderTex(k as never, `over-${i}`, false); };
    pass();
    k.renderToString.mockClear();
    pass();
    // a plain LRU in document order would miss all 1001
    expect(k.renderToString).toHaveBeenCalledTimes(1);
  });

  it("refuses user macros before KaTeX runs: real KaTeX expands them to megabytes", async () => {
    const katex = (await import("katex")).default;
    // 4.9 KB in, 29 MB of MathML out without the guard, inside maxExpand
    const amp = "\\def\\b{" + "x".repeat(2900) + "}" + "\\b".repeat(999);
    expect(renderTex(katex, amp, false)).toEqual({ error: expect.stringContaining("macro") });
    for (const def of ["\\gdef\\a{x}", "\\newcommand{\\a}{x}", "\\let\\a=b", "\\renewcommand\\a{x}"]) {
      expect(renderTex(katex, def, false)).toHaveProperty("error");
    }
    // a word that merely starts like one is fine
    expect(renderTex(katex, "\\left( x \\right) \\leq \\delta", false)).toHaveProperty("html");
  });

  it("output past the cap is an error, cached so it is paid once", () => {
    const k = { renderToString: vi.fn(() => "x".repeat(300_000)) };
    expect(renderTex(k as never, "huge-out", false)).toHaveProperty("error");
    renderTex(k as never, "huge-out", false);
    expect(k.renderToString).toHaveBeenCalledTimes(1);
  });

  it("does not render or cache huge sources, and passes KaTeX its size limits", () => {
    const k = fake();
    expect(renderTex(k as never, "x".repeat(5001), true)).toHaveProperty("error");
    expect(k.renderToString).not.toHaveBeenCalled();
    renderTex(k as never, "limits-check", true);
    expect(k.renderToString).toHaveBeenCalledWith("limits-check", expect.objectContaining({ maxSize: 20, maxExpand: 1000 }));
  });
});

describe("footnotes", () => {
  it("one note referenced many times: every title is the note, without back links", () => {
    // footnotes' hydrate alone: the rest is happy-dom cost, not the case
    const host = document.createElement("div");
    const n = big(10_000);
    host.innerHTML = renderDoc(`${"a[^1] ".repeat(n)}\n\n[^1]: the note\n`).html;
    claim(host);
    footnotes.hydrate!(host, { themeDark: true, canEdit: false, isAlive: () => true, claim });
    const refs = Array.from(host.getElementsByTagName("a")).filter(a => !a.classList.contains("footnote-backref"));
    expect(refs).toHaveLength(n);
    expect(new Set(refs.map(a => a.title))).toEqual(new Set(["the note"]));
  });

  it("50k inline notes", () => {
    const n = big(50_000);
    const { html } = renderDoc("^[a] ".repeat(n));
    expect(html.match(/<li class="footnote-item"/g)).toHaveLength(n);
  });
});

describe("front matter", () => {
  it("a long whitespace run inside a value", () => {
    const n = big(100_000);
    const doc = renderDoc(`---\nk: a${" ".repeat(n)}b \t\n---\n`);
    expect(doc.model.frontMatter?.pairs).toEqual([["k", `a${" ".repeat(n)}b`]]);
  });

  it("is not claimed without a key: value pair, the doc just opens with a rule", () => {
    const doc = renderDoc("---\nIntro paragraph.\n\n---\n\nbody\n");
    expect(doc.model.frontMatter).toBeNull();
    const host = document.createElement("div");
    host.innerHTML = doc.html;
    expect(host.querySelector(".front-matter")).toBeNull();
    expect(host.textContent).toContain("Intro paragraph.");
    expect(renderDoc("---\n- a\n- b\n---\n").model.frontMatter).toBeNull();
  });

  it("is claimed with only nested values or a block scalar, and behind a BOM", () => {
    expect(renderDoc("---\ntags:\n  - a\n---\nbody\n").model.frontMatter).toMatchObject({ pairs: [], raw: ["tags:", "  - a"] });
    expect(renderDoc("---\ndescription: |\n  long\n---\n").model.frontMatter).not.toBeNull();
    expect(renderDoc("\uFEFF---\ntitle: x\n---\n").model.frontMatter?.pairs).toEqual([["title", "x"]]);
  });
});

describe("details", () => {
  it("nested hundreds deep, only the outer few are keyed", () => {
    const depth = 300;
    const { host } = mount("<details><summary>S</summary>\n".repeat(depth) + "\nbody\n\n" + "</details>\n".repeat(depth));
    expect(host.querySelectorAll("details")).toHaveLength(depth);
    const keyed = captureViewState(host)[EXTENSIONS.findIndex(e => e.name === "details")] as unknown[];
    expect(keyed.length).toBeLessThanOrEqual(8);
    expect(keyed.length).toBeGreaterThan(0);
  });


  // semantics only: the old quadratic restore loop is too cheap per step to
  // outrun happy-dom's own DOM cost at any size that fits the timeout
  it("restores many identical summaries one for one, after lines shift", () => {
    const doc = (top: string) => top + "<details>\n<summary>S</summary>\n\nbody\n\n</details>\n\n".repeat(1_000);
    const a = mount(doc("")).host;
    a.querySelectorAll("details").forEach((d, i) => { d.open = i % 3 === 0; });
    const b = mount(doc("new\n\nlines\n\n")).host;
    restoreViewState(b, captureViewState(a));
    const open = Array.from(b.querySelectorAll("details"), d => d.open);
    expect(open).toHaveLength(1_000);
    expect(open.every((o, i) => o === (i % 3 === 0))).toBe(true);
  });
});

describe("folds", () => {
  const FOLDS = EXTENSIONS.findIndex(e => e.name === "folds");

  // 20k, not 50k: hydrate runs on a happy-dom tree (see the top of the file)
  it("20k top-level h2s with a 1k-name folded list render, restore and fold", () => {
    const n = big(20_000);
    const names = Array.from({ length: 1_000 }, (_, i) => `s${i * 2}`).join(", ");
    const body = Array.from({ length: n }, (_, i) => `## s${i}\n\nbody\n`).join("\n");
    const { host } = mount(`---\nfolded: ${names}\n---\n\n${body}`);
    restoreViewState(host, []);
    const closed = host.querySelectorAll(".tc-fold-closed").length;
    expect(closed).toBe(Math.min(1_000, Math.ceil(n / 2)));
    expect(host.querySelectorAll(".tc-fold-hidden")).toHaveLength(closed);
  });

  // semantics only, as for details: identical headings restore one for one
  it("restores many identical heading texts one for one, after lines shift", () => {
    const doc = (top: string) => top + "## S\n\nbody\n\n".repeat(1_000);
    const a = mount(doc("")).host;
    restoreViewState(a, []);
    a.querySelectorAll("h2").forEach((h, i) => h.classList.toggle("tc-fold-closed", i % 3 === 0));
    const saved = captureViewState(a);
    expect((saved[FOLDS] as unknown[]).length).toBe(1_000);
    const b = mount(doc("new\n\nlines\n\n")).host;
    restoreViewState(b, saved);
    const closed = Array.from(b.querySelectorAll("h2"), h => h.classList.contains("tc-fold-closed"));
    expect(closed.every((c, i) => c === (i % 3 === 0))).toBe(true);
  });
});

describe("idChips", () => {
  const count = (html: string, attr: string) => html.split(`${attr}=`).length - 1;

  it("50k chipped paragraphs with a severity each render one chip and one badge apiece", () => {
    const n = big(50_000);

    const { html } = renderDoc("[[s-1]] major: x\n\n".repeat(n));

    expect(count(html, "data-md-chip")).toBe(n);
    expect(count(html, "data-md-sev")).toBe(n);
  });

  it("a 1M-char unclosed `[[aaa...` paragraph renders no chip", () => {
    const { html } = renderDoc("[[" + "a".repeat(big(1_000_000)));

    expect(count(html, "data-md-chip")).toBe(0);
  });

  it("a 1M-digit id missing its second closing bracket renders no chip", () => {
    const { html } = renderDoc("[[a-" + "1".repeat(big(1_000_000)) + "]");

    expect(count(html, "data-md-chip")).toBe(0);
  });
});
