// Review a PR: a number or a link, where to check it out, which review
// prompt, which agent, go. Deliberately its own small dialog rather than a
// sixth source in New Task, which is busy enough: this one has a single job
// and every field defaults to the answer most reviews want.
//
// The work is lib/prReviewTask.ts; `termic review` and MCP `task_review`
// reach the same task through new_task (lib/cliRpc.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, GitPullRequest, Link2, Loader2 } from "lucide-react";
import { useUI } from "@/store/ui";
import { useApp } from "@/store/app";
import { usePromptLibrary, promptTitle, reviewPrompts, CODE_REVIEW_LABEL } from "@/store/prompts";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { AgentPills } from "./AgentPills";
import { visibleCliIds } from "@/lib/agents";
import { projectForgePrs } from "@/lib/ipc";
import { afterRevalidate, cachedForgeList, fetchForgeList } from "@/store/forgeLists";
import { prRef } from "@/lib/forge";
import { parsePrRef, repoSlug } from "@/lib/prReview";
import { DEFAULT_REVIEW_GROUP, existingReviewTask, startPrReview, type ReviewWhere } from "@/lib/prReviewTask";
import type { PrPickList } from "@/lib/types";
import { cn } from "@/lib/utils";

/** The last choices, so the second review is one paste and Enter. Per
 *  machine: a prompt id and a checkout preference are not worth syncing. */
const LS_REVIEW_PR_LAST = "reviewPrLast";
/** `group` is "" when the user cleared it: no group, not the default. */
interface Last { promptId?: string; where?: ReviewWhere; cli?: string; group?: string }

function readLast(): Last {
  try {
    const v = JSON.parse(localStorage.getItem(LS_REVIEW_PR_LAST) ?? "{}") as Last;
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}
function writeLast(v: Last) {
  try { localStorage.setItem(LS_REVIEW_PR_LAST, JSON.stringify(v)); } catch {}
}

export function ReviewPrDialog() {
  const { t } = useTranslation("dialogs");
  const openFor = useUI(s => s.reviewPrProjectId);
  const close = useUI(s => s.closeReviewPr);
  const open = !!openFor;
  const projects = useApp(s => s.projects);
  const agents = useApp(s => s.agents);
  const detectedClis = useApp(s => s.detectedClis);
  const library = usePromptLibrary(s => s.prompts);
  const prompts = useMemo(() => reviewPrompts(library), [library]);
  // Settings > Prompts opens from here without closing the review: the
  // dialog steps aside while Settings is up and comes back as it was.
  const settingsOpen = useApp(s => !!s.view.settingsOpen);

  const gitProjects = useMemo(() => projects.filter(p => !p.non_git), [projects]);
  const choices = useMemo(() => {
    const visible = visibleCliIds(agents.map(a => a.id), agents, detectedClis);
    return agents.filter(a => visible.has(a.id));
  }, [agents, detectedClis]);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [where, setWhere] = useState<ReviewWhere>("worktree");
  const [promptId, setPromptId] = useState<string | null>(null);
  const [cli, setCli] = useState<string>("");
  // The initial prompt as the user has it: null until they edit, so it shows
  // the picked library prompt. Edits stay in this dialog; the library is
  // untouched. Picking another prompt starts again from its text.
  const [draft, setDraft] = useState<string | null>(null);
  // The task's name ("" = the PR's branch) and the sidebar group it joins.
  const [name, setName] = useState("");
  const [group, setGroup] = useState(DEFAULT_REVIEW_GROUP);
  // The PR's branch, once known: the name a blank Name field stands for.
  const [head, setHead] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The PRs waiting on this user's review, as one-click rows under the box.
  // Also tells us the project's remote, which is how a pasted link for
  // another repo is caught before anything is fetched.
  const [waiting, setWaiting] = useState<PrPickList | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Seed on open: the project it was opened for, and the last choices that
  // still exist.
  useEffect(() => {
    if (!open) return;
    const last = readLast();
    setProjectId(openFor);
    const seed = useUI.getState().reviewPrSeed;
    const initialQuery = seed?.url ?? (seed?.number ? String(seed.number) : "");
    setQuery(initialQuery); setErr(null); setBusy(false); setWaiting(null);
    setWhere(last.where === "main" ? "main" : "worktree");
    setPromptId(last.promptId ?? null);
    setCli(last.cli ?? "");
    setDraft(null);
    setName("");
    setGroup(typeof last.group === "string" ? last.group : DEFAULT_REVIEW_GROUP);
  }, [open, openFor]);

  const project = gitProjects.find(p => p.id === projectId) ?? null;
  const isBare = project?.bare === true;
  // A bare repo has no main checkout; the remembered choice is kept for others.
  const effectiveWhere: ReviewWhere = isBare ? "worktree" : where;
  // A remembered prompt or agent that is gone falls back to the first one.
  const prompt = prompts.find(p => p.id === promptId) ?? prompts[0] ?? null;
  const agent = choices.find(a => a.id === cli)
    ?? choices.find(a => a.id === project?.default_cli)
    ?? choices[0] ?? null;

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    // Painted from the shared cache when it has the list, then re-fetched.
    // A failed re-fetch keeps the rows: a failure only ever hid this list.
    const query = { projectId, kind: "prs", scope: "review", limit: 8 } as const;
    const shown = cachedForgeList(query);
    setWaiting(shown);
    fetchForgeList(query, { urgent: true })
      .then(r => { if (!cancelled) setWaiting(afterRevalidate(shown, r).lookup); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, projectId]);

  const number = parsePrRef(query);

  // The PR's branch for the Name placeholder: from the waiting list when the
  // PR is in it, else looked up once typing pauses.
  const listedHead = waiting?.prs.find(p => p.number === number)?.head_ref ?? null;
  useEffect(() => {
    setHead(null);
    if (!open || !projectId || !number || listedHead) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      projectForgePrs(projectId, { number })
        .then(r => { if (!cancelled) setHead(r.prs[0]?.head_ref ?? null); })
        .catch(() => {});
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, projectId, number, listedHead]);
  const branchName = listedHead ?? head;
  // A link names its repo: refuse one for a different repo here, with the
  // reason, rather than fetching the same number from the wrong project.
  const linkSlug = /^https?:\/\//i.test(query.trim()) ? repoSlug(query) : null;
  const projectSlug = waiting?.remote_url ? repoSlug(waiting.remote_url) : null;
  const wrongRepo = !!linkSlug && !!projectSlug && linkSlug !== projectSlug;
  const reuse = project && number ? existingReviewTask(project.id, number, branchName) : undefined;
  const promptText = draft ?? prompt?.body ?? "";
  const canStart = !!project && number > 0 && !!promptText.trim() && !!agent && !busy && !wrongRepo;

  async function start(n = number) {
    if (!project || !promptText.trim() || !agent || !n || busy || wrongRepo) return;
    setBusy(true); setErr(null);
    if (prompt) writeLast({ promptId: prompt.id, where, cli: agent.id, group: group.trim() });
    try {
      // The text as edited here, under the picked prompt's identity (its
      // title names the agent tab when the PR already has a review task).
      const used = prompt
        ? { ...prompt, body: promptText }
        : { id: "review-pr:custom", title: t("reviewPr.title"), body: promptText, builtin: false, enabled: true, modified: false, labels: [CODE_REVIEW_LABEL], forReview: true };
      await startPrReview({ projectId: project.id, number: n, where: effectiveWhere, cli: agent.id, prompt: used, name, group });
      close();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
      setBusy(false);
    }
  }

  const label = "w-16 shrink-0 pt-1 text-[12.5px] text-[var(--color-fg-dim)]";

  // What the library held when Settings opened, so coming back can pick
  // the prompt that was just made, or show the new text of the one edited.
  const beforeSettings = useRef<{ ids: Set<string>; body: string } | null>(null);
  useEffect(() => {
    const was = beforeSettings.current;
    if (settingsOpen || !was) return;
    beforeSettings.current = null;
    const added = prompts.find(p => !was.ids.has(p.id));
    if (added) { setPromptId(added.id); setDraft(null); }
    else if (prompt && prompt.body !== was.body) setDraft(null);
  }, [settingsOpen, prompts, prompt]);

  /** Settings > Prompts, filtered to the review prompts: where they are
   *  edited, and where New prompt makes another one with the label. */
  function openReviewPrompts() {
    beforeSettings.current = { ids: new Set(prompts.map(p => p.id)), body: prompt?.body ?? "" };
    usePromptLibrary.getState().setFilterLabel(CODE_REVIEW_LABEL);
    useApp.getState().openSettings("prompts");
  }

  return (
    <AppDialog
      open={open && !settingsOpen}
      onOpenChange={(v) => { if (!v && !busy) close(); }}
      title={t("reviewPr.title")}
      className="max-w-3xl"
      onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
    >
      <div data-testid="review-pr-dialog" className="mt-1 flex flex-col gap-3">
        {gitProjects.length > 1 && (
          <div className="flex items-start gap-2.5">
            <span className={label}>{t("reviewPr.project")}</span>
            <select
              data-testid="review-pr-project"
              value={projectId ?? ""}
              onChange={e => { setProjectId(e.target.value); setErr(null); }}
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
            >
              {gitProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}

        <div className="flex items-start gap-2.5">
          <span className={label}>{t("reviewPr.pr")}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <input
              ref={inputRef}
              data-testid="review-pr-input"
              value={query}
              onChange={e => { setQuery(e.target.value); setErr(null); }}
              onKeyDown={e => { if (e.key === "Enter" && canStart) { e.preventDefault(); void start(); } }}
              placeholder={t("reviewPr.placeholder")}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
            />
            {query.trim() && !number && (
              <p data-testid="review-pr-hint" className="text-[12px] text-[var(--color-fg-faint)]">{t("reviewPr.unparsed")}</p>
            )}
            {wrongRepo && (
              <p data-testid="review-pr-hint" className="text-[12px] text-[var(--color-err)]">
                {t("reviewPr.wrongRepo", { repo: linkSlug })}
              </p>
            )}
            {reuse && !wrongRepo && (
              <p data-testid="review-pr-hint" className="text-[12px] text-[var(--color-fg-faint)]">
                {t("reviewPr.reuse", { name: reuse.name })}
              </p>
            )}
            {waiting?.status === "ok" && waiting.prs.length > 0 && (
              <div className="flex flex-col gap-0.5" data-testid="review-pr-waiting">
                <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-faint)]">{t("reviewPr.waiting")}</span>
                {waiting.prs.map(pr => (
                  <button
                    key={pr.number}
                    type="button"
                    data-testid="review-pr-row"
                    disabled={busy}
                    onClick={() => setQuery(String(pr.number))}
                    className={cn(
                      "flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-[var(--color-hover)]",
                      number === pr.number && "bg-[var(--color-bg-3)]",
                    )}
                  >
                    <span className="shrink-0 font-mono text-[11.5px] text-[var(--color-fg-faint)]">{prRef(pr.provider, pr.number)}</span>
                    <span className="min-w-0 truncate text-[var(--color-fg)]">{pr.title}</span>
                    <span className="ml-auto shrink-0 text-[11.5px] text-[var(--color-fg-faint)]">{pr.author}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <span className={label}>{t("reviewPr.where")}</span>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5" role="radiogroup">
            {([
              ["worktree", GitBranch, t("newTask.worktree"), t("reviewPr.worktreeHint")],
              ["main", Link2, t("newTask.mainCheckout"), t("reviewPr.mainHint")],
            ] as const).map(([v, Icon, name, hint]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={effectiveWhere === v}
                data-testid={`review-pr-where-${v}`}
                disabled={isBare && v === "main"}
                title={isBare && v === "main" ? t("newTask.mainCheckoutBare") : undefined}
                onClick={() => setWhere(v)}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left",
                  effectiveWhere === v
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10"
                    : "border-[var(--color-border-soft)] hover:bg-[var(--color-hover)]",
                  isBare && v === "main" && "cursor-not-allowed opacity-40 hover:bg-transparent",
                )}
              >
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium leading-tight text-[var(--color-fg)]">{name}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--color-fg-dim)]">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Unused when the PR already has a task: the review joins that one. */}
        {!reuse && (
          <>
            <div className="flex items-start gap-2.5">
              <span className={label}>{t("reviewPr.name")}</span>
              <input
                data-testid="review-pr-name"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && canStart) { e.preventDefault(); void start(); } }}
                placeholder={branchName ?? t("reviewPr.namePlaceholder")}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
              />
            </div>
            <div className="flex items-start gap-2.5">
              <span className={label}>{t("reviewPr.group")}</span>
              <input
                data-testid="review-pr-group"
                value={group}
                onChange={e => setGroup(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && canStart) { e.preventDefault(); void start(); } }}
                placeholder={t("reviewPr.groupPlaceholder")}
                autoComplete="off" spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[12.5px] text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
              />
            </div>
          </>
        )}

        <div className="flex items-start gap-2.5">
          <span className={label}>{t("reviewPr.agent")}</span>
          {/* The New Task dialog's picker, so the two read the same. */}
          <AgentPills
            testId="review-pr-agents"
            choices={choices}
            value={agent?.id ?? ""}
            onChange={setCli}
          />
        </div>

        <div className="flex items-start gap-2.5">
          <span className={label}>{t("reviewPr.prompt")}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {prompts.length === 0 ? (
              <p data-testid="review-pr-no-prompts" className="pt-1 text-[12.5px] text-[var(--color-fg-dim)]">
                {t("reviewPr.noPrompts")}{" "}
                <button
                  type="button"
                  className="text-[var(--color-accent)] hover:underline"
                  onClick={openReviewPrompts}
                >
                  {t("reviewPr.openPrompts")}
                </button>
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5" role="radiogroup">
                {prompts.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={prompt?.id === p.id}
                    data-testid="review-pr-prompt"
                    data-prompt-id={p.id}
                    onClick={() => { setPromptId(p.id); setDraft(null); }}
                    className={cn(
                      "max-w-full truncate rounded-md border px-2.5 py-1 text-[12.5px]",
                      prompt?.id === p.id
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-fg)]"
                        : "border-[var(--color-border-soft)] text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
                    )}
                  >
                    {promptTitle(p, t)}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="review-pr-manage-prompts"
                  onClick={openReviewPrompts}
                  className="px-1 py-1 text-[12px] text-[var(--color-accent)] hover:underline"
                >
                  {t("reviewPr.managePrompts")}
                </button>
              </div>
            )}
            {/* The prompt the agent wakes up with, editable for this review
                only. The PR's title, link and description go in front of it. */}
            <textarea
              data-testid="review-pr-text"
              value={promptText}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") e.stopPropagation(); }}
              rows={12}
              autoCorrect="off" autoCapitalize="off" autoComplete="off" spellCheck={false}
              placeholder={t("reviewPr.textPlaceholder")}
              className="h-[34vh] min-h-[160px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent-soft)]"
            />
            <div className="flex items-center justify-between gap-3 text-[11.5px] text-[var(--color-fg-faint)]">
              <span>{t("reviewPr.textHint")}</span>
              {draft != null && prompt && draft !== prompt.body && (
                <button
                  type="button"
                  data-testid="review-pr-text-reset"
                  onClick={() => setDraft(null)}
                  className="shrink-0 text-[var(--color-accent)] hover:underline"
                >
                  {t("reviewPr.textReset")}
                </button>
              )}
            </div>
          </div>
        </div>

        {err && <p data-testid="review-pr-error" className="break-words text-[12.5px] text-[var(--color-err)]">{err}</p>}

        <div className="flex justify-end">
          <Button variant="primary" size="sm" data-testid="review-pr-start" disabled={!canStart} onClick={() => void start()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitPullRequest className="h-3.5 w-3.5" />}
            {busy ? t("reviewPr.starting") : t("reviewPr.start")}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
