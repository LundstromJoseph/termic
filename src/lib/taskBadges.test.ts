import { describe, it, expect } from "vitest";
import { BADGE_TONES, badgeColor, sameBadges } from "@/lib/taskBadges";

describe("badgeColor", () => {
  it("maps each tone to its theme token", () => {
    expect(badgeColor("good")).toBe("var(--color-ok)");
    expect(badgeColor("warning")).toBe("var(--color-warn)");
    expect(badgeColor("error")).toBe("var(--color-err)");
    expect(badgeColor("neutral")).toBe("var(--color-fg-dim)");
  });

  it("passes a hex through as given", () => {
    expect(badgeColor("#3b82f6")).toBe("#3b82f6");
    expect(badgeColor("#ABC")).toBe("#ABC");
  });

  it("falls back to neutral for anything that is neither a tone nor a hex", () => {
    for (const junk of ["red", "#abcd", "", "toString", "url(x)"]) {
      expect(badgeColor(junk), junk).toBe(BADGE_TONES.neutral);
    }
  });
});

describe("sameBadges", () => {
  const ci = { key: "ci", text: "passing", color: "good" };
  const review = { key: "review", text: "waiting", color: "neutral" };

  it("treats undefined and an empty list as equal", () => {
    expect(sameBadges(undefined, [])).toBe(true);
    expect(sameBadges([], undefined)).toBe(true);
  });

  it("is true for equal lists held in different arrays", () => {
    expect(sameBadges([ci, review], [{ ...ci }, { ...review }])).toBe(true);
  });

  it("is false when key, text, colour, length or order differ", () => {
    expect(sameBadges([ci], [{ ...ci, key: "build" }])).toBe(false);
    expect(sameBadges([ci], [{ ...ci, text: "failing" }])).toBe(false);
    expect(sameBadges([ci], [{ ...ci, color: "error" }])).toBe(false);
    expect(sameBadges([ci], [ci, review])).toBe(false);
    expect(sameBadges([ci, review], [review, ci])).toBe(false);
  });
});
