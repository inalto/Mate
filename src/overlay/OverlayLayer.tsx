// DOM layer over one pane's canvas, in page units: the inner layer carries the camera transform, so
// children are positioned with plain page coordinates. Hosts a BoxFrame for each selected boxed
// element and the editor slot (`data-editor-for`) of the element being edited. The layer itself
// lets pointer events through to the canvas; only its frames, handles and editors take them.
import { createElement, type CSSProperties } from "react";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { boxRect, contentMeta, isBoxed } from "../tools/spatialIndex";
import BoxFrame from "./BoxFrame";
import { boxStyle } from "./boxGeometry";
import { editorFor } from "./editorRegistry";

export default function OverlayLayer({ store }: { store: EditorStore }) {
  const camera = store((s) => s.camera);
  const elements = store((s) => s.elements);
  const selection = store((s) => s.selection);
  const editingId = store((s) => s.editingId);

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
          <div className="box-editor" data-editor-for={editing.id} style={boxStyle(boxRect(editing), contentMeta(editing).rotation ?? 0)}>
            {createElement(editorFor(editing.type), { el: editing, store })}
          </div>
        )}
        {framed.map((el) => (
          <BoxFrame key={el.id} el={el} store={store} zoom={camera.z} handles={selection.size === 1} />
        ))}
      </div>
    </div>
  );
}
