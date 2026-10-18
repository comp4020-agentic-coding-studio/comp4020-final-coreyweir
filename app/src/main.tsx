import { createRoot } from "react-dom/client";
import "@quickdrawjs/core/quickdraw.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./preview.css";
import App from "./App";
import { takePushFromLocation } from "./api";

// Back from a push sign-in, before anything reads the URL.
takePushFromLocation();

createRoot(document.querySelector("#root")!).render(<App />);
