import { createBrowserRouter } from "react-router";
import Shell from "./components/Shell";
import Editor from "./routes/Editor";
import Home from "./routes/Home";
import Library from "./routes/Library";
import Recall from "./routes/Recall";
import Settings from "./routes/Settings";
import Trash from "./routes/Trash";
import Welcome from "./routes/Welcome";

export const router = createBrowserRouter([
  { path: "/welcome", element: <Welcome /> },
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/library", element: <Library /> },
      { path: "/recall/:unitId", element: <Recall /> },
      { path: "/trash", element: <Trash /> },
      { path: "/graph", lazy: async () => ({ Component: (await import("./routes/Graph")).default }) },
      { path: "/settings", element: <Settings /> },
      { path: "/edit/:pageId", element: <Editor /> },
    ],
  },
]);
