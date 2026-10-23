import type { EditorStore } from "../stores/editor";
import { useTutor, type PaneIndex } from "./useTutor";

/** Mounts the live tutor for one pane. Renders nothing; the overlay reads `useTutorViews`. */
export default function TutorController({ store, pane }: { store: EditorStore; pane: PaneIndex }) {
  useTutor(store, pane);
  return null;
}
