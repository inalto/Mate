import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { attachWindowPdfDrop } from "./canvas/dropPaste";
import { ToastHost } from "./components/Toast";
import { installPdfOpenHandler } from "./pdf/openFile";
import { router } from "./router";
import { setNavigator } from "./stores/navigation";

setNavigator((path) => void router.navigate(path));

export default function App() {
  // PDFs opened with Mate (file association) become pages, opened in the editor.
  useEffect(() => installPdfOpenHandler((id) => void router.navigate(`/edit/${id}`)), []);
  useEffect(() => attachWindowPdfDrop(), []);
  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
    </>
  );
}
