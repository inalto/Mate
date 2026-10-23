// DOM layer over one pane's canvas, in page units: the inner layer carries the camera transform, so
// children are positioned with plain page coordinates. Hosts a BoxFrame for each selected boxed
// element and the editor slot (`data-editor-for`) of the element being edited. The layer itself
// lets pointer events through to the canvas; only its frames, handles and editors take them.
// Also hosts the search flash (page units) and the tutor card (screen space, beside the layer).
import { createElement, useCallback, type CSSProperties } from "react";
import FlashLayer from "../components/FlashLayer";
import { contentOf } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { paneOfStore } from "../stores/tutor";
import TutorCard from "../tutor/TutorCard";
import { useTutorViews } from "../tutor/useTutor";
import { boxRect, contentMeta, isBoxed } from "../tools/spatialIndex";
import BoxFrame from "./BoxFrame";
import { boxStyle } from "./boxGeometry";
import { editorFor } from "./editorRegistry";

export default function OverlayLayer({ store }: { store: EditorStore }) {
  const camera = store((s) => s.camera);
  const elements = store((s) => s.elements);
  const selection = store((s) => s.selection);
  const editingId = store((s) => s.editingId);
  const pageId = store((s) => s.loadedPageId);
  const pane = paneOfStore(store);
  const recognitions = useTutorViews((s) => s.views[pane].recognitions);
  const regions = useTutorViews((s) => s.views[pane].regions);
  const boundsOf = useCallback((id: string) => recognitions.get(id)?.bounds ?? regions.get(id)?.bounds, [recognitions, regions]);

  const framed = [...selection].map((id) => elements.get(id)).filter((el): el is Element => el !== undefined && isBoxed(el));
  const editing = editingId !== null ? elements.get(editingId) : undefined;

  const layerStyle = {
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`,
    transformOrigin: "0 0",
    "--overlay-inv-z": String(1 / camera.z),
  } as CSSProperties;

  return (
    <div className="overlay-clip">
      <div className="overlay-layer" data-testid="overlay-layer" style={layerStyle}>
        {editing && (
          <div className="box-editor" data-editor-for={editing.id} data-editor-type={editing.type} style={boxStyle(boxRect(editing), contentMeta(editing).rotation ?? 0)}>
            {createElement(editorFor(editing.type, contentOf<{ subtype?: string }>(editing).subtype), { el: editing, store })}
          </div>
        )}
        {framed.map((el) => (
          <BoxFrame key={el.id} el={el} store={store} zoom={camera.z} handles={selection.size === 1} />
        ))}
        {pageId && <FlashLayer pageId={pageId} zoom={camera.z} boundsOf={boundsOf} />}
      </div>
      <TutorCard store={store} pane={pane} />
    </div>
  );
}
