import { describe, it, expect } from "vitest";
import { stripControl } from "./controlChars";

describe("stripControl", () => {
  it("keeps newlines and tabs", () => {
    expect(stripControl("a\nb\tc")).toBe("a\nb\tc");
  });

  it("drops NUL, ESC, DEL and the C1 range edges NEL and APC", () => {
    expect(stripControl("a\u0000b\u001bc\u007fd\u0085e\u009ff")).toBe("abcdef");
  });

  it("keeps non-ASCII text", () => {
    expect(stripControl("ü 中")).toBe("ü 中");
  });
});
