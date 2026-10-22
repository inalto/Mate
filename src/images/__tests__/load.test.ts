import { afterEach, describe, expect, it, vi } from "vitest";
import { boxSnapshots } from "../../renderers/boxSnapshot";
import { cachedImageIds, configureImageLoader, createDecoder, getImage, loadImage } from "../load";

const IMG = { width: 1, height: 1 };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => configureImageLoader());

describe("decoder", () => {
  it("decoder_sets_cross_origin_anonymous", async () => {
    const order: string[] = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set crossOrigin(v: string) {
        order.push(`crossOrigin=${v}`);
      }
      set src(v: string) {
        order.push(`src=${v}`);
        queueMicrotask(() => this.onload?.());
      }
    }
    await createDecoder(FakeImage as unknown as new () => HTMLImageElement)("http://asset.localhost/x.png");
    expect(order).toEqual(["crossOrigin=anonymous", "src=http://asset.localhost/x.png"]);
  });
});

describe("image cache", () => {
  const setup = (cacheLimit: number) =>
    configureImageLoader({ cacheLimit, resolver: async (id) => `u/${id}`, decoder: async () => IMG as never });

  it("cache_does_not_evict_images_drawn_this_frame", async () => {
    setup(4);
    const first = ["a", "b", "c", "d", "e", "f"];
    await Promise.all(first.map(loadImage));
    await tick();
    // One raster pass requests all six: none may be evicted although the cap is 4.
    first.forEach((id) => expect(getImage(id)).not.toBeNull());
    expect(cachedImageIds().sort()).toEqual(first);
    // Next pass (new generation) wants a different set: the old ones may now go.
    await tick();
    expect(getImage("g")).toBeNull();
    await tick();
    await tick();
    expect(cachedImageIds()).toContain("g");
    expect(cachedImageIds().length).toBeLessThanOrEqual(4);
  });

  it("completed_load_notifies_once", async () => {
    setup(8);
    const seen: string[] = [];
    const off = boxSnapshots.subscribe((id) => seen.push(id));
    expect(getImage("x")).toBeNull();
    expect(getImage("x")).toBeNull(); // still pending: no second load
    await tick();
    await tick();
    expect(seen).toEqual(["x"]);
    expect(getImage("x")).not.toBeNull();
    await tick();
    expect(seen).toEqual(["x"]);
    off();
  });

  it("does not notify for an image no recent raster asked for", async () => {
    setup(8);
    const seen: string[] = [];
    const off = boxSnapshots.subscribe((id) => seen.push(id));
    const resolve = vi.fn(async (id: string) => `u/${id}`);
    configureImageLoader({ resolver: resolve, decoder: async () => IMG as never });
    await loadImage("direct");
    await tick();
    expect(seen).toEqual([]);
    off();
  });
});
