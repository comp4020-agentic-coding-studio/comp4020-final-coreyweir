import { useEffect, useRef, useState, type FormEvent } from "react";
import "./github-auth.css";
import {
  startGitHubDeviceAuthorization,
  verifyGitHubToken,
  waitForGitHubDeviceToken,
  type GitHubDeviceAuthorization,
  type GitHubUser,
} from "./githubAuth";
import { useGitHubSession } from "./GitHubSession";

type AuthState =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "verifying" }
  | { phase: "pending"; authorization: GitHubDeviceAuthorization; slowed: boolean }
  | { phase: "authenticated"; user: GitHubUser }
  | { phase: "error"; message: string };

export function GitHubAuthPoc({ roomGate = false }: { roomGate?: boolean }) {
  const [state, setState] = useState<AuthState>({ phase: "idle" });
  const [patOpen, setPatOpen] = useState(false);
  const [pat, setPat] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const { session, connect, disconnect } = useGitHubSession();

  useEffect(() => () => abortRef.current?.abort(), []);

  async function signIn() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: "starting" });

    try {
      const authorization = await startGitHubDeviceAuthorization(controller.signal);
      setState({ phase: "pending", authorization, slowed: false });
      const token = await waitForGitHubDeviceToken(
        authorization,
        controller.signal,
        () => setState((current) => current.phase === "pending" ? { ...current, slowed: true } : current),
      );
      const user = await verifyGitHubToken(token, controller.signal);
      connect({ token, user });
      setState({ phase: "authenticated", user });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ phase: "error", message: error instanceof Error ? error.message : "GitHub sign-in failed" });
    }
  }

  async function signInWithPat(event: FormEvent) {
    event.preventDefault();
    const token = pat.trim();
    if (!token) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: "verifying" });
    try {
      const user = await verifyGitHubToken(token, controller.signal);
      connect({ token, user });
      setPat("");
      setState({ phase: "authenticated", user });
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ phase: "error", message: error instanceof Error ? error.message : "GitHub token verification failed" });
    }
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    disconnect();
    setPat("");
    setPatOpen(false);
    setState({ phase: "idle" });
  }

  return (
    <main className="github-auth-poc">
      <header className="github-auth-header">
        <button className="brand brand-button" onClick={() => location.assign(location.pathname)}>riff</button>
          <span>{roomGate ? "Repository authentication" : "Authentication spike"}</span>
      </header>
      <section className="github-auth-layout">
        <article className="github-auth-intro">
          <span className="overline">{roomGate ? "Required for this workspace" : "Temporary development path"}</span>
          <h1>{roomGate ? "Connect the repository." : "Connect a GitHub session."}</h1>
          <p>{roomGate ? "The facilitator must sign in before Riff starts the browser workspace. Claude and Nodepod’s Git wrapper will receive the token for this session." : "This proves that Riff can obtain an OAuth token in the browser and use it with GitHub’s API. The token stays in this page’s memory and disappears on reload."}</p>
          <div className="github-auth-boundary">
            <strong>PoC boundary</strong>
            <p>Authorization currently identifies as GitHub CLI. The client identity and login transport are isolated so they can be replaced before student use.</p>
          </div>
        </article>

        <section className="github-auth-card" aria-live="polite">
          {(state.phase === "idle" || state.phase === "error") && !session && (
            <>
              <div className="github-auth-step">01 <span>Start</span></div>
              <h2>Sign in with GitHub</h2>
              <p>GitHub will give this browser a one-time code. No token is written to localStorage, sessionStorage, or the project filesystem.</p>
              {state.phase === "error" && <p className="github-auth-error">{state.message}</p>}
              <button className="primary" onClick={signIn}>Generate one-time code</button>
              <div className="github-auth-alternative"><span>or</span></div>
              {!patOpen ? <button className="github-auth-pat-toggle" onClick={() => setPatOpen(true)}>Provide GitHub PAT</button> : (
                <form className="github-auth-pat" onSubmit={signInWithPat}>
                  <label>Personal access token<input autoFocus type="password" required value={pat} onChange={(event) => setPat(event.target.value)} placeholder="github_pat_..." autoComplete="off" /></label>
                  <p>The token stays in memory and is forgotten when this page reloads.</p>
                  <div><button type="button" onClick={() => { setPat(""); setPatOpen(false); }}>Cancel</button><button className="primary" disabled={!pat.trim()}>Connect PAT</button></div>
                </form>
              )}
            </>
          )}

          {state.phase === "starting" && (
            <div className="github-auth-waiting">
              <span className="github-auth-spinner"></span>
              <h2>Contacting GitHub</h2>
              <p>Requesting a short-lived device code.</p>
            </div>
          )}

          {state.phase === "verifying" && (
            <div className="github-auth-waiting">
              <span className="github-auth-spinner"></span>
              <h2>Checking token</h2>
              <p>Verifying this PAT directly with GitHub.</p>
            </div>
          )}

          {state.phase === "pending" && (
            <>
              <div className="github-auth-step">02 <span>Authorize</span></div>
              <h2>Enter this one-time code</h2>
              <button className="github-auth-code" title="Copy code" onClick={() => navigator.clipboard.writeText(state.authorization.user_code)}>{state.authorization.user_code}</button>
              <p>Open GitHub’s device page, enter the code, and approve access. This page will continue automatically.</p>
              <a className="github-auth-open" href={state.authorization.verification_uri} target="_blank" rel="noreferrer">Open GitHub to continue</a>
              <div className="github-auth-polling"><span></span>{state.slowed ? "GitHub asked us to check less often" : "Waiting for approval"}</div>
              <button className="github-auth-cancel" onClick={reset}>Cancel</button>
            </>
          )}

          {(state.phase === "authenticated" || session) && (
            <>
              <div className="github-auth-step complete">03 <span>Connected</span></div>
              <div className="github-auth-user">
                <img src={session?.user.avatar_url ?? (state.phase === "authenticated" ? state.user.avatar_url : "")} alt="" />
                <div><small>Authenticated as</small><h2>{session?.user.name || session?.user.login || (state.phase === "authenticated" ? state.user.name || state.user.login : "")}</h2><a href={session?.user.html_url ?? (state.phase === "authenticated" ? state.user.html_url : "#")} target="_blank" rel="noreferrer">@{session?.user.login ?? (state.phase === "authenticated" ? state.user.login : "")}</a></div>
              </div>
              <p className="github-auth-success">{roomGate ? "Authentication complete. Opening the workspace..." : <>The OAuth token successfully authenticated a direct browser request to <code>api.github.com/user</code>.</>}</p>
              <button className="github-auth-cancel" onClick={reset}>Forget this session</button>
            </>
          )}
        </section>
      </section>
    </main>
  );
}
