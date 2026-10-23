import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { attachWindowPdfDrop } from "./canvas/dropPaste";
import { ToastHost } from "./components/Toast";
import { StartupUpdateCheck } from "./components/UpdateSection";
import { isPageWindow } from "./ipc/windows";
import { installImportOpenHandler } from "./stores/importStore";
import { installPdfOpenHandler } from "./pdf/openFile";
import { markFileLaunch } from "./onboarding/fileLaunch";
import LaunchChecks from "./onboarding/LaunchChecks";
import { router } from "./router";
import { setNavigator } from "./stores/navigation";

setNavigator((path) => void router.navigate(path));

export default function App() {
  // PDFs opened with Mate (file association) become pages, opened in the editor.
  // Only the main window handles them: the events reach every window, page windows included.
  useEffect(() => (isPageWindow() ? undefined : installPdfOpenHandler((id) => { markFileLaunch(); void router.navigate(`/edit/${id}`); })), []);
  useEffect(() => attachWindowPdfDrop(), []);
  // Notebook files opened with Mate (file association) open the import dialog.
  useEffect(() => (isPageWindow() ? undefined : installImportOpenHandler()), []);
  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
      {!isPageWindow() && <LaunchChecks />}
      {!isPageWindow() && <StartupUpdateCheck />}
    </>
  );
}
