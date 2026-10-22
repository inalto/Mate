import { useParams } from "react-router";
import CanvasView from "../canvas/CanvasView";
import MiniToolbar from "../components/MiniToolbar";

export default function Editor() {
  const { pageId } = useParams();
  if (!pageId) return null;
  return (
    <div className="editor">
      <CanvasView key={pageId} pageId={pageId} />
      <MiniToolbar />
    </div>
  );
}
