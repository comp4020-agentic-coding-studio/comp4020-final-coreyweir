/*
 * Who the host's WASIX Bash is.
 *
 * The guest always runs as uid 0 / gid 0 (WASIX has no users) with an empty
 * /etc, so bash's prompt said "I have no name!" and `whoami` failed. libc
 * reads /etc/passwd and /etc/group, but the session can't put them there
 * once: every run gets a fresh in-memory root whose /etc the runtime creates
 * itself (virtual-fs RootFileSystemBuilder), and a mount over a directory
 * that exists fails, so /etc can't be shared like /home and /tmp. Instead
 * each bash writes them as it starts: BASH_ENV for `bash -c` (Claude's Bash
 * tool, scripts), the rc for the terminal. Children of that bash share its
 * root, so they see them too.
 */

export const SESSION_USER = "user";
export const SESSION_HOME = "/home/user";
export const SESSION_HOSTNAME = "riff";

/** Control-directory file BASH_ENV names (installSessionFile). */
export const SESSION_ENV_FILE = "bash_env";

const ETC_FILES: ReadonlyArray<[string, string]> = [
  ["passwd", `${SESSION_USER}:x:0:0:Riff host:${SESSION_HOME}:/bin/bash`],
  ["group", `${SESSION_USER}:x:0:`],
  ["hostname", SESSION_HOSTNAME],
];

/**
 * The BASH_ENV script. Only writes what's missing, so a nested bash costs one
 * test, and never fails the shell that sources it.
 */
export function sessionEnvScript(): Uint8Array {
  const lines = [
    "# Riff: this run's /etc (sessionSystem.ts).",
    ...ETC_FILES.map(([name, line]) => `[ -e /etc/${name} ] || printf '%s\\n' '${line}' 2>/dev/null >/etc/${name}`),
    "",
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

const HOSTNAME = `#!/bin/bash
# Riff: the session's name, from /etc/hostname. Options only choose a form of
# the name; anything else would set it, which the session can't.
for arg in "$@"; do
  case $arg in
    -*) ;;
    *) echo "hostname: the name can't be changed in Riff's terminal" >&2; exit 1 ;;
  esac
done
cat /etc/hostname
`;

/** Scripts for the session's bin directory (installBinaries). */
export function sessionHelperCommands(): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map([
    ["hostname", encoder.encode(HOSTNAME)],
  ]);
}
