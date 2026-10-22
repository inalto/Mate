import { useEffect } from "react";
import { useParams } from "react-router";
import CanvasView from "../canvas/CanvasView";
import SelectionBar from "../components/SelectionBar";
import Toolbar from "../components/Toolbar";
import { runEditorShortcut } from "../keys/editorCommands";
import { bindShortcuts, DEFAULT_SHORTCUTS } from "../keys/shortcuts";

export default function Editor() {
  const { pageId } = useParams();
  useEffect(() => bindShortcuts(DEFAULT_SHORTCUTS, runEditorShortcut), []);
  if (!pageId) return null;
  return (
    <div className="editor">
      <CanvasView key={pageId} pageId={pageId} />
      <SelectionBar />
      <Toolbar />
    </div>
  );
}
