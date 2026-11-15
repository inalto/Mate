import type { MarkerTarget } from "../canvas/toolInteractions";
import type { EditorState, EditorStore } from "../stores/editor";
import { isCover } from "./cover";

/**
 * The page's recall covers as a tap sees them (`createReplayTap`): a live cover is a target, and
 * "opening" one peeks under it or covers it again.
 */
export function coverTargetOf(editor: EditorStore): MarkerTarget {
  return {
    isMarker(id) {
      const el = editor.getState().elements.get(id);
      return !!el && !el.deletedAt && isCover(el);
    },
    open(id) {
      editor.getState().toggleReveal(id);
    },
  };
}

/** The last union `dimOf` built, so a raster asks for it once per element without rebuilding it. */
let lastDim: { replayDim: ReadonlySet<string>; revealed: ReadonlySet<string>; union: ReadonlySet<string> } | null = null;

/**
 * The ids a pane draws at 25 %: the replay's dimmed ids and the revealed covers, each once (a
 * revealed cover the replay also dims is not dimmed twice); null when both are empty.
 */
export function dimOf(s: Pick<EditorState, "replayDim" | "revealed">): ReadonlySet<string> | null {
  const { replayDim, revealed } = s;
  if (!replayDim || replayDim.size === 0) return revealed.size > 0 ? revealed : null;
  if (revealed.size === 0) return replayDim;
  if (lastDim?.replayDim !== replayDim || lastDim.revealed !== revealed) lastDim = { replayDim, revealed, union: new Set([...replayDim, ...revealed]) };
  return lastDim.union;
}
