import { RouterProvider } from "react-router";
import { ToastHost } from "./components/Toast";
import { router } from "./router";

export default function App() {
  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
    </>
  );
}
