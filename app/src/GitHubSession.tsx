import { createContext, useContext, useState, type ReactNode } from "react";
import type { GitHubUser } from "./githubAuth";

export type GitHubSession = {
  token: string;
  user: GitHubUser;
};

type GitHubSessionContextValue = {
  session: GitHubSession | null;
  connect: (session: GitHubSession) => void;
  disconnect: () => void;
};

const GitHubSessionContext = createContext<GitHubSessionContextValue | null>(null);

export function GitHubSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<GitHubSession | null>(null);
  return (
    <GitHubSessionContext value={{ session, connect: setSession, disconnect: () => setSession(null) }}>
      {children}
    </GitHubSessionContext>
  );
}

export function useGitHubSession() {
  const context = useContext(GitHubSessionContext);
  if (!context) throw new Error("useGitHubSession must be used inside GitHubSessionProvider");
  return context;
}
