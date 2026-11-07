import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveTask, cliRpc, createWorktreeTask, ensureActiveTask, flushEditorMeasure, openRightTab, requireTermicApi, snap,
  waitForAgentReady, waitForAppShell, waitVisible,
} from "../helpers";

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

async function clickIn(selector: string): Promise<void> {
  await waitVisible(selector);
  await browser.execute((sel) => (document.querySelector(sel) as HTMLElement).click(), selector);
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

// Review rounds: `present update` after a new commit re-anchors threads and
// outdates the ones whose lines changed (docs/ui.md "Agent-presented reviews").
describe("review rounds", () => {
  let taskId!: string;
  let cwd = "";
  let reviewId = "";
  let tShifted = "", tChanged = "", tFile = "";
  const stamp = Date.now();
  const FILE = "rounds.txt";

  /** The visible review diff's thread cards: id, the code line just above the
   *  card (what it is pinned under), and its outdated chip. */
  const cards = () =>
    browser.execute((tid) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null);
      return [...(pane?.querySelectorAll(".tc-thread-card") ?? [])].map(c => {
        let el = c.closest(".cm-content > *")?.previousElementSibling ?? null;
        while (el && !el.classList.contains("cm-line")) el = el.previousElementSibling;
        return {
          id: c.getAttribute("data-thread-id")!,
          under: el?.textContent ?? null,
          chip: c.querySelector(".tc-thread-chip-outdated")?.textContent ?? null,
        };
      });
    }, taskId) as Promise<{ id: string; under: string | null; chip: string | null }[]>;

  const activeScope = () =>
    browser.execute((tid) => {
      const s = window.__termic!.useApp.getState();
      return (s.tabs[tid] ?? []).find((t: any) => t.id === s.activeTab[tid])?.scope ?? null;
    }, taskId) as Promise<string | null>;

  const show = async () => {
    const r = await cliRpc({ cmd: "present_show", task: taskId, review: reviewId });
    expect(r.ok).toBe(true);
    return r.data.review;
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await createWorktreeTask("e2e-rounds", `e2e-rounds-${stamp}`);
    await waitForAgentReady(taskId);
    const { path: p, tab } = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return { path: s.tasks.find((t: any) => t.id === id).path as string, tab: (s.tabs[id] ?? [])[0].id as string };
    }, taskId);
    cwd = p;
    writeFileSync(path.join(cwd, FILE), numbered(12).join("\n") + "\n");
    execGit(`git -C "${cwd}" add ${FILE}`);
    execGit(`git -C "${cwd}" commit -q -m "rounds 1 ${stamp}"`);

    const r = await cliRpc({ cmd: "present_new", task: taskId, range: "main..HEAD", title: "Rounds", tab });
    expect(r.ok).toBe(true);
    reviewId = r.data.review.id;
    const comment = async (body: string, lines?: [number, number]) => {
      const c = await cliRpc({
        cmd: "present_comment", task: taskId, review: reviewId, file: FILE, body,
        ...(lines ? { start_line: lines[0], end_line: lines[1] } : {}),
      });
      expect(c.ok).toBe(true);
      return c.data.thread_id as string;
    };
    tShifted = await comment("line ten", [10, 10]);
    tChanged = await comment("three and four", [3, 4]);
    tFile = await comment("whole file");
  });

  after(async () => {
    if (taskId) await archiveTask(taskId);
  });

  it("starts round 2: a shifted thread follows its line, a changed one goes outdated and is reported", async () => {
    await ensureActiveTask(taskId);
    await openRightTab("Git");
    await clickIn(`[data-testid="compare-file-row"][data-path="${FILE}"]`);
    await browser.waitUntil(async () => (await cards()).length === 3, {
      timeout: 15_000, timeoutMsg: "round 1's three threads never drew in the open diff",
    });
    await flushEditorMeasure();
    expect((await cards()).find(c => c.id === tShifted)?.under).toBe("line 10");

    // Two lines in at the top and old line 4 changed.
    const next = numbered(12);
    next[3] = "line four, rewritten";
    writeFileSync(path.join(cwd, FILE), ["top 1", "top 2", ...next].join("\n") + "\n");
    execGit(`git -C "${cwd}" commit -qam "rounds 2 ${stamp}"`);
    const r = await cliRpc({ cmd: "present_update", task: taskId, review: reviewId, head: "HEAD" });

    expect(r.ok).toBe(true);
    expect(r.data.round).toBe(2);
    expect(r.data.outdated.map((o: any) => [o.thread_id, o.start_line, o.end_line, o.round])).toEqual([[tChanged, 3, 4, 1]]);
    const stored = await show();
    const shifted = stored.threads.find((t: any) => t.id === tShifted);
    expect([shifted.start_line, shifted.origin?.start_line]).toEqual([12, 10]);
    // The open diff follows the latest round: it rebuilt on the new head, the
    // moved card sits under the same code, and the outdated one is gone.
    await browser.waitUntil(async () => {
      await flushEditorMeasure();
      const cs = await cards();
      return cs.length === 2 && cs.find(c => c.id === tShifted)?.under === "line 10";
    }, { timeout: 15_000, timeoutMsg: "the open diff never redrew round 2's threads" });
    expect((await cards()).map(c => c.id).sort()).toEqual([tFile, tShifted].sort());
    // Compare re-reads the range for the new round, so the row comes back a moment later.
    const bar = () => browser.execute((f) => ({
      count: (document.querySelector(`[data-testid="compare-file-row"][data-path="${f}"] [data-testid="compare-thread-count"]`) as HTMLElement | null)?.innerText ?? null,
      round: (document.querySelector('[data-testid="compare-review-round"]') as HTMLElement | null)?.innerText ?? null,
    }), FILE);
    await browser.waitUntil(async () => (await bar()).count !== null, {
      timeout: 10_000, timeoutMsg: "the file row never came back after the new round",
    });
    expect(await bar()).toEqual({ count: "2", round: "Round 2" });
  });

  it("lists an outdated thread with its snippet and opens the round it was made on", async () => {
    const row = `[data-testid="compare-thread-row"][data-thread="${tChanged}"]`;
    await waitVisible(row);
    const listed = await browser.execute((sel) => {
      const r = document.querySelector(sel) as HTMLElement;
      return {
        state: r.dataset.state,
        loc: r.querySelector('[data-testid="compare-thread-loc"]')?.textContent,
        snippet: r.querySelector('[data-testid="compare-thread-snippet"]')?.textContent,
      };
    }, row);
    expect(listed).toEqual({ state: "outdated", loc: `${FILE}:3–4`, snippet: "line 3" });

    await clickIn(row);

    await browser.waitUntil(async () => (await activeScope()) === `review:${reviewId}:to:1`, {
      timeout: 10_000, timeoutMsg: "the outdated thread did not open round 1",
    });
    await browser.waitUntil(async () => (await cards()).some(c => c.id === tChanged), {
      timeout: 15_000, timeoutMsg: "round 1's diff never drew the outdated thread",
    });
    await flushEditorMeasure();
    const card = (await cards()).find(c => c.id === tChanged)!;
    expect(card).toEqual({ id: tChanged, under: "line 4", chip: "Outdated in round 2" });
    const chipText = await browser.execute((tid) =>
      ([...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-review-chip"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined)?.innerText ?? null, taskId);
    expect(chipText).toBe(`${reviewId} · Round 1`);

    // Reply-only: a standing selection offers no new thread.
    const selected = await browser.execute((tid) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null)!;
      const view = (pane.querySelector(".cm-content") as any)?.cmTile?.root?.view;
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.line(2).to } });
      return !view.state.selection.main.empty;
    }, taskId);
    await flushEditorMeasure();
    expect(selected).toBe(true);
    expect(await browser.execute(() => document.querySelector(".tc-add-comment-btn") !== null)).toBe(false);
    await snap("present-rounds-outdated.png");

    // A reply from the card still lands, stamped with the latest round.
    await browser.execute((tid, th) => {
      const pane = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null)!;
      (pane.querySelector(`.tc-thread-card[data-thread-id="${th}"] .tc-btn-reply`) as HTMLElement).click();
    }, taskId, tChanged);
    await waitVisible(".tc-comment-composer .tc-comment-textarea");
    await browser.execute((body) => {
      const ta = document.querySelector(".tc-comment-composer .tc-comment-textarea") as HTMLTextAreaElement;
      ta.value = body;
      (document.querySelector(".tc-comment-composer .tc-btn-send") as HTMLElement).click();
    }, `still relevant ${stamp}`);
    await browser.waitUntil(async () => {
      const th = (await show()).threads.find((t: any) => t.id === tChanged);
      return th.comments.length === 2;
    }, { timeout: 10_000, timeoutMsg: "the reply from round 1's view never reached the review" });
    const last = (await show()).threads.find((t: any) => t.id === tChanged).comments[1];
    expect([last.by, last.round, last.body]).toEqual(["user", 2, `still relevant ${stamp}`]);
  });

  it("refuses an update with the same range", async () => {
    const r = await cliRpc({ cmd: "present_update", task: taskId, review: reviewId, head: "HEAD" });

    expect(r.ok).toBe(false);
    expect(r.error.message).toContain(`round 2 of ${reviewId} is already`);
    expect((await show()).rounds).toHaveLength(2);
  });

  it("holds a new round's rebuild while a composer is open, then queues its draft as stale", async () => {
    /** The visible diff's line count, and whether it draws a draft card. */
    const pane = () => browser.execute((tid) => {
      const p = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null);
      const v = (p?.querySelector(".cm-content") as any)?.cmTile?.root?.view;
      return { lines: v?.state.doc.lines ?? null, draft: !!p?.querySelector(".tc-comment-card:not(.tc-thread-card)") };
    }, taskId) as Promise<{ lines: number | null; draft: boolean }>;
    await clickIn(`[data-testid="compare-file-row"][data-path="${FILE}"]`);
    await browser.waitUntil(async () => (await activeScope()) === `review:${reviewId}`, {
      timeout: 10_000, timeoutMsg: "the row did not open the latest round",
    });
    await browser.waitUntil(async () => (await cards()).length === 2, {
      timeout: 15_000, timeoutMsg: "round 2's diff never built",
    });
    const before = (await pane()).lines!;
    await browser.execute((tid) => {
      const p = [...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-pane"]`)]
        .find(e => (e as HTMLElement).offsetParent !== null)!;
      const v = (p.querySelector(".cm-content") as any).cmTile.root.view;
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.line(1).to } });
    }, taskId);
    await waitVisible(".tc-add-comment-btn");
    await browser.execute(() =>
      document.querySelector(".tc-add-comment-btn")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    await waitVisible(".tc-comment-composer .tc-comment-textarea");
    const typed = `half typed ${stamp}`;
    await browser.execute((body) => {
      (document.querySelector(".tc-comment-composer .tc-comment-textarea") as HTMLTextAreaElement).value = body;
    }, typed);

    const next = numbered(13);
    next[3] = "line four, rewritten";
    writeFileSync(path.join(cwd, FILE), ["top 1", "top 2", ...next].join("\n") + "\n");
    execGit(`git -C "${cwd}" commit -qam "rounds 3 ${stamp}"`);
    const r = await cliRpc({ cmd: "present_update", task: taskId, review: reviewId, head: "HEAD" });
    expect(r.ok).toBe(true);
    await browser.waitUntil(async () => browser.execute(() =>
      (document.querySelector('[data-testid="compare-review-round"]') as HTMLElement | null)?.innerText === "Round 3"),
    { timeout: 10_000, timeoutMsg: "the webview never saw round 3" });

    // The store is on round 3; the open view is still round 2's, text and all.
    expect((await pane()).lines).toBe(before);
    expect(await browser.execute(() =>
      (document.querySelector(".tc-comment-composer .tc-comment-textarea") as HTMLTextAreaElement | null)?.value ?? null)).toBe(typed);

    await browser.execute(() => (document.querySelector(".tc-comment-composer .tc-btn-queue") as HTMLElement).click());

    await browser.waitUntil(async () => (await pane()).lines === before + 1, {
      timeout: 15_000, timeoutMsg: "closing the composer did not rebuild on round 3",
    });
    await flushEditorMeasure();
    expect((await pane()).draft).toBe(false);
    await clickIn('[data-testid="review-comments-pill"]');
    await waitVisible('[data-state="stale"]');
    const row = await browser.execute(() => (document.querySelector('[data-state="stale"]') as HTMLElement).innerText);
    expect(row).toContain(typed);
    expect(row).toContain("Written on round 2");
    expect(await browser.execute(() =>
      (document.querySelector('[data-testid="review-comments-send"]') as HTMLButtonElement).disabled)).toBe(true);
    await browser.execute(() =>
      ([...document.querySelectorAll("button")].find(b => b.textContent?.includes("Discard all")) as HTMLElement).click());
  });
});

// The From/To picker after a rebase: "Round 1 -> 2" replays round 1's change
// onto round 2's base, so upstream's commit stays out of the list.
describe("review rounds picker", () => {
  let taskId!: string;
  let cwd = "";
  let reviewId = "";
  const stamp = Date.now();
  const FILE = "picker.txt";
  const UP = `e2e-up-${stamp}`;

  /** Compare's rows as `path status`, in list order. */
  const rows = () => browser.execute(() =>
    [...document.querySelectorAll('[data-testid="compare-file-row"]')]
      .map(r => `${r.getAttribute("data-path")} ${r.getAttribute("data-status")}`)) as Promise<string[]>;

  const waitRows = (want: string[], msg: string) =>
    browser.waitUntil(async () => JSON.stringify(await rows()) === JSON.stringify(want), { timeout: 10_000, timeoutMsg: msg });

  /** The From chip that is pressed, "base" or a round number. */
  const pressedFrom = () => browser.execute(() =>
    document.querySelector('[data-testid="compare-round-from"][aria-pressed="true"]')?.getAttribute("data-from") ?? null);

  const authorCommit = (content: string, msg: string) => {
    writeFileSync(path.join(cwd, FILE), content);
    execGit(`git -C "${cwd}" add ${FILE}`);
    execGit(`git -C "${cwd}" commit -q -m "${msg} ${stamp}"`);
  };

  const update = async (extra: Record<string, unknown> = {}) => {
    const r = await cliRpc({ cmd: "present_update", task: taskId, review: reviewId, head: "HEAD", ...extra });
    expect(r.ok).toBe(true);
    return r.data;
  };

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    taskId = await createWorktreeTask("e2e-picker", `e2e-picker-${stamp}`);
    await waitForAgentReady(taskId);
    const { path: p, tab } = await browser.execute((id) => {
      const s = window.__termic!.useApp.getState();
      return { path: s.tasks.find((t: any) => t.id === id).path as string, tab: (s.tabs[id] ?? [])[0].id as string };
    }, taskId);
    cwd = p;
    // The branch the task "rebases onto", at the task's start.
    execGit(`git -C "${cwd}" branch ${UP}`);
    authorCommit("one\ntwo\nthree\n", "picker round 1");
    const r = await cliRpc({ cmd: "present_new", task: taskId, range: `${UP}..HEAD`, title: "Picker", tab });
    expect(r.ok).toBe(true);
    reviewId = r.data.review.id;
  });

  after(async () => {
    if (cwd) execGit(`git -C "${cwd}" branch -D ${UP}`);
    if (taskId) await archiveTask(taskId);
  });

  it("Round 1 -> 2 is one click and lists only the author's changes after a rebase", async () => {
    await ensureActiveTask(taskId);
    await openRightTab("Git");
    await waitVisible(`[data-testid="compare-panel"][data-review="${reviewId}"]`);
    // Upstream moves on in a worktree of its own, and the task rebases onto it.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "termic-e2e-up-"));
    execGit(`git -C "${cwd}" worktree add -q "${tmp}" ${UP}`);
    writeFileSync(path.join(tmp, "upstream.txt"), "upstream\n");
    execGit(`git -C "${tmp}" add upstream.txt`);
    execGit(`git -C "${tmp}" commit -q -m "upstream ${stamp}"`);
    execGit(`git -C "${cwd}" worktree remove --force "${tmp}"`);
    execGit(`git -C "${cwd}" rebase -q ${UP}`);
    authorCommit("one\nTWO\nthree\n", "picker round 2");

    const d = await update();

    expect(d.round).toBe(2);
    await waitVisible('[data-testid="compare-rounds"]');
    expect(await pressedFrom()).toBe("base");
    await waitRows([`${FILE} A`], "round 2 against its base did not list only the author's file");

    await clickIn('[data-testid="compare-round-from"][data-from="1"]');

    // A plain round 1 head..round 2 head would list upstream.txt as added too.
    await waitRows([`${FILE} M`], "Round 1 -> 2 did not list only the author's second change");
    expect(await browser.execute(() => (document.querySelector('[data-testid="compare-summary"]') as HTMLElement).innerText))
      .toContain("+1");
    expect(await browser.execute(() => document.querySelector('[data-testid="compare-review-fallback"]') === null)).toBe(true);
    await snap("present-rounds-picker.png");

    await clickIn(`[data-testid="compare-file-row"][data-path="${FILE}"]`);
    await browser.waitUntil(async () => {
      const chip = await browser.execute((tid) =>
        ([...document.querySelectorAll(`[data-task-id="${tid}"] [data-testid="diff-review-chip"]`)]
          .find(e => (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined)?.innerText ?? null, taskId);
      return chip === `${reviewId} · Round 1 → 2`;
    }, { timeout: 10_000, timeoutMsg: "the file did not open as the Round 1 -> 2 diff" });

    await clickIn('[data-testid="compare-round-from"][data-from="base"]');

    await waitRows([`${FILE} A`], "Base did not bring back round 2 against its base");
  });

  it("--show sets the first view, the picker overrides it, a new round resets it", async () => {
    authorCommit("one\nTWO\nthree\nfour\n", "picker round 3");

    const d = await update({ show: "1" });

    expect([d.round, d.default_from]).toEqual([3, 1]);
    await browser.waitUntil(async () => (await pressedFrom()) === "1",
      { timeout: 10_000, timeoutMsg: "--show 1 did not make Round 1 the first view" });

    await clickIn('[data-testid="compare-round-from"][data-from="base"]');

    await browser.waitUntil(async () => (await pressedFrom()) === "base",
      { timeout: 10_000, timeoutMsg: "Base did not override the agent's default" });
    const r = await cliRpc({ cmd: "present_show", task: taskId, review: reviewId });
    expect(r.data.review.default_from).toBe(1);

    authorCommit("one\nTWO\nthree\nfour\nfive\n", "picker round 4");
    await update();

    await browser.waitUntil(async () => (await pressedFrom()) === "1",
      { timeout: 10_000, timeoutMsg: "a new round did not drop the viewer's pick for the default" });
  });

  it("the To dropdown keeps a From below the picked round and resets one at or past it to Base", async () => {
    // Radix opens on pointerdown, so a bare .click() isn't enough.
    const pickTo = async (round: number) => {
      await browser.execute(() => {
        const el = document.querySelector('[data-testid="compare-round-to"]') as HTMLElement;
        const opts = { bubbles: true, pointerType: "mouse", button: 0 } as PointerEventInit;
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.click();
      });
      await waitVisible(`[data-testid="compare-round-to-item"][data-to="${round}"]`);
      await clickIn(`[data-testid="compare-round-to-item"][data-to="${round}"]`);
    };
    const shownTo = () => browser.execute(() =>
      document.querySelector('[data-testid="compare-round-to"]')?.getAttribute("data-to") ?? null);

    await pickTo(2);

    await browser.waitUntil(async () => (await shownTo()) === "2" && (await pressedFrom()) === "1",
      { timeout: 10_000, timeoutMsg: "To round 2 did not keep From round 1" });
    await waitRows([`${FILE} M`], "Round 1 -> 2 was not listed after picking To round 2");

    await pickTo(1);

    await browser.waitUntil(async () => (await shownTo()) === "1" && (await pressedFrom()) === "base",
      { timeout: 10_000, timeoutMsg: "To round 1 did not reset From round 1 to Base" });
    // Round 1 against its own base, from before the rebase.
    await waitRows([`${FILE} A`], "round 1 against its base was not listed");
  });
});
