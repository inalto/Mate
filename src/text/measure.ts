// Text-box geometry and text extraction (pure apart from the optional DOM measurement): plain text
// of sanitised HTML, a new box's size, the content height, and baseline snapping to ruled lines.
import type { Vec2 } from "../canvas/camera";
import { sheetSize } from "../canvas/camera";
import type { TextAttributes } from "../model/content";
import { PAGE_GAP } from "../model/constants";
import type { Page } from "../model/types";
import { sanitizeHtml } from "./sanitize";
import { boxCss, CONTENT_CLASS, cssText, DEFAULT_BOX_WIDTH, LINE_HEIGHT } from "./style";

const BLOCKS = new Set(["p", "h1", "h2", "h3", "li", "ul", "ol", "div"]);

/** Plain text of (sanitised) `html`: blocks and `<br>` become line breaks. */
export function plainText(html: string): string {
  const body = new DOMParser().parseFromString(`<body>${sanitizeHtml(html)}</body>`, "text/html").body;
  const lines: string[] = [];
  let cur = "";
  const flush = () => {
    lines.push(cur);
    cur = "";
  };
  const walk = (n: Node) => {
    for (const c of Array.from(n.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) cur += c.textContent ?? "";
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const tag = (c as globalThis.Element).localName;
        if (tag === "br") {
          flush();
          continue;
        }
        const block = BLOCKS.has(tag);
        if (block && cur) flush();
        walk(c);
        if (block && cur) flush();
      }
    }
  };
  walk(body);
  if (cur) flush();
  return lines.join("\n").replace(/\n+$/, "");
}

/** Height of one line (page units) — the minimum box height. */
export const lineHeightOf = (fontSize: number): number => fontSize * LINE_HEIGHT;

/** Size of a new text box. */
export const defaultBoxSize = (fontSize: number) => ({ width: DEFAULT_BOX_WIDTH, height: lineHeightOf(fontSize) });

/** Offset of the first baseline below the box top (half-leading plus an ascent of ~0.8 em). */
export const firstBaselineOffset = (fontSize: number): number => (fontSize * (LINE_HEIGHT - 1)) / 2 + fontSize * 0.8;

/** Box height for content measured at `measured` units (0 = not measurable): at least one line. */
export function boxHeightFor(measured: number, fontSize: number, fallback: number): number {
  const min = lineHeightOf(fontSize);
  return measured > 0 ? Math.max(min, Math.ceil(measured)) : Math.max(min, fallback);
}

/**
 * Laid-out height (page units) of `html` with `attrs` at `width`, measured off-screen; 0 where the
 * document has no layout (tests).
 */
export function measureHtmlHeight(html: string, attrs: TextAttributes, width: number): number {
  if (typeof document === "undefined") return 0;
  const host = document.createElement("div");
  host.className = CONTENT_CLASS;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `${cssText(boxCss(attrs))} position: absolute; left: -100000px; top: 0; visibility: hidden; width: ${width}px;`;
  host.innerHTML = sanitizeHtml(html);
  document.body.appendChild(host);
  try {
    return host.scrollHeight;
  } finally {
    host.remove();
  }
}

/**
 * Top-left of a new box clicked at `p` whose first baseline sits on the nearest ruled line of
 * `page` (ruled backgrounds; page mode keeps to the clicked sheet's lines). Other backgrounds: `p`.
 */
export function alignToRuledLine(p: Vec2, fontSize: number, page: Page, defaultAspect: string): Vec2 {
  const cfg = page.backgroundConfig;
  if (cfg.type !== "ruled" && cfg.type !== "ruled-no-margin") return p;
  const step = cfg.spacing > 0 ? cfg.spacing : 40;
  const off = firstBaselineOffset(fontSize);
  const target = p.y + off;
  let line: number;
  if (page.mode === "page") {
    const { height } = sheetSize(page, defaultAspect);
    const stride = height + PAGE_GAP;
    const top = Math.max(0, Math.floor(target / stride)) * stride;
    const last = Math.max(1, Math.floor(height / step));
    const k = Math.min(last, Math.max(1, Math.round((target - top) / step)));
    line = top + k * step;
  } else {
    line = Math.round(target / step) * step;
  }
  return { x: p.x, y: line - off };
}
