import { createBrowserRouter } from "react-router";
import Shell from "./components/Shell";
import Editor from "./routes/Editor";
import Home from "./routes/Home";
import Library from "./routes/Library";
import Settings from "./routes/Settings";
import Trash from "./routes/Trash";

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/library", element: <Library /> },
      { path: "/trash", element: <Trash /> },
      { path: "/settings", element: <Settings /> },
      { path: "/edit/:pageId", element: <Editor /> },
    ],
  },
]);
