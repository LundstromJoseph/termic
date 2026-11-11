// Turning a forge issue into a task: the branch name, the task name, and the
// prompt the agent wakes up holding.
//
// The prompt is composed, not stored: the ISSUE half (title, number, link,
// body, and the command to fetch the thread) is generated here, and the
// INSTRUCTION half is `builtin:work-issue` from the prompt library. That split
// is the point - a user who edits "Work on the issue" in the library changes
// how every future issue task behaves, without us having to template their
// text or re-derive it per provider.

import type { ForgeIssue } from "@/lib/types";
import { forgeName, issueNoun, azureWorkItemCommentsCommand } from "@/lib/forge";
import { usePromptLibrary } from "@/store/prompts";
import { WORK_ISSUE_PROMPT, WORK_ISSUES_PROMPT } from "@/lib/builtinPrompts";
import { slugify, branchify } from "@/lib/utils";
import { stripControl } from "./controlChars";

/** How much issue body we inline. Long issues exist (design docs pasted into
 *  a description); past a few thousand characters the agent is better served
 *  by the link and the fetch command than by the whole wall of text, and the
 *  first part is where the actual ask lives. */
export const BODY_MAX = 4000;

/** `#123` everywhere: GitHub, GitLab (issues are #; ! is reserved for merge
 *  requests) and Azure DevOps (work items are #; ! is the PR marker there).
 *  Unlike the MR/PR case this is NOT a per-provider difference. */
export function issueRef(issue: Pick<ForgeIssue, "number">): string {
  return `#${issue.number}`;
}

/** The CLI command that dumps the issue with its full comment thread. The
 *  agent runs this itself rather than us shipping the thread in the prompt.
 *  Azure's `az boards work-item show` cannot return comments, so it hands
 *  over the `wit/workItems/{id}/comments` invoke route - which needs the
 *  project spelled out, hence `remoteUrl` (a --detect fallback with a
 *  placeholder stands in when it is missing). */
export function issueFetchCommand(
  issue: Pick<ForgeIssue, "provider" | "number">,
  remoteUrl = "",
): string {
  if (issue.provider === "gitlab") return `glab issue view ${issue.number} --comments`;
  if (issue.provider === "azure") {
    return azureWorkItemCommentsCommand(remoteUrl, issue.number)
      ?? `az devops invoke --detect --area wit --resource comments --route-parameters 'project=PROJECT' workItemId=${issue.number} --api-version 7.1-preview.4`;
  }
  return `gh issue view ${issue.number} --comments`;
}

/** The "read the rest" pointer appended to a truncated body. For azure the
 *  comments route returns ONLY comments - the body needs
 *  `az boards work-item show` instead. gh/glab's fetch command carries
 *  both, so it doubles as the body command. */
function truncationNote(issue: Pick<ForgeIssue, "provider" | "number">, remoteUrl: string): string {
  const bodyCmd = issue.provider === "azure"
    // --id is required (no positional arg).
    ? `az boards work-item show --id ${issue.number} --detect`
    : issueFetchCommand(issue, remoteUrl);
  return `\n\n[body truncated, read the rest with \`${bodyCmd}\`]`;
}

/** Task name: `#123 Fix the thing`, trimmed to something a sidebar row can
 *  show. The number leads so a row is identifiable when the title truncates. */
export function issueTaskName(issue: Pick<ForgeIssue, "number" | "title">, max = 60): string {
  const ref = `#${issue.number}`;
  const title = san(issue.title).trim();
  if (!title) return ref;
  const full = `${ref} ${title}`;
  return full.length <= max ? full : `${full.slice(0, max - 1).trimEnd()}…`;
}

/** Branch: `<prefix>/issue-123-fix-the-thing`. The number is in there so the
 *  branch is traceable back to the issue after the title has been forgotten,
 *  and a title that slugifies to nothing still yields a valid branch. */
export function issueBranch(
  issue: Pick<ForgeIssue, "number" | "title">,
  branchPrefix: string,
  maxSlugWords = 6,
): string {
  const words = slugify(issue.title).split("-").filter(Boolean).slice(0, maxSlugWords);
  const stem = ["issue", String(issue.number), ...words].join("-");
  const prefix = branchPrefix.trim().replace(/^\/+|\/+$/g, "");
  return branchify(prefix ? `${prefix}/${stem}` : stem);
}

const san = stripControl;

/** The cleaning `issueContext` applies to a body before it measures it.
 *  Exported for the forge list snapshot, which has to cut a body the way
 *  this reads it: a CRLF body loses every `\r` here first. */
export const cleanIssueText = san;

/** The issue half of the prompt: identity, link, body, and how to read the
 *  discussion. Exported separately so tests can assert it without depending
 *  on the prompt library's state. */
export function issueContext(issue: ForgeIssue, bodyMax = BODY_MAX, remoteUrl = ""): string {
  const host = forgeName(issue.provider);
  const noun = issueNoun(issue.provider);
  const body = san(issue.body).trim();
  const truncated = body.length > bodyMax;
  const fetchCmd = issueFetchCommand(issue, remoteUrl);
  // The no-remote fallback embeds a project=PROJECT placeholder the agent
  // must fill from `git remote get-url origin` - say so or it reads as
  // literal syntax. Keyed on the FALLBACK actually being taken, not a
  // substring - a project literally named "PROJECT" would otherwise earn
  // the hint on a complete command.
  const cmdNote = issue.provider === "azure"
      && azureWorkItemCommentsCommand(remoteUrl, issue.number) === null
    ? " (replace `PROJECT` with this repo's Azure DevOps project - `git remote get-url origin` names it)"
    : "";
  const shown = truncated ? `${body.slice(0, bodyMax).trimEnd()}${truncationNote(issue, remoteUrl)}` : body;
  const lines = [
    `${host} ${noun} ${issueRef(issue)}: ${san(issue.title).trim()}`,
    san(issue.url),
  ];
  if (issue.labels.length) lines.push(`${issue.provider === "azure" ? "Tags" : "Labels"}: ${issue.labels.map(san).join(", ")}`);
  lines.push("");
  lines.push(shown || `(The ${noun} has no description. The discussion is all there is.)`);
  lines.push("");
  lines.push(
    issue.comments > 0
      ? `This ${noun} has ${issue.comments} comment${issue.comments === 1 ? "" : "s"}, which are NOT included above. Read them with \`${fetchCmd}\`${cmdNote}.`
      : `It has no comments yet. Confirm with \`${fetchCmd}\`${cmdNote} before assuming the description is the whole story.`,
  );
  return lines.join("\n");
}

/** The full prompt seeded into a fresh issue task: issue context, then the
 *  user's (or default) "Work on the issue" instructions. Reads the library
 *  live so an edited builtin's body is used; falls back to the shipped text
 *  if the user deleted it outright, because a task created from an issue
 *  with no instructions at all would just be a wall of context. (A DISABLED
 *  builtin still supplies the text: disabling hides the template from the
 *  prompt picker, it doesn't ask for instruction-free issue tasks.) */
export function buildIssuePrompt(issue: ForgeIssue, maxChars?: number, remoteUrl = ""): string {
  return buildIssuesPrompt([issue], maxChars, remoteUrl);
}

/** The context half of a prompt, body-trimmed to fit a character budget.
 *  What gives is the BODY: the instructions are the actual ask, and the body
 *  is context the agent can re-read in full with the fetch command that is
 *  already in the prompt. Trimming the tail instead would drop the ask and
 *  leave a wall of context with no instruction. */
function fittedContext(issue: ForgeIssue, maxChars: number | undefined, remoteUrl: string): string {
  let bodyMax = BODY_MAX;
  if (maxChars !== undefined) {
    // Overhead measured with an empty body, which substitutes the longer
    // "no description" placeholder - so this errs on the side of a shorter
    // body rather than overshooting the cap.
    const overhead = issueContext({ ...issue, body: "" }, BODY_MAX, remoteUrl).length;
    bodyMax = Math.max(0, Math.min(BODY_MAX, maxChars - overhead));
    // A body that still overflows gets the "read the rest" note appended
    // (a real command for azure, ~80 chars) - count it, then re-fit.
    if (issue.body.trim().length > bodyMax) {
      bodyMax = Math.max(0, Math.min(BODY_MAX, maxChars - overhead - truncationNote(issue, remoteUrl).length));
    }
  }
  return issueContext(issue, bodyMax, remoteUrl);
}

/** WORK_ISSUES_PROMPT with the provider's noun swapped in ("work items" for
 *  Azure). The constant is written so its only issue-noun phrases are
 *  "the issues", "each issue", "an issue", "these issues" - which is what
 *  makes a mechanical swap grammatical. Order: article fix first, then
 *  plural, then singular (each guards the next from half-replacing). */
function pluralTail(noun: string): string {
  if (noun === "issue") return WORK_ISSUES_PROMPT;
  return WORK_ISSUES_PROMPT
    .replace(/\ban issue\b/g, `a ${noun}`)
    .replace(/\bissues\b/g, `${noun}s`)
    .replace(/\bissue\b/g, noun);
}

/** One task seeded with one or several issues: every picked issue's context
 *  in pick order, then a single instructions tail - one ask, N subjects, not
 *  N copies of "work on the issue". The budget splits evenly across issues
 *  so the whole still fits the prompt box. */
export function buildIssuesPrompt(issues: ForgeIssue[], maxChars?: number, remoteUrl = ""): string {
  if (issues.length === 0) return "";
  const prompt = usePromptLibrary.getState().prompts.find(p => p.id === "builtin:work-issue");
  // The shipped text is singular ("the issue above"), wrong for a multi-pick
  // prompt. Only the UNMODIFIED builtin gets the count- and provider-correct
  // default: an edited one is the user's own wording, used verbatim either
  // way. A deleted builtin falls back to the shipped text, same as before.
  const noun = issueNoun(issues[0].provider);
  const instructions = ((!prompt || !prompt.modified) && issues.length > 1
    ? pluralTail(noun)
    : (prompt?.body ?? WORK_ISSUE_PROMPT)).trim();
  const tail = `\n\n---\n\n${instructions}`;
  const perIssue = maxChars === undefined ? undefined : Math.max(1, Math.floor((maxChars - tail.length) / issues.length));
  let contexts = issues.map(i => fittedContext(i, perIssue, remoteUrl)).join("\n\n---\n\n");
  // Degenerate caps (maxChars smaller than the irreducible per-issue
  // overhead) can still overshoot: the tail is the ask, so the CONTEXT
  // gives, never the instructions.
  if (maxChars !== undefined && contexts.length > maxChars - tail.length) {
    contexts = contexts.slice(0, Math.max(0, maxChars - tail.length));
  }
  return `${contexts}${tail}`;
}
