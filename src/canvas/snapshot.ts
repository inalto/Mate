// Static snapshot bitmap (spec 03 §1): the viewport plus a margin, rasterised at one camera.
// Committed strokes are appended incrementally; pans within the margin are a plain blit, zoom
// changes are a scaled blit until the caller re-rasterises.
import type { Element } from "../model/types";
import type { Camera, Viewport } from "./camera";

export type SnapshotContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = OffscreenCanvas | HTMLCanvasElement;

export interface SnapshotStats {
  rasters: number;
  appends: number;
  blits: number;
}

function createSurface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== "undefined" && OffscreenCanvas) return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export class SnapshotCache {
  readonly marginPx: number;
  readonly stats: SnapshotStats = { rasters: 0, appends: 0, blits: 0 };
  private surface: Surface | null = null;
  private ctx: SnapshotContext | null = null;
  private viewport: Viewport = { width: 0, height: 0 };
  private dpr = 1;
  /** Camera the current content was rasterised at (null → no usable content). */
  private rastered: Camera | null = null;
  /** Camera passed to the last `ensure`; `rasterAll` rasterises at this camera. */
  private target: Camera = { x: 0, y: 0, z: 1 };

  constructor(marginPx = 200) {
    this.marginPx = marginPx;
  }

  /** True when there is content that can be blitted (possibly stale). */
  get hasContent(): boolean {
    return this.rastered !== null;
  }

  /**
   * Size the bitmap for `viewport` (CSS px) at `dpr` and remember `camera` as the raster target.
   * Returns true when a `rasterAll` is needed: no content yet, size/dpr changed, zoom changed, or
   * the camera moved outside the covered margin.
   */
  ensure(viewport: Viewport, camera: Camera, dpr: number): boolean {
    this.target = { ...camera };
    const w = Math.max(1, Math.ceil((viewport.width + 2 * this.marginPx) * dpr));
    const h = Math.max(1, Math.ceil((viewport.height + 2 * this.marginPx) * dpr));
    if (!this.surface || this.surface.width !== w || this.surface.height !== h || this.dpr !== dpr) {
      if (!this.surface) {
        this.surface = createSurface(w, h);
      } else {
        this.surface.width = w;
        this.surface.height = h;
      }
      this.ctx = (this.surface.getContext("2d") as SnapshotContext | null) ?? null;
      this.rastered = null;
    }
    this.viewport = { width: viewport.width, height: viewport.height };
    this.dpr = dpr;
    return !this.covers(camera);
  }

  /** Whether `camera` can be served by a 1:1 blit of the current content. */
  covers(camera: Camera): boolean {
    const r = this.rastered;
    if (!r) return false;
    return (
      r.z === camera.z &&
      Math.abs(camera.x - r.x) <= this.marginPx &&
      Math.abs(camera.y - r.y) <= this.marginPx
    );
  }

  /** World-space rectangle covered by the bitmap at the target camera. */
  worldClip(): { x: number; y: number; width: number; height: number } {
    const c = this.target;
    const m = this.marginPx;
    return {
      x: (-m - c.x) / c.z,
      y: (-m - c.y) / c.z,
      width: (this.viewport.width + 2 * m) / c.z,
      height: (this.viewport.height + 2 * m) / c.z,
    };
  }

  private applyWorldTransform(ctx: SnapshotContext, c: Camera): void {
    const d = this.dpr;
    ctx.setTransform(d * c.z, 0, 0, d * c.z, (c.x + this.marginPx) * d, (c.y + this.marginPx) * d);
  }

  /**
   * Clear and redraw at the target camera. `draw(ctx)` is called once with no element (background),
   * then once per element; `ctx` carries the world transform.
   */
  rasterAll(elements: Iterable<Element>, draw: (ctx: SnapshotContext, el?: Element) => void): void {
    this.stats.rasters++;
    const ctx = this.ctx;
    if (!ctx || !this.surface) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.surface.width, this.surface.height);
    this.applyWorldTransform(ctx, this.target);
    draw(ctx);
    for (const el of elements) draw(ctx, el);
    this.rastered = { ...this.target };
  }

  /** Draw one more element into the current content (no-op without content). */
  append(drawOne: (ctx: SnapshotContext) => void): void {
    const ctx = this.ctx;
    if (!ctx || !this.rastered) return;
    this.stats.appends++;
    this.applyWorldTransform(ctx, this.rastered);
    drawOne(ctx);
  }

  /** Draw the bitmap onto `ctx` (device-pixel space, identity transform) for `camera`. */
  blitTo(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const r = this.rastered;
    if (!r || !this.surface) return;
    this.stats.blits++;
    const k = camera.z / r.z;
    const d = this.dpr;
    const m = this.marginPx;
    const dx = ((-m - r.x) * k + camera.x) * d;
    const dy = ((-m - r.y) * k + camera.y) * d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.surface as CanvasImageSource, dx, dy, this.surface.width * k, this.surface.height * k);
  }

  /** Drop the content; the next `ensure` reports a raster is needed. */
  invalidate(): void {
    this.rastered = null;
  }
}
