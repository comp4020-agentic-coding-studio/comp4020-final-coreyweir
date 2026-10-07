import { createRoot } from "react-dom/client";
import "@quickdrawjs/core/quickdraw.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./preview.css";
import App from "./App";
import { GitHubSessionProvider } from "./GitHubSession";

createRoot(document.querySelector("#root")!).render(<GitHubSessionProvider><App /></GitHubSessionProvider>);
