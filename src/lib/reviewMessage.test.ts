// What the user's review comments say to the agent: every thread id, and the
// instruction to answer in the thread rather than the terminal.
import { describe, it, expect } from "vitest";
import { composeReviewMessage } from "./reviewMessage";
import type { Review, ReviewThread, ReviewThreadComment } from "./types";

const REVIEW: Review = {
  version: 1, id: "r1", task_id: "t", dir_name: "", base: "aaaaaaa1111", head: "bbbbbbb2222", base_ref: "main",
  head_ref: "HEAD", title: "Split the parser", author: "claude", recipient_tab: "tab-1", created_at: "", seq: 3,
  files: ["src/a.ts"], files_truncated: false, threads: [], rounds: [],
};

function thread(id: string, lines: [number, number] | null, quote: string): ReviewThread {
  return { id, file: "src/a.ts", start_line: lines?.[0] ?? null, end_line: lines?.[1] ?? null, quote, comments: [], round: 1 };
}

const said = (body: string): ReviewThreadComment => ({ seq: 1, by: "user", author: "", body, at: "", round: 1 });

describe("composeReviewMessage", () => {
  it("heads the message with the review, its range and the reply instruction, then one block per comment", () => {
    const msg = composeReviewMessage(REVIEW, [
      { thread: thread("r1-t1", [2, 2], "beta"), comment: said("needs a test"), newThread: false },
      { thread: thread("r1-t4", [5, 7], "x\ny\nz"), comment: said("split this"), newThread: true },
    ]);

    expect(msg).toBe([
      '[Termic review r1 "Split the parser" aaaaaaa..bbbbbbb] The user left 2 comments.',
      'Answer each in its thread with "$TERMIC_CLI" present reply <thread> -m "...", not here. Full review: "$TERMIC_CLI" present show r1.',
      "",
      "src/a.ts:2 (thread r1-t1)\n```\nbeta\n```\nneeds a test",
      "",
      "src/a.ts:5-7 (thread r1-t4, new thread)\n```\nx\ny\nz\n```\nsplit this",
    ].join("\n"));
  });

  it("says comment in the singular and leaves out a missing title", () => {
    const msg = composeReviewMessage({ ...REVIEW, title: null }, [
      { thread: thread("r1-t1", [2, 2], "beta"), comment: said("ok"), newThread: false },
    ]);

    expect(msg.split("\n")[0]).toBe("[Termic review r1 aaaaaaa..bbbbbbb] The user left 1 comment.");
  });

  it("names a file-level thread by its file alone, with no fence", () => {
    const msg = composeReviewMessage(REVIEW, [
      { thread: thread("r1-t2", null, ""), comment: said("generated, skip it"), newThread: true },
    ]);

    expect(msg.endsWith("\n\nsrc/a.ts (thread r1-t2, new thread)\ngenerated, skip it")).toBe(true);
  });

  it("names the round in the header once there are two, and an outdated thread where it was opened", () => {
    const round = { base: "a", head: "b", base_ref: "main", head_ref: "HEAD", at: "" };
    const outdated: ReviewThread = {
      ...thread("r1-t2", [8, 8], "gone"), outdated: 2, origin: { file: "src/old.ts", start_line: 3, end_line: 4 },
    };

    const one = composeReviewMessage({ ...REVIEW, rounds: [round] }, [
      { thread: thread("r1-t1", [2, 2], "beta"), comment: said("ok"), newThread: false },
    ]);
    const two = composeReviewMessage({ ...REVIEW, rounds: [round, round] }, [
      { thread: outdated, comment: said("still?"), newThread: false },
    ]);

    expect(one.split("\n")[0]).toMatch(/^\[Termic review r1 "Split/);
    expect(two.split("\n")[0]).toMatch(/^\[Termic review r1 round 2 "Split the parser" /);
    expect(two).toContain("\n\nsrc/old.ts:3-4 (thread r1-t2, opened in round 1, outdated in round 2)\n");
  });

  it("outruns backticks inside the quote", () => {
    const msg = composeReviewMessage(REVIEW, [
      { thread: thread("r1-t1", [1, 1], "```js"), comment: said("fence"), newThread: false },
    ]);

    expect(msg).toContain("\n````\n```js\n````\n");
  });
});
