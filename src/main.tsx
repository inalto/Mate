import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import App from "./App.tsx";
import { initRecovery, installCloseHandler } from "./lifecycle/close";

initRecovery();
installCloseHandler();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
