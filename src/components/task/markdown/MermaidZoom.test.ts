// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { cloneForZoom, fitView, zoomAt } from "./MermaidZoom";

// `label` lands in a <foreignObject> as HTML-namespace elements, the way a
// browser parses mermaid's labels (happy-dom's parser would leave them SVG).
function renderSvg(inner: string, label = ""): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20">${inner}<foreignObject width="40" height="20"></foreignObject></svg>`;
  const div = document.createElement("div");
  div.innerHTML = label;
  host.querySelector("foreignObject")!.append(div);
  return host.querySelector("svg")!;
}

describe("cloneForZoom", () => {
  it("strips every navigation attribute in the clone (svg and html links, image-map areas, usemap, form action, formaction and form) and leaves the original intact", () => {
    const svg = renderSvg(
      `<a xlink:href="https://example.com"><rect width="10" height="10"></rect></a>`
      + `<a href="about:blank"><rect width="10" height="10"></rect></a>`,
      `<a href="https://example.com/a">a</a>`
      + `<img usemap="#m"><map name="m"><area shape="default" href="https://example.com/y"></map>`
      + `<form action="https://example.com/f"><button formaction="https://example.com/b">b</button></form>`
      + `<button form="f">c</button>`,
    );

    const { el } = cloneForZoom(svg);

    const navigating = ["href", "xlink:href", "action", "formaction", "form", "usemap"];
    const left = Array.from(el.querySelectorAll("*"))
      .flatMap(n => n.getAttributeNames().filter(a => navigating.includes(a)).map(a => `${n.localName}[${a}]`));
    expect(left).toEqual([]);
    expect(svg.querySelector("area")!.getAttribute("href")).toBe("https://example.com/y");
  });

  it("keeps href on svg <image> and <use> in the clone because they are content, not links", () => {
    const svg = renderSvg(
      `<image href="data:image/png;base64,AA=="></image><use xlink:href="#shape"></use>`,
    );

    const { el } = cloneForZoom(svg);

    expect(el.querySelector("image")!.getAttribute("href")).toBe("data:image/png;base64,AA==");
    expect(el.querySelector("use")!.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#shape");
  });

  it("cancels a form submit inside the clone so an action-less form cannot reload the app", () => {
    const svg = renderSvg("", "<form></form>");
    const { el } = cloneForZoom(svg);
    const submit = new Event("submit", { bubbles: true, cancelable: true });

    el.querySelector("form")!.dispatchEvent(submit);

    expect(submit.defaultPrevented).toBe(true);
  });
});

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
