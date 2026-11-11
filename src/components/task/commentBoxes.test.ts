import { describe, it, expect, vi } from "vitest";

const platform = vi.hoisted(() => ({ isWindows: false }));
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, get IS_WINDOWS() { return platform.isWindows; } };
});
vi.mock("@/lib/ipc", () => ({}));
vi.mock("@/lib/sendComments", () => ({ sendCommentsToAgent: vi.fn() }));
vi.mock("@/lib/sendReviewComments", () => ({ sendReviewComments: vi.fn() }));

import { locLabel } from "./commentBoxes";

describe("locLabel", () => {
  it("names a task-relative file by its basename", () => {
    platform.isWindows = false;

    const label = locLabel(3, 3, "src/lib/report.md");

    expect(label).toBe("report.md · line 3");
  });

  it("names a Windows absolute path by its basename, not the whole path", () => {
    platform.isWindows = true;

    const label = locLabel(4, 6, "C:\\Users\\u\\reports\\report.md");

    expect(label).toBe("report.md · lines 4–6");
  });
});
