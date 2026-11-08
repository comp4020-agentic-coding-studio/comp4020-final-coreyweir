import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { WorkspaceExport } from "./WorkspaceExport";
import { Terminal } from "@xterm/xterm";
import type { ClaudePodController, HostConfig } from "./claudePod";
import type { ClaudeEvent } from "./queueRelease";
import { useTerminalChannel, type TerminalChannelEvent } from "./terminalChannel";
import { usePreviewHostChannel } from "./previewChannel";
import { ACTUAL_FONT_SIZE, fitMirror, type MirrorMode } from "./mirrorFit";
import { TERMINAL_THEME } from "./terminalTheme";
import "./terminal-stream.css";

export type TerminalPaneHandle = { sendPrompt: (prompt: string) => boolean };

const MIRROR_MODE_KEY = "riff-mirror-mode";

function savedMirrorMode(): MirrorMode {
  try {
    return localStorage.getItem(MIRROR_MODE_KEY) === "actual" ? "actual" : "fit";
  } catch {
    return "fit";
  }
}

// The mirror takes the host's columns and rows from every event, never its
// own box's, so Claude's output lays out exactly as on the host's screen.
// Only the font size follows the box (src/mirrorFit.ts).
function ParticipantTerminal({ subscribe, mode }: { subscribe: (listener: (event: TerminalChannelEvent) => void) => () => void; mode: MirrorMode }) {
  const targetRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  const refitRef = useRef<() => void>(() => undefined);
  modeRef.current = mode;

  useEffect(() => {
    refitRef.current();
  }, [mode]);

  useEffect(() => {
    const box = targetRef.current;
    if (!box) return;
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: ACTUAL_FONT_SIZE,
      lineHeight: 1.1,
      // the mirror takes no input, so its cursor is drawn in the background
      theme: { ...TERMINAL_THEME, cursor: TERMINAL_THEME.background },
    });
    terminal.open(box);
    let frame = 0;
    const refit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitMirror(terminal, box, modeRef.current));
    };
    refitRef.current = refit;
    const observer = new ResizeObserver(refit);
    observer.observe(box);
    const resized = terminal.onResize(refit);
    void document.fonts?.ready.then(refit);
    let sequence = 0;
    let desynchronized = false;
    let dataEvents = 0;
    let checkpointRenders = 0;
    const unsubscribe = subscribe((event) => {
      if (event.type === "connected") {
        // A new connection numbers from 1 again; the next snapshot redraws.
        sequence = 0;
        desynchronized = false;
        return;
      }
      if (event.sequence <= sequence) return;
      const continuous = event.sequence === sequence + 1;
      if (event.type === "snapshot") {
        if (terminal.cols !== event.cols || terminal.rows !== event.rows) terminal.resize(event.cols, event.rows);
        if (sequence === 0 || desynchronized || !continuous) {
          terminal.reset();
          terminal.write(event.ansi);
          checkpointRenders += 1;
        }
        desynchronized = false;
      } else if (!desynchronized && (sequence === 0 && event.sequence === 1 || continuous)) {
        if (terminal.cols !== event.cols || terminal.rows !== event.rows) terminal.resize(event.cols, event.rows);
        terminal.write(event.data);
        dataEvents += 1;
      } else {
        desynchronized = true;
      }
      sequence = event.sequence;
      if (targetRef.current) {
        targetRef.current.dataset.sequence = String(sequence);
        targetRef.current.dataset.dataEvents = String(dataEvents);
        targetRef.current.dataset.checkpointRenders = String(checkpointRenders);
        targetRef.current.dataset.cols = String(terminal.cols);
        targetRef.current.dataset.rows = String(terminal.rows);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      refitRef.current = () => undefined;
      observer.disconnect();
      resized.dispose();
      unsubscribe();
      terminal.dispose();
    };
  }, [subscribe]);

  return <div className={`terminal-target readonly-terminal mirror-${mode}`} data-mode={mode} data-sequence="0" data-data-events="0" data-checkpoint-renders="0" ref={targetRef} />;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, {
  roomId: string;
  token: string | null;
  facilitator: boolean;
  config: HostConfig | null;
  onPreviewUrlChange: (url: string | null, generation: number) => void;
  /** What Claude is doing, from its hooks (docs/adr/0004). Host only. */
  onClaudeEvent?: (event: ClaudeEvent) => void;
}>(function TerminalPane({ roomId, token, facilitator, config, onPreviewUrlChange, onClaudeEvent }, ref) {
  const targetRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ClaudePodController | null>(null);
  const previewChangeRef = useRef(onPreviewUrlChange);
  const lastSnapshotRef = useRef("");
  const lastCheckpointAtRef = useRef(0);
  const pendingOutputRef = useRef("");
  const outputTimerRef = useRef(0);
  const [status, setStatus] = useState(facilitator ? "Not started" : "Waiting for host");
  const [starting, setStarting] = useState(false);
  const [outputSize, setOutputSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [mirrorMode, setMirrorMode] = useState<MirrorMode>(savedMirrorMode);
  const channel = useTerminalChannel(roomId, token, facilitator);
  const publishPreview = usePreviewHostChannel(roomId, token, facilitator, controllerRef);

  previewChangeRef.current = onPreviewUrlChange;
  const claudeEventRef = useRef(onClaudeEvent);
  claudeEventRef.current = onClaudeEvent;

  useImperativeHandle(ref, () => ({
    sendPrompt(prompt) {
      const sent = controllerRef.current?.sendPrompt(prompt) === true;
      if (!sent) setError("Start Claude before sending a queued prompt.");
      else setError(null);
      return sent;
    },
  }), []);

  useEffect(() => () => {
    clearTimeout(outputTimerRef.current);
    controllerRef.current?.dispose();
    controllerRef.current = null;
  }, []);

  useEffect(() => {
    if (facilitator) previewChangeRef.current(null, publishPreview(false));
  }, [facilitator, publishPreview]);

  // The relay accepted this page as host, maybe after a restart that lost
  // its snapshot: forget what was last sent, so the next tick sends one even
  // if the screen hasn't changed since.
  useEffect(() => {
    lastSnapshotRef.current = "";
    lastCheckpointAtRef.current = 0;
  }, [channel.hostAccepted]);

  useEffect(() => {
    if (!facilitator) return;
    const timer = window.setInterval(() => {
      const controller = controllerRef.current;
      if (!controller) return;
      if (status === "Claude running" && !controller.isRunning()) setStatus("Terminal ready");
      const now = Date.now();
      if (now - lastCheckpointAtRef.current < 3000) return;
      lastCheckpointAtRef.current = now;
      const snapshot = controller.snapshot();
      if (!snapshot?.ansi) return;
      const snapshotKey = `${snapshot.cols}x${snapshot.rows}\n${snapshot.ansi}`;
      if (snapshotKey === lastSnapshotRef.current) return;
      lastSnapshotRef.current = snapshotKey;
      channel.publish(snapshot);
    }, 500);
    return () => clearInterval(timer);
  }, [channel.publish, facilitator, status]);

  async function start(mode: "claude" | "bash") {
    if (!config || !targetRef.current) return;
    setStarting(true);
    setError(null);
    try {
      let controller = controllerRef.current;
      if (!controller) {
        const { ClaudePodController } = await import("./claudePod");
        controller = new ClaudePodController(
          { ...config, workspaceRoom: roomId },
          setStatus,
          (url) => previewChangeRef.current(url, publishPreview(Boolean(url))),
          (data) => {
            pendingOutputRef.current += data;
            if (outputTimerRef.current) return;
            outputTimerRef.current = window.setTimeout(() => {
              const pending = pendingOutputRef.current;
              pendingOutputRef.current = "";
              outputTimerRef.current = 0;
              setOutputSize((size) => size + pending.length);
              const { cols, rows } = controllerRef.current?.dimensions() ?? { cols: 80, rows: 24 };
              if (targetRef.current) Object.assign(targetRef.current.dataset, { cols: String(cols), rows: String(rows) });
              channel.publishData(pending, cols, rows);
            }, 16);
          },
        );
        controller.onClaudeEvent = (event) => claudeEventRef.current?.(event);
        controller.onNotice = setError;
        controllerRef.current = controller;
        await controller.boot();
        controller.attach(targetRef.current);
      }
      lastCheckpointAtRef.current = Date.now();
      if (mode === "claude") await controller.startClaude();
      else await controller.startWasixBash();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("Could not start");
      await controllerRef.current?.dispose();
      controllerRef.current = null;
    } finally {
      setStarting(false);
    }
  }

  const participantLive = channel.snapshot !== null || channel.hasData;
  const participantStatus = participantLive ? "Host terminal live" : channel.hostConnected ? "Host connected" : "Waiting for host";
  return (
    <article className="terminal-pane">
      <header className="section-title terminal-heading">
        <div><h2>Workspace</h2><span className={facilitator && (status === "Claude running" || status === "WASIX Bash ready") || !facilitator && participantLive ? "live-dot" : "idle-dot"}>{facilitator ? status : participantStatus}</span></div>
        {facilitator && <div className="terminal-controls"><button disabled={starting || controllerRef.current?.isRunning()} onClick={() => start("claude")}>{starting ? "Starting..." : controllerRef.current ? "Start Claude" : "Boot Claude"}</button><button disabled={starting || controllerRef.current?.isRunning()} onClick={() => start("bash")}>Start Bash</button><button disabled={!controllerRef.current?.isRunning()} onClick={() => controllerRef.current?.interrupt()}>Interrupt</button><WorkspaceExport getController={() => controllerRef.current} /></div>}
        {!facilitator && <div className="terminal-controls"><button className="mirror-mode" aria-pressed={mirrorMode === "actual"} title={mirrorMode === "fit" ? "Show the host's terminal at its own text size, and scroll" : "Shrink or grow the host's terminal to fit this box"} onClick={() => {
          const next = mirrorMode === "fit" ? "actual" : "fit";
          setMirrorMode(next);
          try {
            localStorage.setItem(MIRROR_MODE_KEY, next);
          } catch {
            // A preference that isn't remembered is still applied.
          }
        }}>{mirrorMode === "fit" ? "Actual size" : "Fit to box"}</button></div>}
      </header>
      {facilitator ? <div className="terminal-target" data-output-size={outputSize} ref={targetRef} /> : <ParticipantTerminal subscribe={channel.subscribe} mode={mirrorMode} />}
      <footer className="terminal-note">
        <span>{facilitator ? "Terminal output is shared with everyone in this room. Only you can type or approve actions." : "Read-only mirror of the host's terminal. Only the host types or approves actions."}</span>
        {(error || channel.error) && <strong>{error ?? channel.error}</strong>}
      </footer>
    </article>
  );
});
