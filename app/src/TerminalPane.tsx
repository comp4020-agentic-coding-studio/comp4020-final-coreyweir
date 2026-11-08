import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { WorkspaceExport } from "./WorkspaceExport";
import { forgetPushToken, onPushTokenStored, unwrapPushToken } from "./api";
import { checkGitHubToken, throttled } from "./githubCheck";
import { Terminal } from "@xterm/xterm";
import type { ClaudePodController, HostConfig } from "./claudePod";
import type { ClaudeEvent } from "./queueRelease";
import { useTerminalChannel, type TerminalChannelEvent } from "./terminalChannel";
import { usePreviewHostChannel } from "./previewChannel";
import { ACTUAL_FONT_SIZE, fitMirror, type MirrorMode } from "./mirrorFit";
import { TERMINAL_THEME } from "./terminalTheme";
import { takeAutoBoot } from "./autoBoot";
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

// What a refusal (401) means depends on the token. An OAuth app's token
// never expires (Riff's app doesn't opt in to expiring tokens), so a refused
// one was revoked; a pasted personal token can also reach its expiry date.
// docs/adr/0005, "Why a push token stops working".
export function githubRefusalText(token: string | undefined) {
  return token?.startsWith("gho_")
    ? "GitHub has revoked the token Riff connected for you, so git can't reach GitHub."
    : "GitHub no longer accepts the token you pasted (it expired or was revoked), so git can't reach GitHub.";
}

export const TerminalPane = forwardRef<TerminalPaneHandle, {
  roomId: string;
  token: string | null;
  facilitator: boolean;
  config: HostConfig | null;
  onPreviewUrlChange: (url: string | null, generation: number) => void;
  /** What Claude is doing, from its hooks (docs/adr/0004). Host only. */
  onClaudeEvent?: (event: ClaudeEvent) => void;
  /** The room has ended: nothing will appear, so don't say "waiting". */
  ended?: boolean;
  /** Host: what booting is doing, or null when it isn't, for the other tabs. */
  onBootStatus?: (status: string | null) => void;
}>(function TerminalPane({ roomId, token, facilitator, config, onPreviewUrlChange, onClaudeEvent, ended = false, onBootStatus }, ref) {
  const targetRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ClaudePodController | null>(null);
  const previewChangeRef = useRef(onPreviewUrlChange);
  const lastSnapshotRef = useRef("");
  const lastCheckpointAtRef = useRef(0);
  const pendingOutputRef = useRef("");
  const outputTimerRef = useRef(0);
  const [status, setStatus] = useState(facilitator ? "Not started" : "Waiting for host");
  const [starting, setStarting] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [outputSize, setOutputSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // GitHub refused the host's token; connecting again in another tab swaps
  // the new one into the running pod (no reload, Claude keeps running).
  // The refused token, so the banner can say what kind it was.
  const [githubRefused, setGithubRefused] = useState<string | null>(null);
  // The token the pod is using now (a reconnect replaces it).
  const githubTokenRef = useRef(config?.githubToken);
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

  // A room this tab has just created boots Claude by itself (autoBoot.ts).
  // The terminal is mounted, hidden, from the start, so this runs while the
  // host is still on the Board.
  useEffect(() => {
    if (!facilitator || !config || controllerRef.current || !takeAutoBoot(roomId)) return;
    void start("claude");
    // start is this render's; the mark is taken once
  }, [facilitator, config, roomId]);

  const bootStatusRef = useRef(onBootStatus);
  bootStatusRef.current = onBootStatus;
  useEffect(() => {
    if (facilitator) bootStatusRef.current?.(starting ? status : null);
  }, [facilitator, starting, status]);

  // While hosting with GitHub, ask GitHub whether it still takes the token:
  // when the host comes back to the tab (at most every 5 minutes) and every
  // 30 minutes, so a revoked token shows here before git fails on it.
  useEffect(() => {
    if (!facilitator || !attached || githubRefused !== null) return;
    let active = true;
    const check = throttled(() => {
      const token = githubTokenRef.current;
      if (!token) return;
      void checkGitHubToken(token).then((state) => {
        if (!active || state !== "refused" || token !== githubTokenRef.current) return;
        forgetPushToken();
        setGithubRefused(token);
      });
    }, 5 * 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(check, 30 * 60_000);
    return () => {
      active = false;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [facilitator, attached, githubRefused]);

  useEffect(() => {
    if (githubRefused === null) return;
    return onPushTokenStored(() => {
      void (async () => {
        const token = await unwrapPushToken();
        const controller = controllerRef.current;
        if (!token || !controller) return;
        const swapped = await controller.replaceGitHubToken(token);
        if (swapped) githubTokenRef.current = token;
        setGithubRefused(null);
        setError(swapped
          ? "GitHub connected again: git uses the new token from now on, nothing restarted."
          : "GitHub connected again. Boot Claude again to give it the new token.");
      })().catch((failure) => setError(`GitHub connected, but Riff couldn't open the token: ${String(failure)}`));
    });
  }, [githubRefused]);

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
          // Bridge and bash diagnostics ("[bridge] pid=2 node -e ...") are
          // for debugging, not the room: they go to the console and a data
          // attribute, and the header keeps saying what state it's in.
          (next) => {
            if (/^\[(bridge|bash)\] /.test(next) && !/failed/.test(next)) {
              console.info(next);
              setReport(next);
            } else setStatus(next);
          },
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
          (kind) => {
            if (kind === "github") {
              // GitHub said the stored token is dead: drop it, so connecting
              // again starts from nothing and the next boot doesn't reuse it.
              forgetPushToken();
              setError(null);
              setGithubRefused(githubTokenRef.current ?? "");
            } else setError("Your model endpoint refused your token (expired or revoked). Check it in host setup.");
          },
        );
        controller.onClaudeEvent = (event) => claudeEventRef.current?.(event);
        controller.onNotice = setError;
        controllerRef.current = controller;
        await controller.boot();
        controller.attach(targetRef.current);
        setAttached(true);
      }
      lastCheckpointAtRef.current = Date.now();
      if (mode === "claude") await controller.startClaude();
      else await controller.startWasixBash();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("Could not start");
      await controllerRef.current?.dispose();
      controllerRef.current = null;
      setAttached(false);
    } finally {
      setStarting(false);
    }
  }

  const participantLive = channel.snapshot !== null || channel.hasData;
  const participantStatus = participantLive ? "Host terminal live" : ended ? "Room ended" : channel.hostConnected ? "Host connected" : "Waiting for host";
  // The relay's refusal of an ended room is the banner's news, not an error.
  const channelError = channel.error === "room-ended" ? null : channel.error;
  return (
    <article className="terminal-pane">
      <header className="section-title terminal-heading" data-report={report ?? undefined}>
        <div><h2>Workspace</h2><span className={facilitator && (status === "Claude running" || status === "WASIX Bash ready") || !facilitator && participantLive ? "live-dot" : "idle-dot"}>{facilitator ? status : participantStatus}</span></div>
        {facilitator && <div className="terminal-controls"><button disabled={starting || controllerRef.current?.isRunning()} onClick={() => start("claude")}>{starting ? "Starting..." : controllerRef.current ? "Start Claude" : "Boot Claude"}</button><button disabled={starting || controllerRef.current?.isRunning()} onClick={() => start("bash")}>Start Bash</button><button disabled={!controllerRef.current?.isRunning()} onClick={() => controllerRef.current?.interrupt()}>Interrupt</button><WorkspaceExport getController={() => controllerRef.current} ready={attached} /></div>}
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
      <div className="terminal-stage">
        {facilitator ? <div className="terminal-target" data-output-size={outputSize} ref={targetRef} /> : <ParticipantTerminal subscribe={channel.subscribe} mode={mirrorMode} />}
        {/* Until there's a screen, say what's happening where people look. */}
        {(facilitator ? !attached : !participantLive) && (
          <p className="terminal-empty" role="status">
            {facilitator
              ? starting ? status : "Boot Claude to start Claude Code in this tab. Everyone in the room sees this terminal."
              : ended ? "This room has ended, so there's no terminal to watch." : channel.hostConnected ? "Nothing on the host's terminal yet. It appears here when they start Claude." : "Waiting for the host. Their terminal appears here."}
          </p>
        )}
      </div>
      <footer className="terminal-note">
        <span>{facilitator ? "Terminal output is shared with everyone in this room. Only you can type or approve actions." : "Read-only mirror of the host's terminal. Only the host types or approves actions."}</span>
        {githubRefused !== null && (
          <strong>
            {githubRefusalText(githubRefused)}{" "}
            <a href="/?github=reconnect" target="_blank" rel="noopener">Connect GitHub again</a> in a new tab: Claude keeps running here and git picks the new token up.
          </strong>
        )}
        {(error || channelError) && <strong>{error ?? channelError}</strong>}
      </footer>
    </article>
  );
});
