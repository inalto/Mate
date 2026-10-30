// DOM layer over one pane's canvas, in page units: the inner layer carries the camera transform, so
// children are positioned with plain page coordinates. Hosts a BoxFrame for each selected boxed
// element and the editor slot (`data-editor-for`) of the element being edited, when its type has
// an editor (an empty slot would sit over the element and swallow its input). The layer itself
// lets pointer events through to the canvas; only its frames, handles and editors take them.
// Also hosts the search flash (page units), the tutor card and the auto-complete arrows (screen
// space, beside the layer), and the auto-complete popover (beside the clip, like the line-ends one).
import { createElement, useCallback, type CSSProperties } from "react";
import AutoCompletePopover from "../components/AutoCompletePopover";
import FlashLayer from "../components/FlashLayer";
import { contentOf } from "../model/content";
import type { Element } from "../model/types";
import type { EditorStore } from "../stores/editor";
import { paneOfStore } from "../stores/tutor";
import TutorCard from "../tutor/TutorCard";
import { useTutorViews } from "../tutor/useTutor";
import { boxRect, contentMeta, isBoxed } from "../tools/spatialIndex";
import { isClosedShape } from "../shapes/geometry";
import AutoCompleteHandles from "./AutoCompleteHandles";
import BoxFrame from "./BoxFrame";
import { boxStyle } from "./boxGeometry";
import ShapeLabelEditor, { shapeBoxOf } from "./ShapeLabelEditor";
import { editorFor, NoEditor } from "./editorRegistry";

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
  const edited = editingId !== null ? elements.get(editingId) : undefined;
  const editor = edited ? editorFor(edited.type, contentOf<{ subtype?: string }>(edited).subtype) : NoEditor;
  const editing = editor !== NoEditor ? edited : undefined;
  // A closed shape's text is edited in place (shapes are not boxed): the slot is its own box.
  const shapeEditing = edited?.type === "shape" && isClosedShape(edited.shapeType ?? "rectangle") ? edited : undefined;

  const layerStyle = {
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`,
    transformOrigin: "0 0",
    "--overlay-inv-z": String(1 / camera.z),
  } as CSSProperties;

  return (
    <>
      <div className="overlay-clip">
        <div className="overlay-layer" data-testid="overlay-layer" style={layerStyle}>
          {editing && (
            <div className="box-editor" data-editor-for={editing.id} data-editor-type={editing.type} style={boxStyle(boxRect(editing), contentMeta(editing).rotation ?? 0)}>
              {createElement(editor, { el: editing, store })}
            </div>
          )}
          {shapeEditing && (
            <div className="box-editor" data-editor-for={shapeEditing.id} data-editor-type="shape" style={{ ...boxStyle(shapeBoxOf(shapeEditing), 0), transform: undefined }}>
              <ShapeLabelEditor el={shapeEditing} store={store} />
            </div>
          )}
          {framed.map((el) => (
            <BoxFrame key={el.id} el={el} store={store} zoom={camera.z} handles={selection.size === 1} />
          ))}
          {pageId && <FlashLayer pageId={pageId} zoom={camera.z} boundsOf={boundsOf} />}
        </div>
        <AutoCompleteHandles store={store} />
        <TutorCard store={store} pane={pane} />
      </div>
      <AutoCompletePopover store={store} />
    </>
  );
}
