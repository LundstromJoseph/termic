// What a batch of inline comments actually says to the agent.
//
// The framing is the point here: a diff is a review surface, a source file is
// not, and the message must not claim the agent wrote code it was merely shown.
// The rest pins the parts an agent depends on to find the spot: the file:line
// locator and a fence that a quoted markdown code block can't break out of.

import { describe, it, expect, beforeEach } from "vitest";
import { composeCommentsMessage, useReviewComments, type ReviewComment } from "./reviewComments";

const TASK = "t1";

function c(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: over.id ?? "c1",
    taskId: TASK,
    file: "src/a.ts",
    startLine: 10,
    endLine: 12,
    quote: "const x = 1;",
    body: "rename this",
    ...over,
  };
}

beforeEach(() => useReviewComments.getState().clear(TASK));

describe("composeCommentsMessage", () => {
  it("announces a diff batch as review feedback", () => {
    expect(composeCommentsMessage([c()])).toMatch(/^I reviewed your changes and left an inline comment:/);
    expect(composeCommentsMessage([c({ id: "a" }), c({ id: "b" })]))
      .toMatch(/^I reviewed your changes and left 2 inline comments:/);
  });

  it("sends an editor selection with no review framing at all", () => {
    const msg = composeCommentsMessage([c({ source: "editor" })]);
    expect(msg).not.toMatch(/reviewed/);
    // Straight to the goods: locator, snippet, comment.
    expect(msg).toBe("src/a.ts:10-12\n```\nconst x = 1;\n```\nrename this");
  });

  it("keeps the review framing when a diff comment is anywhere in the batch", () => {
    // Mixed batches come from the pending bar, which sends everything queued
    // for the task regardless of where each comment was made. One diff comment
    // means the message really is (partly) review feedback.
    const msg = composeCommentsMessage([c({ id: "a", source: "editor" }), c({ id: "b", source: "diff" })]);
    expect(msg).toMatch(/^I reviewed your changes and left 2 inline comments:/);
  });

  it("treats a comment with no source as a diff comment", () => {
    expect(composeCommentsMessage([c({ source: undefined })])).toMatch(/reviewed/);
  });

  it("locates single lines and whole files without a range", () => {
    expect(composeCommentsMessage([c({ source: "editor", startLine: 7, endLine: 7 })])).toContain("src/a.ts:7\n");
    const whole = composeCommentsMessage([c({ source: "editor", startLine: null, endLine: null, quote: "" })]);
    expect(whole).toBe("src/a.ts\nrename this");
  });

  it("outruns backticks inside the quote so a markdown snippet can't close the fence", () => {
    const msg = composeCommentsMessage([c({ source: "editor", quote: "```js\nlet a\n```" })]);
    expect(msg).toContain("````\n```js\nlet a\n```\n````");
  });

  it("groups by file and orders each file by line", () => {
    const msg = composeCommentsMessage([
      c({ id: "a", file: "src/b.ts", startLine: 3, endLine: 3, body: "b3" }),
      c({ id: "b", file: "src/a.ts", startLine: 9, endLine: 9, body: "a9" }),
      c({ id: "c", file: "src/b.ts", startLine: 1, endLine: 1, body: "b1" }),
    ]);
    const order = [...msg.matchAll(/^src\/\S+/gm)].map(m => m[0]);
    expect(order).toEqual(["src/b.ts:1", "src/b.ts:3", "src/a.ts:9"]);
  });

  it("sends a bodyless selection as just the code, no dangling blank line", () => {
    expect(composeCommentsMessage([c({ source: "editor", body: "  " })]))
      .toBe("src/a.ts:10-12\n```\nconst x = 1;\n```");
  });

  it("is empty for an empty batch", () => {
    expect(composeCommentsMessage([])).toBe("");
  });

  describe("strips control characters so the message cannot break out of its bracketed paste", () => {
    const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

    it("from a diff comment's body, keeping the tab and the text after each stripped byte", () => {
      const comment = c({ source: "diff", body: "fix\u001b[201~\rrm -rf /\tx" });

      const msg = composeCommentsMessage([comment]);

      expect(msg).not.toMatch(CONTROL);
      expect(msg).toMatch(/^I reviewed your changes/);
      expect(msg).toContain("\nfix[201~rm -rf /\tx");
    });

    it("from an editor comment's quote, turning a CRLF quote into LF only", () => {
      const comment = c({ source: "editor", quote: "a\u009bb\u0007c\r\nd", body: "" });

      const msg = composeCommentsMessage([comment]);

      expect(msg).not.toMatch(CONTROL);
      expect(msg).toBe("src/a.ts:10-12\n```\nabc\nd\n```");
    });

    it("from the file name", () => {
      const comment = c({ source: "editor", file: "src/\u001b[201~a.ts" });

      const msg = composeCommentsMessage([comment]);

      expect(msg).not.toMatch(CONTROL);
      expect(msg).toMatch(/^src\/\[201~a\.ts:10-12\n/);
    });
  });
});

describe("store", () => {
  it("round-trips the source tag through add", () => {
    const id = useReviewComments.getState().add({
      taskId: TASK, file: "src/a.ts", startLine: 1, endLine: 1, quote: "x", body: "y", source: "editor",
    });
    expect(useReviewComments.getState().byTask[TASK].find(x => x.id === id)?.source).toBe("editor");
  });

  it("keeps the source tag across an edit and a reanchor", () => {
    const store = useReviewComments.getState();
    const id = store.add({
      taskId: TASK, file: "src/a.ts", startLine: 1, endLine: 1, quote: "x", body: "y", source: "editor",
    });
    store.update(TASK, id, "changed");
    store.reanchor(TASK, id, { startLine: 4, endLine: 5 });
    const got = useReviewComments.getState().byTask[TASK].find(x => x.id === id)!;
    // The locator follows the code; the quote is what the user selected, then
    // and forever. Re-reading lines 4-5 here would quote code they never saw.
    expect(got).toMatchObject({ body: "changed", startLine: 4, endLine: 5, quote: "x", source: "editor" });
  });

  it("removeMany drops only the named ids, and leaves the state untouched when none match", () => {
    const store = useReviewComments.getState();
    store.clear(TASK);
    const a = store.add({ taskId: TASK, file: "a", startLine: 1, endLine: 1, quote: "x", body: "a" });
    const b = store.add({ taskId: TASK, file: "b", startLine: 1, endLine: 1, quote: "x", body: "b" });
    const before = useReviewComments.getState();

    store.removeMany(TASK, ["nope"]);
    const untouched = useReviewComments.getState();
    store.removeMany(TASK, [a]);

    expect(untouched).toBe(before);
    expect(useReviewComments.getState().byTask[TASK].map(x => x.id)).toEqual([b]);
  });
});
