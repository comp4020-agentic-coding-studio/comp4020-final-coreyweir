import { createRoot } from "react-dom/client";
import "@quickdrawjs/core/quickdraw.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./preview.css";
import "./landing.css";
import "./copy-view.css";
import App from "./App";
// after App, so it comes after the terminal's own sheet
import "./room-type.css";
import { takePushFromLocation } from "./api";

// Back from a push sign-in, before anything reads the URL.
takePushFromLocation();

createRoot(document.querySelector("#root")!).render(<App />);
