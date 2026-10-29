// Player source URLs: the `asset:` URL of a media asset, looked up once per asset id.
import { assetUrl } from "../ipc/assets";

const urls = new Map<string, Promise<string | null>>();

/** `asset:` URL of `assetId`, looked up once per asset. */
export function mediaUrl(assetId: string): Promise<string | null> {
  let p = urls.get(assetId);
  if (!p) {
    p = assetUrl(assetId).catch(() => null);
    urls.set(assetId, p);
    void p.then((u) => {
      if (u === null) urls.delete(assetId); // retry later (e.g. the asset was still being written)
    });
  }
  return p;
}
