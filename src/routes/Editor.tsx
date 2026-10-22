import { useParams } from "react-router";

/** Placeholder: the canvas editor arrives in a later task. */
export default function Editor() {
  const { pageId } = useParams();
  return (
    <div className="screen">
      <h1>Editor</h1>
      <p className="muted">Page {pageId}</p>
    </div>
  );
}
