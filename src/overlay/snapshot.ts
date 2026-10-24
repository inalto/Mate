// Bridge from DOM editors to the canvas: an editor publishes a bitmap of its rendered content for
// the element's current revision; the canvas, exports and thumbnails then draw that bitmap.
//
// Text boxes, tables and code blocks are rendered here from their stored (sanitised) content, on demand: the renderer asks for
// a bitmap when it has none at the needed scale, PNG export and thumbnails wait for theirs, and the
// editor renders drafts while typing. Bitmaps are also kept per element by appearance (HTML,
// attributes, size, colour), so a box that only moved — a new revision — is drawn at once.
import i18n from "../i18n";
import type { ThemeName } from "../ink/types";
import type { Element } from "../model/types";
import { boxSnapshots, type BoxBitmap } from "../renderers/boxSnapshot";
import { boxAppearance, isHtmlBox } from "../text/boxHtml";
import { htmlToBitmap } from "./htmlToBitmap";

/** Publish `bitmap` as the appearance of `el` at its current revision (`el.updatedAt`). */
export function publishBoxSnapshot(el: Pick<Element, "id" | "updatedAt">, bitmap: BoxBitmap): void {
  boxSnapshots.set(el.id, el.updatedAt, bitmap);
}

/** Drop the snapshot of element `id` (e.g. its editor failed to render); the placeholder returns. */
export function dropBoxSnapshot(id: string): void {
  boxSnapshots.invalidate(id);
  for (const k of [...textMemo.keys()]) if (k.startsWith(`${id}|`)) textMemo.delete(k);
}

// ---- text boxes ----

/** Largest snapshot side in device pixels. */
const MAX_SNAPSHOT_PX = 4096;
const MAX_SCALE = 8;
/** Default time PNG export / thumbnails wait for text snapshots. */
const PREPARE_TIMEOUT_MS = 3000;
/** Bound on remembered text bitmaps (oldest dropped first). */
const MAX_MEMO = 400;

interface Rendered {
  key: string;
  scale: number;
  bitmap: BoxBitmap;
}

/** Remembered bitmaps and renders in flight, per element and theme (`memoKey`). */
const textMemo = new Map<string, Rendered>();
const inflight = new Map<string, { key: string; scale: number; done: Promise<BoxBitmap | null> }>();
const memoKey = (id: string, theme: ThemeName) => `${id}|${theme}`;
const failed = new Set<string>();

/** Power-of-two bitmap scale ≥ `pxPerUnit` (1…8), capped so neither side exceeds 4096 px. */
export function snapshotScale(pxPerUnit: number, width: number, height: number): number {
  let s = 1;
  while (s < pxPerUnit && s < MAX_SCALE) s *= 2;
  while (s > 1 && Math.max(width, height) * s > MAX_SNAPSHOT_PX) s /= 2;
  return s;
}

/** Appearance of a text box, table or code block (null for other types). */
const appearance = (el: Element, theme: ThemeName) => boxAppearance(el, theme);

/** Remembered bitmap of `el` as it looks now (any revision), with its scale; else null. */
export function textSnapshotFor(el: Element, theme: ThemeName): { bitmap: BoxBitmap; scale: number } | null {
  const m = textMemo.get(memoKey(el.id, theme));
  return m && m.key === appearance(el, theme)?.key ? m : null;
}

function remember(slot: string, r: Rendered): void {
  textMemo.delete(slot);
  textMemo.set(slot, r);
  if (textMemo.size > MAX_MEMO) textMemo.delete(textMemo.keys().next().value!);
}

/**
 * Render `el` at `scale` and remember it; `publish` also sets it as the element's snapshot (which
 * redraws the canvas). Concurrent requests for the same appearance share one render; a failed
 * appearance is not retried (the placeholder stays). Resolves with the bitmap (null when none could
 * be rendered), so callers need not read it back from the bounded memo.
 */
export function renderTextSnapshot(el: Element, theme: ThemeName, scale: number, publish = true): Promise<BoxBitmap | null> {
  const a = appearance(el, theme);
  if (!a) return Promise.resolve(null);
  const slot = memoKey(el.id, theme);
  const have = textMemo.get(slot);
  if (have && have.key === a.key && have.scale >= scale) {
    if (publish && boxSnapshots.get(el) !== have.bitmap) publishBoxSnapshot(el, have.bitmap);
    return Promise.resolve(have.bitmap);
  }
  const attempt = `${el.id}|${scale}|${a.key}`;
  if (failed.has(attempt) || a.width <= 0 || a.height <= 0) return Promise.resolve(null);
  const running = inflight.get(slot);
  if (running && running.key === a.key && running.scale >= scale) return running.done;
  const done: Promise<BoxBitmap | null> = htmlToBitmap(a.foreignObject, a.width, a.height, scale).then(
    (bitmap) => {
      if (inflight.get(slot)?.done === done) inflight.delete(slot);
      const cur = textMemo.get(slot);
      if (cur && cur.key === a.key && cur.scale > scale) return cur.bitmap; // a sharper one arrived first
      remember(slot, { key: a.key, scale, bitmap });
      if (publish) publishBoxSnapshot(el, bitmap);
      return bitmap;
    },
    () => {
      if (inflight.get(slot)?.done === done) inflight.delete(slot);
      failed.add(attempt);
      return null;
    },
  );
  inflight.set(slot, { key: a.key, scale, done });
  return done;
}

/** Ask for a bitmap of `el` at `scale` (fire and forget). */
export function requestTextSnapshot(el: Element, theme: ThemeName, scale: number): void {
  void renderTextSnapshot(el, theme, scale);
}

/** Text-box / table / code bitmaps prepared for one export paint, by `textBitmapKey(id, theme)`. */
export type TextBitmapSet = ReadonlyMap<string, BoxBitmap>;
export const textBitmapKey = memoKey;

/** Time thumbnails wait for their text snapshots (exports wait for all of them). */
export const THUMBNAIL_TEXT_TIMEOUT_MS = PREPARE_TIMEOUT_MS;

/**
 * Render the text boxes, tables and code blocks among `els` at `pxPerUnit` before a synchronous
 * paint, and return their bitmaps keyed `id|theme` (pass them as `RenderOptions.textBitmaps`). Kept
 * per theme and not published: the export's theme may differ from the canvas's.
 *
 * Without `timeoutMs` (exports) every render is awaited and a box that cannot be rendered rejects,
 * so no export is written with a placeholder. With it (thumbnails) the wait is bounded and the
 * result holds whatever was ready.
 */
export async function prepareTextSnapshots(
  els: Iterable<Element>,
  theme: ThemeName,
  pxPerUnit: number,
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<Map<string, BoxBitmap>> {
  // Bitmaps are collected as each render resolves: the memo is a bounded cache (MAX_MEMO), not the
  // source of truth, so a page with more boxes than it holds still exports every one.
  const out = new Map<string, BoxBitmap>();
  const boxes: Element[] = [];
  const jobs: Promise<void>[] = [];
  for (const el of els) {
    if (!isHtmlBox(el) || el.deletedAt) continue;
    boxes.push(el);
    const scale = snapshotScale(pxPerUnit, el.boxWidth ?? 0, el.boxHeight ?? 0);
    jobs.push(
      renderTextSnapshot(el, theme, scale, false).then((bmp) => {
        if (bmp) out.set(memoKey(el.id, theme), bmp);
      }),
    );
  }
  if (jobs.length > 0) {
    if (timeoutMs === undefined) {
      await Promise.all(jobs);
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([Promise.all(jobs).then(() => undefined), timeout]);
      clearTimeout(timer);
    }
  }
  if (timeoutMs === undefined) {
    for (const el of boxes) {
      if (!out.has(memoKey(el.id, theme)) && (el.boxWidth ?? 0) > 0 && (el.boxHeight ?? 0) > 0) {
        throw new Error(i18n.t("export.boxRender", { id: el.id }));
      }
    }
  }
  // Thumbnails: whatever finished in time (a copy, so late renders do not change it afterwards).
  return timeoutMs === undefined ? out : new Map(out);
}

/** Forget every remembered text bitmap and failure (tests, memory pressure). */
export function clearTextSnapshots(): void {
  textMemo.clear();
  inflight.clear();
  failed.clear();
}
