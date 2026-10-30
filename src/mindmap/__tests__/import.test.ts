import { describe, expect, it } from "vitest";
import { parseFreeMind, parseMindmapFile, parseOpml } from "../import";
import type { MindNode } from "../tree";

type Shape = { text: string; collapsed?: boolean; children: Shape[] };
const shape = (n: MindNode): Shape =>
  n.collapsed
    ? { text: n.text, collapsed: true, children: n.children.map(shape) }
    : { text: n.text, children: n.children.map(shape) };

const FREEMIND = `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.0.1">
  <node TEXT="Project" ID="ID_1">
    <node TEXT="Goals" POSITION="right">
      <node TEXT="Ship v1"/>
      <node TEXT="Grow &amp; learn"/>
    </node>
    <node TEXT="Risks" POSITION="left">
      <edge COLOR="#808080"/>
      <node TEXT="Time"/>
    </node>
    <node TEXT="Team"/>
  </node>
</map>`;

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Plans</title></head>
  <body>
    <outline text="Project">
      <outline text="Goals">
        <outline text="Ship v1"/>
        <outline text="Grow &amp; learn"/>
      </outline>
      <outline text="Risks"><outline text="Time"/></outline>
      <outline text="Team"/>
    </outline>
  </body>
</opml>`;

const EXPECTED: Shape = {
  text: "Project",
  children: [
    { text: "Goals", children: [{ text: "Ship v1", children: [] }, { text: "Grow & learn", children: [] }] },
    { text: "Risks", children: [{ text: "Time", children: [] }] },
    { text: "Team", children: [] },
  ],
};

const allIds = (n: MindNode): string[] => [n.id, ...n.children.flatMap(allIds)];

describe("mind-map import", () => {
  it("parses FreeMind and OPML fixtures to the same tree", () => {
    const fm = parseFreeMind(FREEMIND);
    const op = parseOpml(OPML);
    expect(shape(fm)).toEqual(EXPECTED);
    expect(shape(op)).toEqual(EXPECTED);
    const ids = allIds(fm);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads FreeMind folding and rich-text nodes", () => {
    const xml = `<map><node TEXT="R"><node TEXT="F" FOLDED="true"><node TEXT="x"/></node>
      <node><richcontent TYPE="NODE"><html><body><p>Rich   text</p></body></html></richcontent></node></node></map>`;
    expect(shape(parseFreeMind(xml))).toEqual({
      text: "R",
      children: [
        { text: "F", collapsed: true, children: [{ text: "x", children: [] }] },
        { text: "Rich text", children: [] },
      ],
    });
  });

  it("gives several top-level outlines a synthetic root with the title", () => {
    const xml = `<opml><head><title>Week</title></head><body><outline text="Mon"/><outline text="Tue"/></body></opml>`;
    expect(shape(parseOpml(xml))).toEqual({
      text: "Week",
      children: [
        { text: "Mon", children: [] },
        { text: "Tue", children: [] },
      ],
    });
    const untitled = `<opml><body><outline text="Mon"/><outline title="Tue"/></body></opml>`;
    expect(shape(parseOpml(untitled))).toEqual({
      text: "Imported",
      children: [
        { text: "Mon", children: [] },
        { text: "Tue", children: [] },
      ],
    });
  });

  it("picks the parser by root element and refuses anything else", () => {
    expect(shape(parseMindmapFile("notes.txt", FREEMIND))).toEqual(EXPECTED);
    expect(shape(parseMindmapFile("plan.mm", OPML))).toEqual(EXPECTED);
    expect(() => parseMindmapFile("page.html", "<html><body/></html>")).toThrow(/not a FreeMind or OPML/);
    expect(() => parseMindmapFile("bad.mm", "<map><node")).toThrow(Error);
    expect(() => parseFreeMind("<map></map>")).toThrow(/no nodes/);
  });
});
