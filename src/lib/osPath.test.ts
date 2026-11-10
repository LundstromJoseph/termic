import { describe, it, expect } from "vitest";
import { toContainerPath, quoteWindowsPath, terminalPathText, relUnder, absUnder, baseName, normalizeAbsPath, joinPath, pathToFileUri, fileUriToPath } from "./osPath";

describe("toContainerPath", () => {
  it("is the identity off Windows", () => {
    expect(toContainerPath("/Users/u/a b.png", false)).toBe("/Users/u/a b.png");
  });
  it("maps a drive path to the container's /<drive>/ form, as docker.rs mounts it", () => {
    expect(toContainerPath("C:\\Users\\u\\shot.png", true)).toBe("/c/Users/u/shot.png");
    expect(toContainerPath("\\\\?\\D:\\wt\\api", true)).toBe("/d/wt/api");
    expect(toContainerPath("C:\\", true)).toBe("/c");
  });
});

describe("terminalPathText", () => {
  it("backslash-escapes on macOS, as Terminal.app does", () => {
    expect(terminalPathText("/Users/u/a b.png", false, false)).toBe("/Users/u/a\\ b.png");
  });
  it("quotes a native Windows path instead of escaping its separators", () => {
    expect(terminalPathText("C:\\Users\\u\\a b.png", false, true)).toBe('"C:\\Users\\u\\a b.png"');
    expect(terminalPathText("C:\\Users\\u\\ab.png", false, true)).toBe("C:\\Users\\u\\ab.png");
  });
  it("types the container path, escaped, into a Docker task on Windows", () => {
    expect(terminalPathText("C:\\Users\\u\\a b.png", true, true)).toBe("/c/Users/u/a\\ b.png");
  });
  it("doubles embedded quotes", () => {
    expect(quoteWindowsPath('C:\\a "b"')).toBe('"C:\\a ""b"""');
  });
});


describe("relUnder", () => {
  it("is a segment boundary, not a raw prefix", () => {
    expect(relUnder("/repo/src/a.ts", "/repo", false)).toBe("src/a.ts");
    expect(relUnder("/repo-old/a.ts", "/repo", false)).toBeNull();
    expect(relUnder("/repo", "/repo", false)).toBeNull();
  });
  it("ignores case and separator style on Windows", () => {
    expect(relUnder("c:\\Repo\\src\\a.ts", "C:\\repo", true)).toBe("src/a.ts");
    expect(relUnder("C:/repo/src/a.ts", "C:\\repo\\", true)).toBe("src/a.ts");
    expect(relUnder("C:\\repo-old\\a.ts", "C:\\repo", true)).toBeNull();
  });
});

describe("normalizeAbsPath", () => {
  it("folds . and .. segments of a POSIX path and stops .. at the root", () => {
    expect(normalizeAbsPath("/repo/wt/../../docs/./r.md", false)).toBe("/docs/r.md");
    expect(normalizeAbsPath("/a//b/", false)).toBe("/a/b");
    expect(normalizeAbsPath("/../../r.md", false)).toBe("/r.md");
  });
  it("folds a Windows drive path with either separator and joins it with backslashes", () => {
    expect(normalizeAbsPath("C:\\repo\\wt/..\\docs\\.\\r.md", true)).toBe("C:\\repo\\docs\\r.md");
    expect(normalizeAbsPath("C:\\..\\r.md", true)).toBe("C:\\r.md");
  });
  it("returns a path with no recognised root unchanged", () => {
    expect(normalizeAbsPath("a/../b.md", false)).toBe("a/../b.md");
    expect(normalizeAbsPath("/tmp/../r.md", true)).toBe("/tmp/../r.md");
  });
});

describe("file URIs", () => {
  it("keeps the unix encoding byte for byte", () => {
    expect(pathToFileUri("/tmp/a#b", false)).toBe("file:///tmp/a%23b");
    expect(fileUriToPath("file:///tmp/a%23b", false)).toBe("/tmp/a#b");
  });
  it("uses file:///C:/... on Windows and round-trips to a native path", () => {
    expect(pathToFileUri("C:\\Users\\u\\a b.ts", true)).toBe("file:///C:/Users/u/a%20b.ts");
    expect(fileUriToPath("file:///C:/Users/u/a%20b.ts", true)).toBe("C:\\Users\\u\\a b.ts");
    // VS Code style (encoded colon) decodes too.
    expect(fileUriToPath("file:///c%3A/x/y.ts", true)).toBe("c:\\x\\y.ts");
  });
  it("takes the last segment on either separator on Windows", () => {
    expect(baseName("C:\\a\\b.ts", true)).toBe("b.ts");
    expect(baseName("/a/b.ts", false)).toBe("b.ts");
  });
});

describe("absUnder", () => {
  it("resolves a task-relative path against a native root", () => {
    expect(absUnder("/Users/u/src", "a/b.ts", false)).toBe("/Users/u/src/a/b.ts");
    expect(absUnder("C:\\Users\\u\\src", "a\\b.ts", true)).toBe("C:\\Users\\u\\src\\a\\b.ts");
  });
  it("drops a trailing separator on the root, and survives a bare root", () => {
    expect(absUnder("/Users/u/src/", "a", false)).toBe("/Users/u/src/a");
    expect(absUnder("/", "a", false)).toBe("/a");
    expect(absUnder("C:\\", "a", true)).toBe("C:\\a");
  });
  it("returns the root itself for an empty relative path", () => {
    expect(absUnder("/Users/u/src", "", false)).toBe("/Users/u/src");
    expect(absUnder("C:\\Users\\u\\src\\", "", true)).toBe("C:\\Users\\u\\src");
  });
  it("leaves forward slashes alone off Windows", () => {
    expect(absUnder("/Users/u/src", "a/b", false)).toBe("/Users/u/src/a/b");
  });
  // The regression. The app joins with `/` and Rust hands the root back with
  // `\`, so the two halves of this disagree on Windows. explorer does not
  // reject the mixed result, it silently opens the user's Documents folder,
  // so no error and no other test catches it: assert the whole string.
  it("normalizes BOTH halves to backslashes on Windows", () => {
    expect(absUnder("I:\\repo", "src/components", true)).toBe("I:\\repo\\src\\components");
    expect(absUnder("C:/Users/u/src/", "a/b", true)).toBe("C:\\Users\\u\\src\\a\\b");
  });
});

describe("joinPath", () => {
  it("joins with the platform's separator, dropping a trailing one", () => {
    expect(joinPath("/Users/u/src/", "repo", false)).toBe("/Users/u/src/repo");
    expect(joinPath("/", "repo", false)).toBe("/repo");
    expect(joinPath("C:\\Users\\u\\src\\", "repo", true)).toBe("C:\\Users\\u\\src\\repo");
    expect(joinPath("C:\\", "repo", true)).toBe("C:\\repo");
    // A forward-slashed dir is normalized, not merely appended to. This used
    // to be pinned as `C:/Users/u/src\repo`, which is the same mixed path
    // explorer silently redirects (see absUnder's spec above).
    expect(joinPath("C:/Users/u/src/", "repo", true)).toBe("C:\\Users\\u\\src\\repo");
  });
});
