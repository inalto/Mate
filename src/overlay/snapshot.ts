// Bridge from DOM editors to the canvas: an editor publishes a bitmap of its rendered content for
// the element's current revision; the canvas, exports and thumbnails then draw that bitmap.
//
// Text boxes are rendered here from their stored (sanitised) HTML, on demand: the renderer asks for
// a bitmap when it has none at the needed scale, PNG export and thumbnails wait for theirs, and the
// editor renders drafts while typing. Bitmaps are also kept per element by appearance (HTML,
// attributes, size, colour), so a box that only moved — a new revision — is drawn at once.
import { mapInkColor } from "../ink/theme";
import type { ThemeName } from "../ink/types";
import type { Element } from "../model/types";
import { boxSnapshots, type BoxBitmap } from "../renderers/boxSnapshot";
import { textContentOf } from "../text/textBox";
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
const inflight = new Map<string, { key: string; scale: number; done: Promise<void> }>();
const memoKey = (id: string, theme: ThemeName) => `${id}|${theme}`;
const failed = new Set<string>();

/** Power-of-two bitmap scale ≥ `pxPerUnit` (1…8), capped so neither side exceeds 4096 px. */
export function snapshotScale(pxPerUnit: number, width: number, height: number): number {
  let s = 1;
  while (s < pxPerUnit && s < MAX_SCALE) s *= 2;
  while (s > 1 && Math.max(width, height) * s > MAX_SNAPSHOT_PX) s /= 2;
  return s;
}

function appearance(el: Element, theme: ThemeName) {
  const content = textContentOf(el);
  const width = el.boxWidth ?? 0;
  const height = el.boxHeight ?? 0;
  const color = mapInkColor(content.textAttributes.color, theme);
  const key = JSON.stringify([content.contentHtml, content.textAttributes, width, height, color]);
  return { content, width, height, color, key };
}

/** Remembered bitmap of `el` as it looks now (any revision), with its scale; else null. */
export function textSnapshotFor(el: Element, theme: ThemeName): { bitmap: BoxBitmap; scale: number } | null {
  const m = textMemo.get(memoKey(el.id, theme));
  return m && m.key === appearance(el, theme).key ? m : null;
}

function remember(slot: string, r: Rendered): void {
  textMemo.delete(slot);
  textMemo.set(slot, r);
  if (textMemo.size > MAX_MEMO) textMemo.delete(textMemo.keys().next().value!);
}

/**
 * Render `el` at `scale` and remember it; `publish` also sets it as the element's snapshot (which
 * redraws the canvas). Concurrent requests for the same appearance share one render; a failed
 * appearance is not retried (the placeholder stays).
 */
export function renderTextSnapshot(el: Element, theme: ThemeName, scale: number, publish = true): Promise<void> {
  const a = appearance(el, theme);
  const slot = memoKey(el.id, theme);
  const have = textMemo.get(slot);
  if (have && have.key === a.key && have.scale >= scale) {
    if (publish && boxSnapshots.get(el) !== have.bitmap) publishBoxSnapshot(el, have.bitmap);
    return Promise.resolve();
  }
  const attempt = `${el.id}|${scale}|${a.key}`;
  if (failed.has(attempt) || a.width <= 0 || a.height <= 0) return Promise.resolve();
  const running = inflight.get(slot);
  if (running && running.key === a.key && running.scale >= scale) return running.done;
  const done: Promise<void> = htmlToBitmap(a.content, a.width, a.height, a.color, scale).then(
    (bitmap) => {
      if (inflight.get(slot)?.done === done) inflight.delete(slot);
      const cur = textMemo.get(slot);
      if (cur && cur.key === a.key && cur.scale > scale) return; // a sharper one arrived first
      remember(slot, { key: a.key, scale, bitmap });
      if (publish) publishBoxSnapshot(el, bitmap);
    },
    () => {
      if (inflight.get(slot)?.done === done) inflight.delete(slot);
      failed.add(attempt);
    },
  );
  inflight.set(slot, { key: a.key, scale, done });
  return done;
}

/** Ask for a bitmap of `el` at `scale` (fire and forget). */
export function requestTextSnapshot(el: Element, theme: ThemeName, scale: number): void {
  void renderTextSnapshot(el, theme, scale);
}

/**
 * Render the text boxes among `els` at `pxPerUnit` before a synchronous paint (PNG, thumbnails).
 * Kept per theme and not published: the export's theme may differ from the canvas's.
 */
export async function prepareTextSnapshots(
  els: Iterable<Element>,
  theme: ThemeName,
  pxPerUnit: number,
  timeoutMs = PREPARE_TIMEOUT_MS,
): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const el of els) {
    if (el.type !== "text-box" || el.deletedAt) continue;
    jobs.push(renderTextSnapshot(el, theme, snapshotScale(pxPerUnit, el.boxWidth ?? 0, el.boxHeight ?? 0), false));
  }
  if (jobs.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(jobs).then(() => undefined), timeout]);
  clearTimeout(timer);
}

/** Forget every remembered text bitmap and failure (tests, memory pressure). */
export function clearTextSnapshots(): void {
  textMemo.clear();
  inflight.clear();
  failed.clear();
}
