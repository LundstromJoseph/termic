import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataDir } from "../../wdio.conf.js";
import { archiveTask, cliRpc, openTask, requireTermicApi, rmTree, runCli, snap, waitForAgentReady, waitForAppShell } from "../helpers.js";

// Review comments on a file outside the task, opened with `termic view`
// (docs/ui.md "Markdown preview"): the same composer, cards and bar as a task
// file's preview, keyed by the file's absolute path. The fixture is invented
// text in a temp dir; no real paths or names.

const TASK = "e2e-report-comments";
const SOURCE = [
  "# Plan report",                                      // 1
  "",                                                   // 2
  "## Plan",                                            // 3
  "",                                                   // 4
  "[[decision-1]] Keep the existing store.",            // 5
  "",                                                   // 6
  "- [[step-1]] Add the rule.",                         // 7
  "- [[finding-1]] major: A forged chip.",              // 8
  "",                                                   // 9
  "A plain paragraph that wraps",                       // 10
  "over two source lines.",                             // 11
  "",                                                   // 12
  '<p><span data-md-chip="x-9" class="md-chip">forged</span></p>', // 13
  "",
].join("\n");

declare global {
  interface Window {
    /** this spec's on-screen preview (every visited task stays mounted, so a
     *  bare query can land on a hidden copy) */
    __report?: { host(): HTMLElement };
  }
}

describe("comments on a termic view report", () => {
  let taskId!: string;
  let agentTabId!: string;
  let extTabId!: string;
  let dir!: string;
  let file!: string;
  let readerWas: unknown;

  type TabInfo = { id: string; type: string; path: string | null; mdView: string | null };
  const tabs = (): Promise<TabInfo[]> => browser.execute((id) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.__termic!.useApp.getState().tabs[id] ?? []).map((t: any) => ({ id: t.id, type: t.type, path: t.path ?? null, mdView: t.mdView ?? null })),
  taskId);
  const activeTab = () => browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId);
  const pillText = () => browser.execute(() =>
    document.querySelector('[data-testid="review-comments-pill"]')?.textContent ?? null);
  const composer = () => browser.execute(() => {
    const c = window.__report!.host().querySelector(".tc-comment-composer");
    return c ? { loc: c.querySelector(".tc-comment-loc")!.textContent, quote: c.querySelector(".tc-comment-quote")?.textContent ?? null } : null;
  });
  /** Type `body` into the open composer and queue it. */
  const addToPending = (body: string) => browser.execute((b) => {
    const c = window.__report!.host().querySelector(".tc-comment-composer")!;
    const ta = c.querySelector("textarea")!;
    ta.value = b;
    ta.dispatchEvent(new Event("input"));
    (Array.from(c.querySelectorAll("button")).find(x => x.textContent === "Add to pending") as HTMLElement).click();
  }, body);
  // -1 while no preview is on screen (a reopened tab still loading)
  const cardCount = () => browser.execute(() => window.__report!.host()?.querySelectorAll(".tc-comment-card").length ?? -1);
  /** Open the bar from the agent tab and click `file`'s group button, in ONE
   *  step that retries the open: activating the agent tab queues a terminal
   *  focus that can close the popover a frame after it opens (the same race
   *  editor.e2e.ts's batch send documents). */
  const clickBarFile = (f: string) => browser.waitUntil(
    () => browser.execute((path) => {
      const btn = Array.from(document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper] button"))
        .find(b => b.textContent === path);
      if (btn) { btn.click(); return true; }
      const pill = document.querySelector('[data-testid="review-comments-pill"]') as HTMLElement | null;
      if (pill?.getAttribute("data-state") === "closed") pill.click();
      return false;
    }, f),
    { timeout: 8_000, timeoutMsg: "the bar's file button never appeared" },
  );
  const activateAgent = () => browser.execute((id, tab) =>
    window.__termic!.useApp.getState().setActiveTabId(id, tab), taskId, agentTabId);

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await openTask(TASK);
    // the batch has to land in a REAL agent PTY
    await waitForAgentReady(taskId);
    agentTabId = await activeTab();
    // hover numbers: paint() runs on the mousemove, not on a frame
    readerWas = await browser.execute(() => {
      const p = window.__termic!.usePrefs.getState();
      const was = p.markdownReader;
      p.setMarkdownReader({ ...was, lineNumbers: "hover" });
      return was;
    });
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "termic-e2e-report-")));
    file = path.join(dir, "report.md");
    fs.writeFileSync(file, SOURCE);
    await browser.execute((id) => {
      window.__report = {
        host: () => Array.from(document.querySelector(`[data-task-id="${id}"]`)!.querySelectorAll<HTMLElement>(".markdown-body"))
          .find(el => el.getBoundingClientRect().width > 0)!,
      };
    }, taskId);
  });

  after(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (readerWas) await browser.execute((r) => window.__termic!.usePrefs.getState().setMarkdownReader(r as any), readerWas);
    if (taskId) await archiveTask(taskId);
    if (dir) rmTree(dir, { bestEffort: true });
  });

  it("termic view opens the report as an external tab, rendered", async () => {
    const out = JSON.parse(runCli(["--no-launch", "--json", "view", file, "--focus"],
      { TERMIC_DATA_DIR: dataDir, TERMIC_TASK_ID: taskId }));
    extTabId = out.tab_id;

    expect((await tabs()).find(t => t.id === extTabId)).toMatchObject({ type: "external", path: file, mdView: "preview" });
    await browser.waitUntil(
      () => browser.execute(() => window.__report!.host()?.textContent?.includes("over two source lines.") ?? false),
      { timeout: 10_000, timeoutMsg: "the report never rendered" },
    );
  });

  it("a selection in a paragraph takes a comment, which shows as a card and in the bar", async () => {
    await browser.execute(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const host = window.__report!.host();
      const p = Array.from(host.querySelectorAll("p")).find(x => x.textContent!.startsWith("A plain paragraph"))!;
      const node = p.firstChild as Text;
      const i = node.nodeValue!.indexOf("plain paragraph");
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + "plain paragraph".length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      host.parentElement!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('[data-testid="md-add-comment"]')),
      { timeout: 5_000, timeoutMsg: "no comment pill over the selection" });

    await browser.execute(() => document.querySelector('[data-testid="md-add-comment"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    await browser.waitUntil(async () => !!(await composer()), { timeout: 5_000, timeoutMsg: "the composer never opened" });

    expect(await composer()).toEqual({ loc: "report.md · line 10", quote: "plain paragraph" });
    await addToPending("say why the store stays");
    await browser.waitUntil(async () => (await cardCount()) === 1, { timeout: 5_000, timeoutMsg: "no card after Add to pending" });
    await browser.waitUntil(async () => (await pillText())?.includes("1 pending comment") ?? false,
      { timeout: 5_000, timeoutMsg: "the bar never counted the comment" });
    await snap("report-comments-card.png");
  });

  it("a paragraph's gutter number carries a + and no pencil, and the + quotes the block's source", async () => {
    await browser.waitUntil(() => browser.execute(() => {
      const host = window.__report!.host();
      host.querySelector('p[data-src-line="5"]')!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      // a number's buttons are built when the pointer first reaches it
      host.parentElement!.querySelector(".md-gl")?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return !!host.parentElement!.querySelector('.md-gl [data-act="comment"]');
    }), { timeout: 10_000, timeoutMsg: "no + on the hovered number" });
    expect(await browser.execute(() =>
      !!window.__report!.host().parentElement!.querySelector('.md-gl [data-act="edit"]'))).toBe(false);

    await browser.execute(() =>
      window.__report!.host().parentElement!.querySelector<HTMLElement>('.md-gl [data-act="comment"]')!.click());
    await browser.waitUntil(async () => !!(await composer()), { timeout: 5_000, timeoutMsg: "the + did not open the composer" });

    expect(await composer()).toEqual({ loc: "report.md · line 5", quote: "[[decision-1]] Keep the existing store." });
    await snap("report-comments-plus-composer.png");
    await addToPending("keep it, but name the reason");
    await browser.waitUntil(async () => (await cardCount()) === 2, { timeout: 5_000, timeoutMsg: "the + comment never became a card" });
  });

  it("the bar's file button focuses the open report tab, not a diff", async () => {
    await activateAgent();

    await clickBarFile(file);

    await browser.waitUntil(async () => (await activeTab()) === extTabId,
      { timeout: 5_000, timeoutMsg: "the report tab did not become active" });
    expect((await tabs()).filter(t => t.type === "diff" && t.path === file)).toEqual([]);
  });

  it("the bar's file button reopens the report when its tab was closed", async () => {
    await browser.execute((id, tab) => window.__termic!.useApp.getState().closeTab(id, tab), taskId, extTabId);
    await activateAgent();

    await clickBarFile(file);

    await browser.waitUntil(async () => {
      const id = await activeTab();
      return (await tabs()).some(t => t.id === id && t.type === "external" && t.path === file && t.mdView === "preview");
    }, { timeout: 5_000, timeoutMsg: "the report did not reopen as the active tab, in preview" });
    // its comments come back with it
    await browser.waitUntil(async () => (await cardCount()) === 2,
      { timeout: 10_000, timeoutMsg: "the reopened report has no cards" });
  });

  it("sends both comments to the agent in one message naming the absolute path", async () => {
    await activateAgent();

    await browser.waitUntil(
      () => browser.execute(() => {
        const send = document.querySelector('[data-testid="review-comments-send"]') as HTMLElement | null;
        if (send) { send.click(); return true; }
        const pill = document.querySelector('[data-testid="review-comments-pill"]') as HTMLElement | null;
        if (pill?.getAttribute("data-state") === "closed") pill.click();
        return false;
      }),
      { timeout: 8_000, timeoutMsg: "the Send button never appeared" },
    );

    // xterm draws to a canvas: the agent's PTY ring is where the bytes show
    await browser.waitUntil(async () => {
      const logs = await cliRpc({ cmd: "logs", task: TASK });
      if (!logs.ok) return false;
      const out = logs.data.data as string;
      return out.includes(`${file}:10`) && out.includes(`${file}:5`)
        && out.includes("say why the store stays") && out.includes("keep it, but name the reason")
        && out.includes("[[decision-1]] Keep the existing store.");
    }, { timeout: 30_000, timeoutMsg: "the batch never reached the agent's PTY" });
    await browser.waitUntil(async () => (await pillText()) === null,
      { timeout: 8_000, timeoutMsg: "the bar stayed after sending" });
  });
});
