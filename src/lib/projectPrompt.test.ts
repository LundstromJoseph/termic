import { describe, it, expect } from "vitest";
import { projectDefaultPrompt, withProjectPrompt } from "./projectPrompt";

describe("projectDefaultPrompt", () => {
  it("resolves an unset, missing or whitespace-only default to an empty string", () => {
    expect(projectDefaultPrompt({})).toBe("");
    expect(projectDefaultPrompt(undefined)).toBe("");
    expect(projectDefaultPrompt(null)).toBe("");
    expect(projectDefaultPrompt({ default_initial_prompt: "  \n " })).toBe("");
  });

  it("trims the stored default", () => {
    expect(projectDefaultPrompt({ default_initial_prompt: "  Read AGENTS.md.\n" })).toBe("Read AGENTS.md.");
  });
});

describe("withProjectPrompt", () => {
  it("returns the text unchanged when the project has no default", () => {
    expect(withProjectPrompt("", "ticket body", 100)).toBe("ticket body");
  });

  it("returns the default alone when the text is empty or whitespace", () => {
    expect(withProjectPrompt("Read AGENTS.md.", "", 100)).toBe("Read AGENTS.md.");
    expect(withProjectPrompt("Read AGENTS.md.", "  ", 100)).toBe("Read AGENTS.md.");
  });

  it("puts the default first, then a blank line, then the text", () => {
    expect(withProjectPrompt("Read AGENTS.md.", "ticket body", 100)).toBe("Read AGENTS.md.\n\nticket body");
  });

  it("cuts over-cap text and keeps the default whole, never exceeding max", () => {
    const def = "D".repeat(10);

    const out = withProjectPrompt(def, "T".repeat(50), 20);

    expect(out).toBe(`${def}\n\n${"T".repeat(8)}`);
    expect(out.length).toBe(20);
  });

  it("returns only the default, capped at max, when the default leaves no room for text", () => {
    expect(withProjectPrompt("D".repeat(19), "text", 20)).toBe("D".repeat(19));
    expect(withProjectPrompt("D".repeat(30), "text", 20)).toBe("D".repeat(20));
  });
});
