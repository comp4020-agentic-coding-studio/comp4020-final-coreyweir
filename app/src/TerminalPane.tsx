import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ClaudePodController, HostConfig } from "./claudePod";
import { useTerminalChannel, type TerminalEvent } from "./terminalChannel";
import { usePreviewHostChannel } from "./previewChannel";
import "./terminal-stream.css";

export type TerminalPaneHandle = { loadPrompt: (prompt: string) => boolean };

function ParticipantTerminal({ subscribe }: { subscribe: (listener: (event: TerminalEvent) => void) => () => void }) {
  const targetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!targetRef.current) return;
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.1,
      theme: { background: "#171816", foreground: "#e7e8df", cursor: "#171816" },
    });
    terminal.open(targetRef.current);
    let sequence = 0;
    let desynchronized = false;
    let dataEvents = 0;
    let checkpointRenders = 0;
    const unsubscribe = subscribe((event) => {
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
      }
    });
    return () => {
      unsubscribe();
      terminal.dispose();
    };
  }, [subscribe]);

  return <div className="terminal-target readonly-terminal" data-sequence="0" data-data-events="0" data-checkpoint-renders="0" ref={targetRef} />;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, {
  roomId: string;
  facilitator: boolean;
  config: HostConfig | null;
  onPreviewUrlChange: (url: string | null, generation: number) => void;
}>(function TerminalPane({ roomId, facilitator, config, onPreviewUrlChange }, ref) {
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
  const channel = useTerminalChannel(roomId, facilitator);
  const publishPreview = usePreviewHostChannel(roomId, facilitator, controllerRef);

  previewChangeRef.current = onPreviewUrlChange;

  useImperativeHandle(ref, () => ({
    loadPrompt(prompt) {
      const loaded = controllerRef.current?.loadPrompt(prompt) === true;
      if (!loaded) setError("Start Claude before loading a queued prompt.");
      else setError(null);
      return loaded;
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
          config,
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
              channel.publishData(pending, cols, rows);
            }, 16);
          },
        );
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
        {facilitator && <div className="terminal-controls"><button disabled={starting || controllerRef.current?.isRunning()} onClick={() => start("claude")}>{starting ? "Starting..." : controllerRef.current ? "Start Claude" : "Boot Claude"}</button><button disabled={starting || controllerRef.current?.isRunning()} onClick={() => start("bash")}>Start Bash</button><button disabled={!controllerRef.current?.isRunning()} onClick={() => controllerRef.current?.interrupt()}>Interrupt</button></div>}
      </header>
      {facilitator ? <div className="terminal-target" data-output-size={outputSize} ref={targetRef} /> : <ParticipantTerminal subscribe={channel.subscribe} />}
      <footer className="terminal-note">
        <span>{facilitator ? "Terminal output is shared with everyone in this room. Only you can type or approve actions." : "Read-only mirror. The facilitator controls input and permissions."}</span>
        {(error || channel.error) && <strong>{error ?? channel.error}</strong>}
      </footer>
    </article>
  );
});
