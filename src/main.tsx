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

await loadPlatform();
initRecovery();
installCloseHandler();
installFlushOnHide();
watchSaveFailures();
installZoomGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
