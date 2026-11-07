# Agent-presented reviews: follow-ups

Status: idea. Nothing here is decided or scheduled. The MVP (`termic present
new|comment|reply|show|list|claim`, Compare review mode, thread cards,
single and batch Send through the agent queue) shipped on the
`review-improvements` branch, and resolve / unresolve (`present
resolve|unresolve`, the Resolved chip, collapsed cards), the Compare
thread list and rounds (`present update`, outdated threads, the From/To
picker with the replayed interdiff) on `present-v2`.
This file lists what was deliberately left
out of it, plus gaps found while building and smoke-testing it.

How it works today: docs/ui.md "Agent-presented reviews", docs/ipc.md
(`present` verbs, `review_*` commands), docs/data-model.md (Review file),
docs/cli-agent-instructions.md (agent briefing).

## Features

1. **Comments on the old side.** `--side old` and a commentable left pane,
   so deleted lines can carry a comment. The file format already has
   `side`.
2. **Bounded `present wait <id> --timeout`.** Block until the user posts,
   on the AgentCache seq+condvar pattern (cli_server.rs `watch_agent`),
   clamped like the MCP wait cap. Push stays the primary path; this is for
   agents that want to idle on a review.
3. **Cross-task claim.** Let a tab in another task take over a review.
   Needs `recipient_task_id` on the review. MVP restricts claim to the
   review's own task.
4. **User-started reviews.** Pick a range in Compare and start commenting
   without an agent having presented it. Open question: which tab
   receives the comments.
5. **Author name setting.** MVP uses `--author`, defaulting to the
   agent's display name (e.g. `lead`). A per-agent or per-project setting
   would save passing the flag every time.
6. **One message per recipient.** The pending bar sends one message per
   review, so two reviews with the same recipient tab produce two
   messages. Merge them if that turns out noisy.
7. **GitHub-style multi-file view.** One scrolling diff of the whole
   range instead of Compare rows plus per-file tabs. Much bigger than the
   rest of this list.
8. **Caged / Docker agents.** No CLI socket, so they cannot use
   `present`. A worktree-file route would work, but it is a second realm
   to keep in step (docs/gotchas.md "Docker is a SECOND REALM").

## Gaps and checks

- **Commit reveal flicker.** `commitReveal` likely paints one wrong frame
  when it mounts a fresh GitPanel/RightPanel, the same bug the review
  reveal had before its synchronous-initializer fix (GitPanel.tsx,
  RightPanel.tsx). Untouched.
- **Pending bar focus on Windows/Linux.** The bar records the
  pre-popover focus on the pill's pointerdown. Verified on macOS WebKit
  only; Chromium (WebView2) focuses buttons on mousedown.
- **No test that a review survives task archive** (AC8 is met in code,
  unpinned by a test).
- **Diff open time unmeasured** for `review:` diffs (the <100ms editor
  open budget).
- **Opening from a file row hides some threads.** Only a thread-list
  click reveals a thread. A file row opens the diff at the top, so a
  thread inside an "N unchanged lines" fold stays folded, and one on a new
  markdown/HTML/SVG file stays behind the rendered preview.
- **Refused post toast.** When `review_post` refuses a composer Send, the
  text goes back into the pending list as a draft, but the toast does not
  say so.

## Background

Design reports for the MVP (local, not in the repo):
`~/dev/docs/agent-stage-area/2026-11-06T10_49_50-ai-diff-review-comments/`.
The useful ones: the sage design report (`*-sage.html`, phase 3 sketch
and the reasoning against blocking waits), the plan (`*-planner.html`)
and `questions.md` (every scope decision and its answer).
