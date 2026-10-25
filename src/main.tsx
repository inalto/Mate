import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "katex/dist/katex.min.css";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/palette-graph.css";
import "./i18n";
import App from "./App.tsx";
import { initRecovery, installCloseHandler } from "./lifecycle/close";
import { watchSaveFailures } from "./lifecycle/saveStatus";
import { loadPlatform } from "./platform";

await loadPlatform();
initRecovery();
installCloseHandler();
watchSaveFailures();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
