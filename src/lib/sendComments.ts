// Deliver review comments to an agent. One path, two callers: the
// pending-comments bar (the whole queued batch) and the composer's "Send now"
// (this one comment, straight out, without joining the queue).
//
// Kept out of the components because the composer is framework-free CodeMirror
// DOM and cannot reach React state — and because "which agent, how it is
// written, what the user is told" should not have two implementations that
// drift apart.

import { PtyExitedDuringDelivery, queueOrDeliver } from "./agentDelivery";
import { isTerminalCli, tabLabel, workDoneCapable } from "./agents";
import { composeCommentsMessage, type ReviewComment } from "@/store/reviewComments";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import type { TerminalTab } from "./types";

/** Live agent terminals for a task: real agents only, never a plain shell, a
 *  run tab, a custom-command tab, or a registry "terminal"-kind entry. A
 *  review comment is an instruction to act on; a dev server is not an agent. */
export function agentTargets(taskId: string): TerminalTab[] {
  const s = useApp.getState();
  return (s.tabs[taskId] ?? []).filter(
    (t): t is TerminalTab =>
      t.type === "terminal" && !!t.ptyId && !t.runTab && !isTerminalCli(t.cli, s.agents),
  );
}

/** Which agent a send lands in: an explicit pick, else the active tab when it
 *  is an agent, else the task default, else the first live one. */
export function pickAgentTarget(taskId: string, tabId?: string | null): TerminalTab | null {
  const targets = agentTargets(taskId);
  const activeTabId = useApp.getState().activeTab[taskId];
  return (
    (tabId ? targets.find(t => t.id === tabId) : undefined) ??
    targets.find(t => t.id === activeTabId) ??
    targets.find(t => t.is_default) ??
    targets[0] ??
    null
  );
}

/**
 * Hand `comments` to an agent as ONE message, through its prompt queue: a
 * mid-turn agent (or one holding the user's draft) gets it when the turn
 * ends. Never switches tab or takes focus: the user stays where they were
 * reviewing.
 *
 * Resolves true once the message is in the PTY or in the agent's queue. The
 * caller decides what that means for its own state (the bar clears its
 * pending list; the composer never queued in the first place), which is why
 * nothing here touches the comment store.
 */
export async function sendCommentsToAgent(
  taskId: string,
  comments: ReviewComment[],
  opts: { tabId?: string | null; label?: string } = {},
): Promise<boolean> {
  if (!comments.length) return false;
  const target = pickAgentTarget(taskId, opts.tabId);
  if (!target?.ptyId) {
    useUI.getState().pushToast(i18n.t("backend:sendComments.noAgent"), "error");
    return false;
  }
  const name = tabLabel(target);
  const what = opts.label ?? i18n.t(comments.length === 1 ? "backend:sendComments.commentsOne" : "backend:sendComments.commentsOther", { count: comments.length });
  let mode: Awaited<ReturnType<typeof queueOrDeliver>>;
  try {
    mode = await queueOrDeliver(taskId, target, composeCommentsMessage(comments), { capable: workDoneCapable(target.cli) });
  } catch (e) {
    // The write may have landed before the PTY died, so do not claim nothing
    // was sent. Still false: the bar keeps the batch, because an agent that
    // exited mid-message most likely never acted on it.
    const key = e instanceof PtyExitedDuringDelivery ? "backend:sendComments.exitedDuringSend" : "backend:sendComments.unreachable";
    useUI.getState().pushToast(i18n.t(key, { name, what }), "error");
    return false;
  }
  const key = mode === "delivered" ? "backend:sendComments.sent" : "backend:sendComments.queued";
  useUI.getState().pushToast(i18n.t(key, { what, name }), "success");
  return true;
}
