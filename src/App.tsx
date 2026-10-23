import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { attachWindowPdfDrop } from "./canvas/dropPaste";
import { ToastHost } from "./components/Toast";
import { installFlushOnly } from "./lifecycle/flushOnly";
import { installCrossWindowSync } from "./lifecycle/crossWindow";
import { StartupUpdateCheck } from "./components/UpdateSection";
import { currentWindowLabel, isPageWindow } from "./ipc/windows";
import { installImportOpenHandler } from "./stores/importStore";
import { installPdfOpenHandler } from "./pdf/openFile";
import { markFileLaunch } from "./onboarding/fileLaunch";
import LaunchChecks from "./onboarding/LaunchChecks";
import { router } from "./router";
import ResetNotice from "./routes/Settings/ResetNotice";
import { setNavigator } from "./stores/navigation";
import { startSettingsSync } from "./stores/settings";

setNavigator((path) => void router.navigate(path));

export default function App() {
  // PDFs opened with Mate (file association) become pages, opened in the editor.
  // Only the main window handles them: the events reach every window, page windows included.
  useEffect(() => (isPageWindow() ? undefined : installPdfOpenHandler((id) => { markFileLaunch(); void router.navigate(`/edit/${id}`); })), []);
  // PDFs dropped outside the canvas import as new pages: the main window's job only.
  useEffect(() => (isPageWindow() ? undefined : attachWindowPdfDrop()), []);
  // Every window can be asked to flush before an update is installed.
  useEffect(() => installFlushOnly(), []);
  // Notebook changes made in other windows (main and page windows) reach this one.
  useEffect(() => installCrossWindowSync(), []);
  // Settings written by other windows (theme, key bindings, haptics...) reach this one.
  useEffect(() => startSettingsSync(currentWindowLabel()), []);
  // Notebook files opened with Mate (file association) open the import dialog.
  useEffect(() => (isPageWindow() ? undefined : installImportOpenHandler()), []);
  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
      {!isPageWindow() && <LaunchChecks />}
      {!isPageWindow() && <StartupUpdateCheck />}
      {!isPageWindow() && <ResetNotice />}
    </>
  );
}
