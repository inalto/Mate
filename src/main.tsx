import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/palette-graph.css";
import "./i18n";
import App from "./App.tsx";
import { initRecovery, installCloseHandler, installFlushOnHide } from "./lifecycle/close";
import { watchSaveFailures } from "./lifecycle/saveStatus";
import { installZoomGuard } from "./lifecycle/zoomGuard";
import { loadPlatform } from "./platform";
import { recoverRecordings } from "./recording/session";
import { useNotebookStore } from "./stores/notebook";

await loadPlatform();
initRecovery();
installCloseHandler();
installFlushOnHide();
watchSaveFailures();
installZoomGuard();
// Recordings a crash left behind are salvaged once, when the tree (the pages their markers go on) is loaded.
const offTree = useNotebookStore.subscribe((s) => {
  if (!s.loaded) return;
  offTree();
  void recoverRecordings();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
