import { describe, it, expect } from "vitest";
import { fitView, zoomAt } from "./MermaidZoom";

describe("fitView", () => {
  it("scales a wide box to 95% of the viewport width and centres it vertically", () => {
    const v = fitView({ w: 400, h: 100 }, { w: 800, h: 600 });
    expect(v.s).toBeCloseTo(1.9);
    expect(v.x).toBeCloseTo((800 - 400 * 1.9) / 2);
    expect(v.y).toBeCloseTo((600 - 100 * 1.9) / 2);
  });

  it("fits a tall box by its height", () => {
    expect(fitView({ w: 100, h: 1000 }, { w: 800, h: 500 }).s).toBeCloseTo(0.475);
  });

  it("never scales a small diagram above 2x", () => {
    const v = fitView({ w: 50, h: 20 }, { w: 1000, h: 800 });
    expect(v).toEqual({ s: 2, x: 450, y: 380 });
  });
});

describe("zoomAt", () => {
  it("keeps the content point under the pointer fixed", () => {
    const before = { x: 30, y: -10, s: 1.5 };
    const after = zoomAt(before, 2, 200, 120);
    // the content coordinate under (200, 120), before and after
    expect((200 - after.x) / after.s).toBeCloseTo((200 - before.x) / before.s);
    expect((120 - after.y) / after.s).toBeCloseTo((120 - before.y) / before.s);
    expect(after.s).toBe(3);
  });

  it("clamps the scale to [0.1, 8] and still pins the pointer at the clamp", () => {
    const up = zoomAt({ x: 0, y: 0, s: 6 }, 4, 100, 100);
    expect(up.s).toBe(8);
    expect((100 - up.x) / up.s).toBeCloseTo(100 / 6);
    expect(zoomAt({ x: 0, y: 0, s: 0.2 }, 0.1, 0, 0).s).toBe(0.1);
  });
});
