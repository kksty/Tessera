import { createRoot } from "react-dom/client";
import { AppRoot } from "./AppRoot.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/pages.css";
import "./styles/legacy.css";
import "./styles/board.css";
import "./styles/page-assets.css";
import "./styles/page-evidence.css";
import "./styles/page-files.css";
import "./styles/page-review.css";
import "./styles/page-settings.css";
import "./styles/page-tasks.css";
import "./styles/page-timeline.css";
import "./styles/page-traffic.css";

try {
  const theme = localStorage.getItem("tessera.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch { /* The login screen also works when browser storage is unavailable. */ }

createRoot(document.getElementById("root")!).render(<ErrorBoundary><AppRoot /></ErrorBoundary>);
