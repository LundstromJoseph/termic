import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  archiveTask, cliRpc, createWorktreeTask, ensureActiveTask, flushEditorMeasure, openRightTab, requireTermicApi, snap, textOf, waitGone,
  waitPtyQuiet,
  waitForAgentReady, waitForAppShell, waitForText, waitVisible,
} from "../helpers";
import { dataDir } from "../../wdio.conf.js";

/** `execSync` for git in the task's worktree, retrying a moment on
 *  `index.lock` (the app's own status refresh can hold it). */
function execGit(cmd: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      execSync(cmd, { stdio: "ignore" });
      return;
    } catch (e: any) {
      const msg = `${e?.message ?? ""}${e?.stderr ?? ""}`;
      if (attempt >= 40 || !msg.includes("index.lock")) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Radix menus open on pointerdown, so a bare .click() is not enough. */
async function openMenu(selector: string): Promise<void> {
  await browser.execute((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const opts = { bubbles: true, pointerType: "mouse", button: 0 } as any;
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.click();
  }, selector);
  await waitVisible('[role="menu"]');
}

async function clickIn(selector: string): Promise<void> {
  await waitVisible(selector);
  await browser.execute((sel) => (document.querySelector(sel) as HTMLElement).click(), selector);
}

const shownReview = () =>
  browser.execute(() =>
    document.querySelector('[data-testid="compare-panel"]')?.getAttribute("data-review") ?? null,
  ) as Promise<string | null>;

const waitForReview = (id: string, msg: string) =>
  browser.waitUntil(async () => (await shownReview()) === id, { timeout: 15_000, timeoutMsg: msg });

/** Starts recording every view a reveal commits on its way, painted or not:
 *  a right tab other than Git, or a Git sub-tab other than Compare, that was
 *  active and then switched off. A view mounted straight onto Compare leaves
 *  no record. */
const watchDetours = () =>
  browser.execute(() => {
    const w = window as any;
    w.__presentDetour = [];
    w.__presentObs = new MutationObserver((recs) => {
      for (const r of recs) {
        const el = r.target as HTMLElement;
        if (r.oldValue !== "true") continue;
        const id = el.getAttribute("data-testid");
        if ((id === "right-tab" && el.getAttribute("data-tab") !== "Git")
          || (id?.startsWith("git-view-") && id !== "git-view-compare")) {
          w.__presentDetour.push(el.getAttribute("data-tab") ?? id);
        }
      }
    });
    w.__presentObs.observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ["data-active"], attributeOldValue: true,
    });
  });

/** Stops the recorder and returns what it saw. */
const detours = () =>
  browser.execute(() => {
    const w = window as any;
    w.__presentObs.disconnect();
    return w.__presentDetour as string[];
  }) as Promise<string[]>;

/** The compare rows on screen, as path → status. */
const rows = () =>
  browser.execute(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid="compare-file-row"]')].map((e) => [
        e.getAttribute("data-path"),
        e.getAttribute("data-status"),
      ]),
    ),
  ) as Promise<Record<string, string>>;

/** Every line a fixture agent has read, across tasks. Written by the agent
 *  itself, so a line here was READ, not just queued. */
function promptsLog(): string {
  try {
    return readFileSync(path.join(dataDir, "e2e-agent-prompts.log"), "utf8");
  } catch {
    return "";
  }
}

// Agent-presented reviews: `termic present` drives the real control socket,
// the user's side (reading, replying, sending) is the real DOM.
describe("agent-presented review", () => {
  let taskId!: string;
  let otherId!: string;
  let agentTab = "";
  const stamp = Date.now();
  const branch = `e2e-present-${stamp}`;

  /** Open a thread through the real socket and return its id. */
  const comment = async (file: string, body: string, lines?: [number, number]) => {
    const r = await cliRpc({
      cmd: "present_comment", task: taskId, review: "r1", file, body,
      ...(lines ? { start_line: lines[0], end_line: lines[1] } : {}),
    });
    expect(r.ok).toBe(true);
    return r.data.thread_id as string;
  };

  /** The thread cards in the visible review diff. */
  const threadCards = () =>
    browser.execute((id) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null);
      return [...(pane?.querySelectorAll(".tc-thread-card") ?? [])].map(c => ({
        id: c.getAttribute("data-thread-id"),
        authors: [...c.querySelectorAll(".tc-thread-author")].map(a => a.textContent),
        bodies: [...c.querySelectorAll(".tc-comment-body")].map(b => b.textContent),
        top: c.closest(".cm-content")?.firstElementChild?.contains(c) ?? false,
      }));
    }, taskId) as Promise<{ id: string; authors: string[]; bodies: string[]; top: boolean }[]>;

  /** How far the line numbers sit from their lines in the visible review
   *  diff. Flushed first, since the occluded harness window never runs
   *  CodeMirror's rAF measure. */
  const drift = async () => {
    expect(await flushEditorMeasure()).toBeGreaterThan(0);
    return browser.execute((tid) => {
      const ed = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"] .cm-editor`)]
        .find((e) => e.getBoundingClientRect().height > 0)!;
      const lines = [...ed.querySelector(".cm-content")!.children].filter((el) => el.classList.contains("cm-line"));
      const nums = [...ed.querySelectorAll(".cm-lineNumbers .cm-gutterElement")]
        .filter((el) => getComputedStyle(el).visibility !== "hidden");
      const d = lines.map((l, i) => (nums[i]?.getBoundingClientRect().top ?? NaN) - l.getBoundingClientRect().top);
      return { lines: lines.length, nums: nums.length, spread: Math.max(...d) - Math.min(...d) };
    }, taskId);
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    otherId = await createWorktreeTask("e2e-present-other", `${branch}-other`, false);
    taskId = await createWorktreeTask("e2e-present", branch);
    await waitForAgentReady(taskId);
    const { cwd, tab } = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return {
        cwd: s.tasks.find((t: any) => t.id === id).path as string,
        tab: (s.tabs[id] ?? [])[0].id as string,
      };
    }, taskId);
    agentTab = tab;
    // One commit with an add and a modify: the range the agent presents.
    writeFileSync(path.join(cwd, "present-a.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(path.join(cwd, "README.md"), `# presented ${stamp}\n`);
    execGit(`git -C "${cwd}" add present-a.txt README.md`);
    execGit(`git -C "${cwd}" commit -q -m "e2e present ${stamp}"`);
  });

  after(async () => {
    // The Git sub-tab is persisted: hand the next spec the staging view.
    await browser.execute(() => {
      const ui = window.__termic!.useApp.getState();
      if (ui.rightPanelHidden) ui.toggleRightPanel();
    }).catch(() => {});
    await clickIn('[data-testid="git-view-commit"]').catch(() => {});
    if (taskId) await archiveTask(taskId);
    if (otherId) await archiveTask(otherId);
  });

  it("puts the Git tab on Compare in review mode without moving the active tab or focus", async () => {
    await ensureActiveTask(taskId);
    // Git status loaded on the commit sub-tab, then All files: the reveal
    // mounts GitPanel with status in hand, so a late switch would show.
    await openRightTab("Git");
    await clickIn('[data-testid="git-view-commit"]');
    await openRightTab("All files");
    const before = await browser.execute((id) => ({
      tab: window.__termic!.useApp.getState().activeTab[id] ?? null,
      focus: document.activeElement?.outerHTML.slice(0, 120) ?? null,
    }), taskId);

    await watchDetours();
    const r = await cliRpc({
      cmd: "present_new", task: taskId, range: "main..HEAD", title: "Split the parser", tab: agentTab,
    });
    expect(r.ok).toBe(true);
    expect(r.data.review.id).toBe("r1");

    await waitForReview("r1", "Compare never entered review mode for r1");
    // All files was on screen before the reveal; only the Git sub-tab could detour.
    expect((await detours()).filter(d => d !== "All files")).toEqual([]);
    await waitForText("FakeAgent opened a review: Split the parser");
    const bar = await browser.execute(() => ({
      title: (document.querySelector('[data-testid="compare-review"]') as HTMLElement).innerText,
      range: (document.querySelector('[data-testid="compare-review-range"]') as HTMLElement).innerText,
      author: (document.querySelector('[data-testid="compare-review-author"]') as HTMLElement).innerText,
      gitTab: document.querySelector('[data-testid="right-tab"][data-tab="Git"]')?.getAttribute("data-active"),
      compare: document.querySelector('[data-testid="git-view-compare"]')?.getAttribute("data-active"),
    }));
    expect(bar.title).toBe("Split the parser");
    expect(bar.range.replace(/\s+/g, " ")).toBe("main HEAD");
    expect(bar.author).toBe("by FakeAgent");
    expect(bar.gitTab).toBe("true");
    expect(bar.compare).toBe("true");

    await browser.waitUntil(async () => "present-a.txt" in (await rows()), {
      timeout: 15_000, timeoutMsg: "the review's files never listed",
    });
    expect(await rows()).toEqual({ "present-a.txt": "A", "README.md": "M" });

    const after = await browser.execute((id) => ({
      tab: window.__termic!.useApp.getState().activeTab[id] ?? null,
      focus: document.activeElement?.outerHTML.slice(0, 120) ?? null,
      reveal: window.__termic!.useUI.getState().reviewReveal,
    }), taskId);
    expect(after.tab).toBe(before.tab);
    expect(after.focus).toBe(before.focus);
    // Consumed, or every later task switch would re-pin the Git tab.
    expect(after.reveal).toBeNull();
    await snap("present-review-mode.png");
  });

  it("opens a row as a review diff with no viewed mark, and a Comment button for a file-level thread", async () => {
    await clickIn('[data-testid="compare-file-row"][data-path="present-a.txt"]');
    const scope = await browser.waitUntil(
      () => browser.execute((id) =>
        (window.__termic!.useApp.getState().tabs[id] ?? [])
          .find((t: any) => t.type === "diff" && t.path === "present-a.txt")?.scope ?? null, taskId),
      { timeout: 10_000, timeoutMsg: "no diff tab opened from the review list" },
    );
    expect(scope).toBe("review:r1");
    // Scope is part of tab identity, so the branch-compare diff of the same
    // file can sit beside this one: the title and header tell them apart.
    const title = await browser.execute((id) =>
      (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.scope === "review:r1")?.title ?? null, taskId);
    expect(title).toBe("Δ present-a.txt · r1");
    await browser.waitUntil(
      () => browser.execute((id) =>
        [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
          .some(e => e.getAttribute("data-diff-loaded") === "1" && (e as HTMLElement).offsetParent !== null), taskId),
      { timeout: 10_000, timeoutMsg: "the review diff never loaded" },
    );
    const chrome = await browser.execute((id) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null) as HTMLElement;
      return pane.innerText;
    }, taskId);
    const chip = await browser.execute((id) =>
      ([...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-review-chip"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined)?.innerText ?? null, taskId);
    expect(chip).toBe("r1");
    expect(chrome).not.toContain("Mark as viewed");
    expect(chrome).toMatch(/\bComment\b/);
    await snap("present-review-chip.png");
  });

  it("shows an agent's line comment live in the open diff, with the agent's name", async () => {
    const id = await comment("present-a.txt", "beta needs a test", [2, 2]);

    await browser.waitUntil(async () => (await threadCards()).some(c => c.id === id), {
      timeout: 10_000, timeoutMsg: "the line thread never rendered in the open diff",
    });
    const card = (await threadCards()).find(c => c.id === id)!;
    expect(card.authors).toEqual(["FakeAgent"]);
    expect(card.bodies).toEqual(["beta needs a test"]);
  });

  it("puts a file-level comment at the top of the diff", async () => {
    const id = await comment("present-a.txt", "new file, read it whole");

    await browser.waitUntil(async () => (await threadCards()).some(c => c.id === id), {
      timeout: 10_000, timeoutMsg: "the file-level thread never rendered",
    });
    expect((await threadCards()).find(c => c.id === id)!.top).toBe(true);

    // The cards are block widgets above and between lines: the numbers must
    // stay level with the code (GH #157).
    await browser.waitUntil(async () => { const m = await drift(); return m.nums === m.lines && m.spread < 2; }, {
      timeout: 10_000, timeoutMsg: "the line numbers never settled level with the code around the thread cards",
    });
    await snap("present-thread-cards.png");
  });

  it("counts threads on the file's row and awaiting agent comments on the Compare tab", async () => {
    const read = () => browser.execute(() => ({
      row: (document.querySelector(
        '[data-testid="compare-file-row"][data-path="present-a.txt"] [data-testid="compare-thread-count"]',
      ) as HTMLElement | null)?.innerText ?? null,
      other: document.querySelector(
        '[data-testid="compare-file-row"][data-path="README.md"] [data-testid="compare-thread-count"]',
      ) !== null,
      awaiting: (document.querySelector('[data-testid="git-compare-awaiting"]') as HTMLElement | null)?.innerText ?? null,
    }));
    await browser.waitUntil(async () => (await read()).row === "2", {
      timeout: 10_000, timeoutMsg: "the row never counted its two threads",
    });
    expect(await read()).toEqual({ row: "2", other: false, awaiting: "2" });
  });

  it("goes back to branch compare and returns to the review from the base picker", async () => {
    await openMenu('[data-testid="compare-review"]');
    await clickIn('[data-testid="compare-review-exit"]');
    await waitForReview("", "Back to branch compare left the panel in review mode");
    await waitVisible('[data-testid="compare-base"]');

    await openMenu('[data-testid="compare-base"]');
    await clickIn('[data-testid="compare-review-item"][data-review="r1"]');
    await waitForReview("r1", "the base picker's Reviews group never reopened r1");
  });

  it("never un-hides a hidden right panel, and opens it straight onto the review", async () => {
    // Persist a different Git sub-tab and leave the panel on All files, so a
    // remount that honoured the reveal late would commit either on the way.
    await openRightTab("Git");
    await clickIn('[data-testid="git-view-commit"]');
    await openRightTab("All files");
    await browser.execute(() => {
      const s = window.__termic!.useApp.getState();
      if (!s.rightPanelHidden) s.toggleRightPanel();
    });
    await browser.waitUntil(
      () => browser.execute(() => !document.querySelector('[data-testid="compare-panel"]')),
      { timeout: 5_000, timeoutMsg: "the right panel never hid" },
    );

    const r = await cliRpc({ cmd: "present_new", task: taskId, range: "main..HEAD", title: "Round two", tab: agentTab });
    expect(r.ok).toBe(true);
    await waitForText("FakeAgent opened a review: Round two");
    expect(await browser.execute(() => window.__termic!.useApp.getState().rightPanelHidden)).toBe(true);

    await watchDetours();
    await browser.execute(() => window.__termic!.useApp.getState().toggleRightPanel());
    await waitForReview("r2", "the un-hidden panel did not show the new review");
    expect(await detours()).toEqual([]);
  });

  it("leaves another task's panel alone and shows the review when its task is switched to", async () => {
    await ensureActiveTask(otherId);
    await openRightTab("Git");
    await clickIn('[data-testid="git-view-commit"]');
    await openRightTab("All files");

    const r = await cliRpc({ cmd: "present_new", task: taskId, range: "main..HEAD", title: "Background round", tab: agentTab });
    expect(r.ok).toBe(true);
    await browser.waitUntil(
      () => browser.execute(() => window.__termic!.useUI.getState().reviewReveal?.reviewId === "r3"),
      { timeout: 10_000, timeoutMsg: "present_new never raised the reveal for r3" },
    );
    const files = await browser.execute(() =>
      document.querySelector('[data-testid="right-tab"][data-tab="All files"]')?.getAttribute("data-active"));
    expect(files).toBe("true");

    // The Git tab of the active task keeps its own sub-tab, and the reveal
    // stays pending for the task it names.
    await openRightTab("Git");
    await waitVisible('[data-testid="git-view-commit"][data-active="true"]');
    const other = await browser.execute(() => ({
      compare: !!document.querySelector('[data-testid="compare-panel"]'),
      reveal: window.__termic!.useUI.getState().reviewReveal?.taskId ?? null,
    }));
    expect(other).toEqual({ compare: false, reveal: taskId });

    await ensureActiveTask(taskId);
    await waitForReview("r3", "switching to the task never showed the pending review");
    const after = await browser.execute(() => ({
      gitTab: document.querySelector('[data-testid="right-tab"][data-tab="Git"]')?.getAttribute("data-active"),
      compare: document.querySelector('[data-testid="git-view-compare"]')?.getAttribute("data-active"),
      reveal: window.__termic!.useUI.getState().reviewReveal,
    }));
    expect(after).toEqual({ gitTab: "true", compare: "true", reveal: null });
  });

  // ── The user's half: reply, new thread, Send, queue, claim ──────────────

  /** The review:r1 diff of present-a.txt, made the active tab. */
  const showReviewDiff = async () => {
    const tab = await browser.execute((id) =>
      (window.__termic!.useApp.getState().tabs[id] ?? [])
        .find((t: any) => t.scope === "review:r1" && t.path === "present-a.txt")?.id as string, taskId);
    await browser.execute((id, t) => window.__termic!.useApp.getState().setActiveTabId(id, t), taskId, tab);
    await browser.waitUntil(
      () => browser.execute((id) =>
        [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
          .some(e => e.getAttribute("data-diff-loaded") === "1" && (e as HTMLElement).offsetParent !== null), taskId),
      { timeout: 10_000, timeoutMsg: "the review diff never came back on screen" },
    );
    return tab;
  };

  /** Click a control inside the visible review diff. */
  const clickInDiff = (selector: string) =>
    browser.execute((id, sel) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null)!;
      const el = pane.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`nothing in the review diff matches ${sel}`);
      el.click();
    }, taskId, selector);

  /** Write `body` into the open composer and press one of its buttons. */
  const compose = async (body: string, button: ".tc-btn-send" | ".tc-btn-queue") => {
    await waitVisible(".tc-comment-textarea");
    await browser.execute((text, btn) => {
      const ta = document.querySelector(".tc-comment-textarea") as HTMLTextAreaElement;
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      (document.querySelector(`.tc-comment-composer ${btn}`) as HTMLElement).click();
    }, body, button);
    await waitGone(".tc-comment-textarea");
  };

  /** What one agent tab's terminal holds (xterm draws to a canvas). */
  const tabLogs = async (tab: string) => {
    const r = await cliRpc({ cmd: "logs", task: taskId, tab });
    return r.ok ? (r.data.data as string) : "";
  };

  const agentState = (tab: string) =>
    browser.execute((id, t) => {
      const x: any = (window.__termic!.useApp.getState().tabs[id] ?? []).find((y: any) => y.id === t);
      return { work: x?.workState ?? null, queue: (x?.queue ?? []).map((q: any) => q.text as string) };
    }, taskId, tab) as Promise<{ work: string | null; queue: string[] }>;

  /** The turn a delivered message started is over, so the next send is not
   *  queued behind it. "done" rather than "not working": a send resets the
   *  tab to idle before its turn registers. The tab is never active here, so
   *  nothing resets "done" either. */
  const waitTurnOver = (tab: string) =>
    browser.waitUntil(async () => { const s = await agentState(tab); return s.work === "done" && !s.queue.length; },
      { timeout: 30_000, timeoutMsg: "the agent never finished the previous delivery's turn" });

  it("sends a reply from its thread to the review's agent with the thread id, without moving tab or focus", async () => {
    const diffTab = await showReviewDiff();
    const body = `beta is covered ${stamp}`;

    // Reply is on screen without a hover, unlike a draft card's Edit/Delete.
    expect(await browser.execute((id) => {
      const btn = [...document.querySelectorAll(`[data-task-id="${id}"] [data-thread-id="r1-t1"] .tc-btn-reply`)]
        .find(e => (e as HTMLElement).offsetParent !== null);
      return btn ? getComputedStyle(btn.parentElement!).opacity : null;
    }, taskId)).toBe("1");
    await clickInDiff('[data-thread-id="r1-t1"] .tc-btn-reply');
    await waitVisible(".tc-comment-composer");
    expect(await textOf(".tc-comment-composer .tc-comment-loc")).toBe("Reply to r1-t1 · present-a.txt · line 2");
    await compose(body, ".tc-btn-send");

    await browser.waitUntil(async () => {
      const out = await tabLogs(agentTab);
      return out.includes(body) && out.includes("r1-t1") && out.includes("present reply");
    }, { timeout: 30_000, timeoutMsg: "the reply never reached the review's agent tab" });
    await browser.waitUntil(async () => {
      const card = (await threadCards()).find(c => c.id === "r1-t1");
      return card?.authors.join() === "FakeAgent,You" && card.bodies[1] === body;
    }, { timeout: 10_000, timeoutMsg: "the reply never showed under its thread" });
    // A diff editor refuses focus (editable: false), so the composer's close
    // hands it to the diff's tab host: still in the diff, never the terminal.
    const after = await browser.execute((id, d) => ({
      tab: window.__termic!.useApp.getState().activeTab[id] ?? null,
      inDiffTab: !!document.activeElement?.closest(`[data-main-tab-id="${CSS.escape(d)}"]`),
    }), taskId, diffTab);
    expect(after).toEqual({ tab: diffTab, inDiffTab: true });
    await snap("present-reply-sent.png");
  });

  it("batches a reply and a new thread on a line through the bar's Send as one message", async () => {
    await waitTurnOver(agentTab);
    await showReviewDiff();
    const reply = `file-level reply ${stamp}`;
    const fresh = `gamma wants a name ${stamp}`;

    await clickInDiff('[data-thread-id="r1-t2"] .tc-btn-reply');
    await compose(reply, ".tc-btn-queue");
    // A new thread the way a user starts one: select the line, take the pill.
    await browser.execute((id) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null)!;
      const line = [...pane.querySelectorAll(".cm-content > .cm-line")].find(el => el.textContent?.trim() === "gamma");
      if (!line) throw new Error("no rendered gamma line in the review diff");
      const range = document.createRange();
      range.selectNodeContents(line);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    }, taskId);
    await waitVisible(".tc-add-comment-btn");
    await browser.execute(() => document.querySelector(".tc-add-comment-btn")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    await compose(fresh, ".tc-btn-queue");
    await waitForText("Pending reply to r1-t2 · present-a.txt · whole file");
    await snap("present-pending-drafts.png");

    // The pending bar lives on the terminal footer: go there as a user would.
    await browser.execute((id, t) => window.__termic!.useApp.getState().setActiveTabId(id, t), taskId, agentTab);
    await waitVisible('[data-testid="review-comments-pill"]');
    expect(await textOf('[data-testid="review-comments-pill"]')).toContain("2 pending comments");
    // Open and send in one retried step: see editor.e2e.ts on the terminal's
    // next-frame focus closing a just-opened popover.
    let tag = "";
    await browser.waitUntil(
      () => browser.execute(() => {
        const send = document.querySelector('[data-testid="review-comments-send"]') as HTMLElement | null;
        if (send) {
          const t = document.querySelector('[data-testid="review-comments-review-tag"]')?.textContent ?? "";
          send.click();
          return t || "untagged";
        }
        const pill = document.querySelector('[data-testid="review-comments-pill"]') as HTMLElement | null;
        if (pill?.getAttribute("data-state") === "closed") pill.click();
        return false;
      }).then(r => { if (r) tag = r as string; return !!r; }),
      { timeout: 8_000, timeoutMsg: "the Send button never appeared" },
    );
    expect(tag).toBe("→ Split the parser");

    await browser.waitUntil(async () => {
      const out = await tabLogs(agentTab);
      return out.includes(reply) && out.includes(fresh) && out.includes("The user left 2 comments")
        && out.includes("(thread r1-t2)") && /present-a\.txt:3 \(thread r1-t\d+, new thread\)/.test(out);
    }, { timeout: 30_000, timeoutMsg: "the batch never reached the agent as one message" });
    await browser.waitUntil(
      () => browser.execute(() => !document.querySelector('[data-testid="review-comments-pill"]')),
      { timeout: 8_000, timeoutMsg: "the pending list was not emptied by Send" },
    );
  });

  it("queues a reply while the review's agent is mid-turn and delivers it when the turn ends", async () => {
    // The batch's turn ran on the ACTIVE agent tab, where "done" does not
    // stick: wait for the agent to have read it and fallen quiet instead.
    await browser.waitUntil(() => promptsLog().includes(`gamma wants a name ${stamp}`),
      { timeout: 30_000, timeoutMsg: "the agent never read the batch" });
    await waitPtyQuiet(taskId, 2_000);
    await browser.waitUntil(async () => { const s = await agentState(agentTab); return s.work !== "working" && !s.queue.length; },
      { timeout: 15_000, timeoutMsg: "the batch's turn never ended" });
    expect((await cliRpc({ cmd: "send", task: taskId, tab: agentTab, prompt: "#longwork" })).ok).toBe(true);
    await browser.waitUntil(async () => (await agentState(agentTab)).work === "working",
      { timeout: 15_000, timeoutMsg: "the long turn never registered as working" });
    const diffTab = await showReviewDiff();
    const body = `queued behind a turn ${stamp}`;

    await clickInDiff('[data-thread-id="r1-t1"] .tc-btn-reply');
    await compose(body, ".tc-btn-send");

    await browser.waitUntil(async () => (await agentState(agentTab)).queue.some(q => q.includes(body)),
      { timeout: 10_000, timeoutMsg: "the reply never joined the busy agent's queue" });
    await waitForText("Queued 1 comment for");
    expect(promptsLog()).not.toContain(body);
    expect(await browser.execute((id) => window.__termic!.useApp.getState().activeTab[id], taskId)).toBe(diffTab);

    // Any keystroke ends the fixture's long turn; the drain is termic's.
    expect((await cliRpc({ cmd: "send", task: taskId, tab: agentTab, prompt: "x", now: true })).ok).toBe(true);
    await browser.waitUntil(() => promptsLog().includes(body),
      { timeout: 90_000, interval: 500, timeoutMsg: "the queued reply was never delivered after the turn" });
  });

  it("shows the agent's present_reply live under the thread", async () => {
    await showReviewDiff();
    const body = `agent answers ${stamp}`;

    const r = await cliRpc({ cmd: "present_reply", task: taskId, thread: "r1-t1", body });
    expect(r.ok).toBe(true);

    await browser.waitUntil(async () => {
      const card = (await threadCards()).find(c => c.id === "r1-t1");
      return card?.bodies.at(-1) === body && card.authors.at(-1) === "FakeAgent";
    }, { timeout: 10_000, timeoutMsg: "the agent's reply never showed in the open diff" });
  });

  it("sends to the tab that claimed the review, not the one that opened it", async () => {
    const opened = await cliRpc({ cmd: "tab", task: taskId, kind: { tab: "agent", id: "fakeagent" }, title: "claimer" });
    expect(opened.ok).toBe(true);
    const claimer = opened.data.tab_id as string;
    await browser.waitUntil(async () => (await tabLogs(claimer)).includes("FAKE-AGENT ready"),
      { timeout: 20_000, timeoutMsg: "the claiming agent tab never started" });
    // The CLI server checks the tab against the agent list the webview pushes,
    // which reaches it a beat after the tab opens.
    await browser.waitUntil(async () => (await cliRpc({ cmd: "present_claim", task: taskId, review: "r1", tab: claimer })).ok,
      { timeout: 10_000, timeoutMsg: "present_claim never accepted the new agent tab" });
    await showReviewDiff();
    const body = `for the new owner ${stamp}`;

    await clickInDiff('[data-thread-id="r1-t2"] .tc-btn-reply');
    await compose(body, ".tc-btn-send");

    await browser.waitUntil(async () => (await tabLogs(claimer)).includes(body),
      { timeout: 30_000, timeoutMsg: "the reply never reached the claiming tab" });
    expect(await tabLogs(agentTab)).not.toContain(body);
  });

  // ── Resolve / unresolve ─────────────────────────────────────────────────

  /** The Compare sub-tab's awaiting pill; it is not rendered at 0. */
  const awaiting = () =>
    browser.execute(() => Number(
      (document.querySelector('[data-testid="git-compare-awaiting"]') as HTMLElement | null)?.innerText ?? 0,
    )) as Promise<number>;

  /** One thread card's resolved state as the visible review diff draws it. */
  const cardState = (threadId: string) =>
    browser.execute((id, th) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${id}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null);
      const card = pane?.querySelector<HTMLElement>(`.tc-thread-card[data-thread-id="${th}"]`);
      if (!card) return null;
      const entry = card.querySelector(".tc-thread-entry");
      return {
        resolved: card.dataset.resolved ?? null,
        chip: card.querySelector(".tc-thread-chip")?.textContent ?? null,
        entries: entry ? getComputedStyle(entry).display : null,
      };
    }, taskId, threadId) as Promise<{ resolved: string | null; chip: string | null; entries: string | null } | null>;

  const waitResolved = (threadId: string, resolved: boolean, msg: string) =>
    browser.waitUntil(async () => (await cardState(threadId))?.resolved === String(resolved), { timeout: 10_000, timeoutMsg: msg });

  it("collapses a thread the agent resolves behind a Resolved chip and drops it from the awaiting count", async () => {
    await showReviewDiff();
    const before = await awaiting();

    const r = await cliRpc({ cmd: "present_resolve", task: taskId, thread: "r1-t1", resolved: true });

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ thread_id: "r1-t1", resolved: true, changed: true });
    await waitResolved("r1-t1", true, "the agent's resolve never reached the open diff");
    expect(await cardState("r1-t1")).toEqual({ resolved: "true", chip: "Resolved", entries: "none" });
    expect((await cardState("r1-t2"))?.resolved).toBe("false");
    await browser.waitUntil(async () => (await awaiting()) === before - 1,
      { timeout: 10_000, timeoutMsg: "the awaiting count never dropped for the resolved thread" });
    // The earlier background-task case left the panel on r3: back to r1, whose
    // file holds three threads, one now resolved. The row counts open ones only.
    await openMenu('[data-testid="compare-review"]');
    await clickIn('[data-testid="compare-review-item"][data-review="r1"]');
    await waitForReview("r1", "the review picker never switched back to r1");
    const rowCount = () => browser.execute(() => (document.querySelector(
      '[data-testid="compare-file-row"][data-path="present-a.txt"] [data-testid="compare-thread-count"]',
    ) as HTMLElement | null)?.innerText ?? null);
    await browser.waitUntil(async () => (await rowCount()) === "2",
      { timeout: 10_000, timeoutMsg: "the row never counted only the two open threads" });
    await browser.waitUntil(async () => { const m = await drift(); return m.nums === m.lines && m.spread < 2; }, {
      timeout: 10_000, timeoutMsg: "the line numbers drifted after a thread collapsed",
    });
    await snap("present-thread-resolved.png");
  });

  it("expands a resolved thread from its location toggle with the line numbers still level", async () => {
    await showReviewDiff();

    await clickInDiff('[data-thread-id="r1-t1"] .tc-thread-toggle');

    expect((await cardState("r1-t1"))?.entries).not.toBe("none");
    await browser.waitUntil(async () => { const m = await drift(); return m.nums === m.lines && m.spread < 2; }, {
      timeout: 10_000, timeoutMsg: "the line numbers drifted after expanding a resolved thread",
    });
  });

  it("reopens a thread from its Unresolve button and stores it open", async () => {
    await showReviewDiff();
    const before = await awaiting();

    await clickInDiff('[data-thread-id="r1-t1"] .tc-btn-resolve');

    await waitResolved("r1-t1", false, "Unresolve never reopened the card");
    const shown = await cliRpc({ cmd: "present_show", task: taskId, review: "r1" });
    expect(shown.data.review.threads.find((t: any) => t.id === "r1-t1").resolved).toBeUndefined();
    await browser.waitUntil(async () => (await awaiting()) === before + 1,
      { timeout: 10_000, timeoutMsg: "the awaiting count never came back for the reopened thread" });
  });

  it("reopens a thread the user resolved when the agent replies in it", async () => {
    await showReviewDiff();
    const open = await awaiting();
    await clickInDiff('[data-thread-id="r1-t1"] .tc-btn-resolve');
    await waitResolved("r1-t1", true, "Resolve never collapsed the card");
    await browser.waitUntil(async () => (await awaiting()) === open - 1,
      { timeout: 10_000, timeoutMsg: "the user's resolve never lowered the awaiting count" });

    const r = await cliRpc({ cmd: "present_reply", task: taskId, thread: "r1-t1", body: `reopened ${stamp}` });

    expect(r.ok).toBe(true);
    await waitResolved("r1-t1", false, "the agent's reply never reopened the thread");
    await browser.waitUntil(async () => (await awaiting()) === open,
      { timeout: 10_000, timeoutMsg: "the awaiting count never came back after the agent's reply" });
  });

  // ── Thread list ─────────────────────────────────────────────────────────

  /** The Compare thread list's rows as drawn. */
  const threadRows = () =>
    browser.execute(() => [...document.querySelectorAll<HTMLElement>('[data-testid="compare-thread-row"]')].map(r => ({
      id: r.dataset.thread!,
      loc: r.querySelector('[data-testid="compare-thread-loc"]')?.textContent ?? null,
      author: r.querySelector('[data-testid="compare-thread-author"]')?.textContent ?? null,
      comments: r.querySelector('[data-testid="compare-thread-comments"]')?.textContent ?? null,
      awaiting: r.dataset.awaiting!,
      resolved: r.dataset.resolved!,
    }))) as Promise<{ id: string; loc: string | null; author: string | null; comments: string | null; awaiting: string; resolved: string }[]>;

  /** Row lists compared field by field: objects back from WebKit come in any key order. */
  const same = (a: Record<string, unknown>[], b: Record<string, unknown>[]) =>
    a.length === b.length && a.every((r, i) => Object.keys(b[i]).every(k => r[k] === b[i][k]));

  /** The rows the list should draw, derived from the stored review rather than hardcoded. */
  const expectedRows = async (reviewId: string) => {
    const r = await cliRpc({ cmd: "present_show", task: taskId, review: reviewId });
    expect(r.ok).toBe(true);
    return (r.data.review.threads as any[]).map((th) => {
      const last = th.comments[th.comments.length - 1];
      const base = th.file.split("/").pop();
      const loc = th.start_line === null ? base
        : th.end_line === null || th.end_line === th.start_line ? `${base}:${th.start_line}`
        : `${base}:${th.start_line}–${th.end_line}`;
      return {
        id: th.id, loc, author: last.by === "user" ? "You" : last.author, comments: String(th.comments.length),
        awaiting: !th.resolved && last.by === "agent" ? "1" : "0", resolved: th.resolved ? "1" : "0",
      };
    });
  };

  it("lists the shown review's threads with id, place, last author and comment count", async () => {
    await waitForReview("r1", "the panel is not on r1");
    await browser.waitUntil(async () => same(await threadRows(), await expectedRows("r1")),
      { timeout: 10_000, timeoutMsg: "the thread list never matched r1's threads" });
    const before = (await threadRows()).find(r => r.id === "r1-t2")!;

    const r = await cliRpc({ cmd: "present_reply", task: taskId, thread: "r1-t2", body: `listed ${stamp}` });

    expect(r.ok).toBe(true);
    await browser.waitUntil(async () => (await threadRows()).find(r => r.id === "r1-t2")?.comments === String(Number(before.comments) + 1),
      { timeout: 10_000, timeoutMsg: "the row never counted the agent's reply" });
    expect((await threadRows()).find(r => r.id === "r1-t2")).toMatchObject({ author: "FakeAgent", awaiting: "1" });
    expect(await threadRows()).toEqual(await expectedRows("r1"));
    await snap("present-thread-list.png");

    await clickIn('[data-testid="compare-threads-toggle"]');
    const hidden = (await threadRows()).length;
    await clickIn('[data-testid="compare-threads-toggle"]');
    expect(hidden).toBe(0);
    expect((await threadRows()).length).toBe((await expectedRows("r1")).length);
  });

  describe("revealing a thread from the list", () => {
    let reviewId = "";
    const thread = async (file: string, lines?: [number, number]) => {
      const r = await cliRpc({
        cmd: "present_comment", task: taskId, review: reviewId, file, body: `on ${file} ${lines?.[0] ?? "file"}`,
        ...(lines ? { start_line: lines[0], end_line: lines[1] } : {}),
      });
      expect(r.ok).toBe(true);
      return r.data.thread_id as string;
    };
    let t20 = "", t190 = "", tLong = "", tNotes = "";

    /** The visible review diff: whether `threadId`'s card sits inside its scroll
     *  host, the folds on each merge pane, and the new-file preview. */
    const revealState = (threadId: string) =>
      browser.execute((tid, th) => {
        const pane = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
          .find(e => (e as HTMLElement).offsetParent !== null);
        // Side-by-side scrolls the merge view's box, unified the editor's scroller.
        const host = (pane?.querySelector(".cm-mergeView") ?? pane?.querySelector(".cm-scroller")) as HTMLElement | null;
        const card = pane?.querySelector<HTMLElement>(`.tc-thread-card[data-thread-id="${th}"]`);
        const h = host?.getBoundingClientRect();
        const c = card?.getBoundingClientRect();
        const entry = card?.querySelector(".tc-thread-entry");
        const preview = pane?.querySelector('[data-testid="diff-new-preview"]') as HTMLElement | null;
        return {
          scope: (window.__termic!.useApp.getState().tabs[tid] ?? [])
            .find((t: any) => t.id === window.__termic!.useApp.getState().activeTab[tid])?.scope ?? null,
          visible: !!(h && c && c.height > 0 && c.top >= h.top && c.top < h.bottom),
          expanded: entry ? getComputedStyle(entry).display !== "none" : null,
          foldsA: pane?.querySelectorAll(".cm-merge-a .cm-collapsedLines").length ?? 0,
          foldsB: pane?.querySelectorAll(".cm-merge-b .cm-collapsedLines").length ?? 0,
          preview: !!preview && preview.offsetParent !== null,
          scrollTop: host?.scrollTop ?? 0,
        };
      }, taskId, threadId);

    /** Scrolls the visible diff to the bottom until `threadId`'s card is out of view. */
    const scrollAwayFrom = (threadId: string) =>
      browser.waitUntil(async () => {
        await browser.execute((tid) => {
          const pane = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
            .find(e => (e as HTMLElement).offsetParent !== null)!;
          const host = (pane.querySelector(".cm-mergeView") ?? pane.querySelector(".cm-scroller")) as HTMLElement;
          host.scrollTop = host.scrollHeight;
        }, taskId);
        await flushEditorMeasure();
        return !(await revealState(threadId)).visible;
      }, { timeout: 10_000, timeoutMsg: `the diff never scrolled away from ${threadId}` });

    const waitRevealed = (threadId: string, msg: string) =>
      browser.waitUntil(async () => { await flushEditorMeasure(); return (await revealState(threadId)).visible; },
        { timeout: 10_000, timeoutMsg: msg });

    before(async () => {
      const cwd = await browser.execute((id) =>
        window.__termic!.useApp.getState().tasks.find((t: any) => t.id === id).path as string, taskId);
      const lines = Array.from({ length: 200 }, (_, i) => `long ${i + 1}`);
      writeFileSync(path.join(cwd, "present-long.txt"), `${lines.join("\n")}\n`);
      execGit(`git -C "${cwd}" add present-long.txt`);
      execGit(`git -C "${cwd}" commit -q -m "e2e present long ${stamp}"`);
      lines[189] = "long 190 edited";
      writeFileSync(path.join(cwd, "present-long.txt"), `${lines.join("\n")}\n`);
      writeFileSync(path.join(cwd, "present-notes.md"), "# Notes\n\nSome notes.\n");
      execGit(`git -C "${cwd}" add present-long.txt present-notes.md`);
      execGit(`git -C "${cwd}" commit -q -m "e2e present edit ${stamp}"`);
      const r = await cliRpc({ cmd: "present_new", task: taskId, range: "HEAD~1..HEAD", title: "Long file", tab: agentTab });
      expect(r.ok).toBe(true);
      reviewId = r.data.review.id;
      await waitForReview(reviewId, "the long-file review never showed");
      t20 = await thread("present-long.txt", [20, 20]);
      t190 = await thread("present-long.txt", [190, 190]);
      tLong = await thread("present-long.txt");
      tNotes = await thread("present-notes.md");
      await browser.execute(() => {
        localStorage.setItem("diffMode", "unified");
        localStorage.setItem("diffNewFileView", "preview");
      });
      await waitVisible(`[data-testid="compare-thread-row"][data-thread="${t20}"]`);
    });

    after(async () => {
      await browser.execute(() => localStorage.setItem("diffMode", "unified")).catch(() => {});
    });

    it("keeps a row's line suffix whole when its file name truncates", async () => {
      const suffixes = await browser.execute((ids) => ids.map((id) => {
        const loc = document.querySelector(`[data-testid="compare-thread-row"][data-thread="${id}"] [data-testid="compare-thread-loc"]`)!;
        const [name, suffix] = [...loc.children] as HTMLElement[];
        return { text: suffix.textContent, whole: suffix.scrollWidth <= suffix.clientWidth && suffix.getBoundingClientRect().right <= loc.getBoundingClientRect().right + 0.5, name: name.textContent };
      }), [t20, t190]);

      expect(suffixes).toEqual([
        { text: ":20", whole: true, name: "present-long.txt" },
        { text: ":190", whole: true, name: "present-long.txt" },
      ]);
    });

    it("opens a thread's diff scrolled to it, expanding the fold it sits in", async () => {
      await clickIn(`[data-testid="compare-thread-row"][data-thread="${t20}"]`);

      await waitRevealed(t20, "the line-20 card never came into view on open");
      expect((await revealState(t20)).scope).toBe(`review:${reviewId}`);
      await snap("present-thread-reveal.png");

      await scrollAwayFrom(t20);
      await clickIn(`[data-testid="compare-thread-row"][data-thread="${t20}"]`);

      await waitRevealed(t20, "a second click on the open diff never scrolled back to the card");
    });

    it("scrolls back to the top for a file-level thread", async () => {
      await clickIn(`[data-testid="compare-thread-row"][data-thread="${t20}"]`);
      await waitRevealed(t20, "the line-20 card never came into view");
      await scrollAwayFrom(tLong);

      await clickIn(`[data-testid="compare-thread-row"][data-thread="${tLong}"]`);

      await waitRevealed(tLong, "the file-level card never came back into view");
    });

    it("expands the fold on both sides in side-by-side", async () => {
      await clickIn('[data-testid="diff-mode-side"]');
      await browser.waitUntil(async () => (await revealState(t20)).foldsA > 0,
        { timeout: 10_000, timeoutMsg: "side-by-side never rebuilt with folds" });

      await clickIn(`[data-testid="compare-thread-row"][data-thread="${t20}"]`);

      await waitRevealed(t20, "the line-20 card never came into view in side-by-side");
      const s = await revealState(t20);
      expect(s.foldsA).toBe(s.foldsB);
      await clickIn('[data-testid="diff-mode-unified"]');
    });

    it("expands a resolved thread's card when revealing it", async () => {
      const r = await cliRpc({ cmd: "present_resolve", task: taskId, thread: t190, resolved: true });
      expect(r.ok).toBe(true);
      await browser.waitUntil(async () => (await revealState(t190)).expanded === false,
        { timeout: 10_000, timeoutMsg: "the resolved card never collapsed" });

      await clickIn(`[data-testid="compare-thread-row"][data-thread="${t190}"]`);

      await waitRevealed(t190, "the resolved card never came into view");
      expect((await revealState(t190)).expanded).toBe(true);
    });

    it("shows a new markdown file's thread in source, not preview", async () => {
      await clickIn(`[data-testid="compare-thread-row"][data-thread="${tNotes}"]`);

      await waitRevealed(tNotes, "the markdown file's thread never showed");
      expect((await revealState(tNotes)).preview).toBe(false);
      expect(await browser.execute(() => localStorage.getItem("diffNewFileView"))).toBe("preview");
    });
  });
});
