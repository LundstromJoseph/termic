// Typing a prompt into a task's agent with nobody at the keyboard, and
// knowing whether it landed. Shared by the CLI's `termic new` / `send`
// (lib/cliRpc.ts, which reports the result to the CLI server) and the
// schedule runner (lib/schedules/runner.ts, which records it in the
// schedule's history). One implementation, so the readiness rules cannot
// drift between the two.
//
// Wall-clock timers throughout, never rAF: occluded windows freeze rAF, and
// for both callers the window is usually in the background.

import { useApp } from "@/store/app";
import { waitForAgentReady, hooksOwnStartupReadiness } from "@/lib/agentReady";
import { ptyAlive } from "@/lib/ipc";
import { deliverMessage } from "@/lib/agentSend";
import { isTerminalCli, builtinBaseId } from "@/lib/agents";
import { agentSendDisposition } from "@/lib/agentSendDisposition";
import { reportCliPromptDelivery } from "@/lib/cliPromptReports";
import type { TerminalTab } from "@/lib/types";

const SPAWN_DEADLINE_MS = 15_000;
const POLL_MS = 150;

const sleep = (ms: number) => new Promise<void>(r => { window.setTimeout(r, ms); });

export function defaultAgentTab(taskId: string): TerminalTab | undefined {
  return (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.type === "terminal" && !!t.is_default,
  );
}

/** The injection target: a specific tab when given (send --fresh /
 *  --resume respawn), the default agent tab otherwise; a restored set
 *  with no surviving default falls back to its first agent tab so the
 *  injection still lands somewhere real. */
export function agentTabFor(taskId: string, tabId?: string): TerminalTab | undefined {
  if (!tabId) {
    return (
      defaultAgentTab(taskId)
      ?? (useApp.getState().tabs[taskId] ?? []).find(
        (t): t is TerminalTab => t.type === "terminal" && !t.runTab && !isTerminalCli(t.cli)
          && t.cli !== "shell" && t.cli !== "custom",
      )
    );
  }
  return (useApp.getState().tabs[taskId] ?? []).find(
    (t): t is TerminalTab => t.id === tabId && t.type === "terminal",
  );
}

/** Wait for the target agent tab to hold a live PTY ("spawn"). */
export async function waitForAgentPty(taskId: string, tabId?: string): Promise<boolean> {
  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (agentTabFor(taskId, tabId)?.ptyId) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/** queueOrDeliver's throw when the text WAS written but the PTY died or was
 *  replaced before the write could be confirmed: unlike every other throw,
 *  the agent may have received it. */
export class PtyExitedDuringDelivery extends Error {
  constructor() { super("the agent PTY exited while the prompt was being typed"); }
}

/** Prompt a LIVE agent tab. Mid-turn (or behind a queued backlog):
 *  QUEUE, delivered by TerminalPane's drain when the turn ends
 *  (runPrompt.ts's rule); only capable agents queue, since without
 *  detection there is no "turn ended" edge to drain on and the prompt
 *  would sit forever. Idle: deliver now, tracked (injectPromptTracked's
 *  rules, minus the boot settle a fresh spawn needs). Shared by `termic
 *  send` (both target paths) and every UI comment send, so the two can
 *  never disagree on when a message waits for the turn to end. Never
 *  switches tab or moves focus. */
export async function queueOrDeliver(
  taskId: string,
  tab: TerminalTab,
  text: string,
  opts: { capable: boolean; promptId?: string; now?: boolean },
): Promise<"delivered" | "queued" | "queued-flushed"> {
  const ptyId = tab.ptyId;
  if (!ptyId) throw new Error("the agent tab lost its PTY before the prompt could be typed");
  // An agent stalled on delegated work (its own loop stopped, subagents or
  // shells still running) takes the prompt now rather than queueing it.
  // And whatever the agent is doing: a user mid-draft in its prompt. Typing
  // now would land inside their unsubmitted text and Enter would send both
  // as one message, so the prompt queues and follows their draft instead.
  // The rule itself is `agentSendDisposition`, pure and unit-tested: it is
  // four flags and the failure mode is a deadlock nobody notices until an
  // agent has been silent for ten minutes.
  const how = agentSendDisposition({
    capable: opts.capable,
    workState: tab.workState,
    delegatedIdle: !!tab.delegatedIdle,
    queued: tab.queue?.length ?? 0,
    composing: !!tab.composing,
    now: !!opts.now,
  });
  if (how !== "deliver") {
    useApp.getState().enqueueAgentMessage(taskId, tab.id, text, 1, opts.promptId);
    // Delegated-idle with a backlog: nothing is coming to drain it, so release
    // the whole queue back to back, oldest first. Enqueue-then-flush rather
    // than delivering ahead of what was already waiting, which would reorder
    // the conversation to fix a liveness bug.
    if (how === "queue-flush") useApp.getState().flushAgentQueue(taskId, tab.id);
    return how === "queue-flush" ? "queued-flushed" : "queued";
  }
  // A message typed INTO a running turn (`--now`) leaves the turn's state
  // alone: the agent is still working, and calling it idle here would drop
  // its spinner and let the next queued message drain into the same turn.
  // Only that case: a delegated-idle agent is also "working" in the store and
  // has always been reset here, since its own loop has stopped.
  const intoLiveTurn = !!opts.now && tab.workState === "working" && !tab.delegatedIdle;
  if (!intoLiveTurn) {
    useApp.getState().patchTab(taskId, tab.id, { workState: "idle", unread: null });
  }
  await deliverMessage(ptyId, text);
  const still = agentTabFor(taskId, tab.id);
  const samePty = still?.id === tab.id && still.ptyId === ptyId;
  const alive = samePty && (await ptyAlive(ptyId).catch(() => false));
  if (!alive) throw new PtyExitedDuringDelivery();
  useApp.getState().patchTab(taskId, tab.id, { lastInputAt: Date.now() });
  if (opts.promptId) await reportCliPromptDelivery(opts.promptId, true);
  return "delivered";
}

export type DeliveryResult = { ok: true; tabId: string } | { ok: false; error: string };

/** Type `prompt` into the agent once it is ready, and say whether it landed.
 *  Every exit returns a result; nothing here reports anywhere, so a caller
 *  decides what a failure means. `spawned` is `waitForAgentPty`'s answer. */
export async function deliverPromptWhenReady(
  taskId: string,
  prompt: string,
  spawned: boolean,
  tabId?: string,
): Promise<DeliveryResult> {
  const fail = (error: string): DeliveryResult => ({ ok: false, error });
  if (!spawned) return fail("the agent PTY never spawned");
  // Wait for the TUI to reach its input box, so the prompt lands there
  // and not in a splash screen that discards it; then RE-READ the tab (it
  // may have restarted onto a fresh PTY while we waited - never type into
  // a stale pty). Same readiness rules as seedPrompt's race path: an agent
  // that owns its own ready signal and never sends it is showing a startup
  // prompt, where typing + Enter confirms whatever is highlighted.
  const cli = agentTabFor(taskId, tabId)?.cli;
  const hooksOwnReadiness = hooksOwnStartupReadiness(cli && builtinBaseId(cli, useApp.getState().agents), !!cli && useApp.getState().agentHooksInstalled[cli] === true);
  const ready = await waitForAgentReady(() => agentTabFor(taskId, tabId), { hooksOwnReadiness });
  if (ready === "blocked") return fail(`${cli} never reported ready; not typing (startup prompt?)`);
  const tab = ready === "lost" ? undefined : agentTabFor(taskId, tabId);
  if (!tab?.ptyId) return fail("the agent tab lost its PTY before the prompt could be typed");
  try {
    // Clear any STALE done/attention state first (a real keyboard Enter
    // clears these via term.onData; a direct PTY write does not), so the
    // wait's own-prompt settle logic can never trust a "done" that
    // predates this prompt.
    useApp.getState().patchTab(taskId, tab.id, { workState: "idle", unread: null });
    // Resolves only after text AND the submit CR are written. Echo-verify
    // unless the agent itself claimed ready (same protection as
    // seedPrompt: a missing echo means the paste went somewhere that is
    // not an input box).
    await deliverMessage(tab.ptyId, prompt, { verifyEcho: ready !== "ready" });
    // pty_write silently no-ops on a dead id, so "the writes resolved"
    // is not "the agent received them": delivered means the SAME tab
    // still holds the SAME, still-live PTY after both writes.
    const still = agentTabFor(taskId, tabId);
    const samePty = still?.id === tab.id && still.ptyId === tab.ptyId;
    const alive = samePty && (await ptyAlive(tab.ptyId).catch(() => false));
    if (!alive) return fail("the agent PTY exited while the prompt was being typed");
    useApp.getState().patchTab(taskId, tab.id, { lastInputAt: Date.now() });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return fail(String((e as Error)?.message ?? e));
  }
}
