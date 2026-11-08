/*
 * Who the host's WASIX Bash is, and the small commands a first-time user
 * reaches for that the session's tool packages don't have.
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

/**
 * The terminal, for readline. The session has no terminfo or termcap files,
 * so bash's readline treated xterm as a dumb terminal: no cursor-up, so a
 * command longer than a line scrolled sideways ("<" and a cut-off line)
 * instead of wrapping. Bash links GNU termcap, which takes an entry inline
 * from TERMCAP when its name matches TERM. `infocmp -C xterm-256color`
 * (ncurses 6.6), with empty fields dropped.
 */
export const XTERM_TERMCAP = String.raw`xterm-256color|xterm with 256 colors:am:bs:km:mi:ms:xn:co#80:it#8:li#24:AL=\E[%dL:DC=\E[%dP:DL=\E[%dM:DO=\E[%dB:IC=\E[%d@:K1=\EOw:K2=\EOu:K3=\EOy:K4=\EOq:K5=\EOs:LE=\E[%dD:RI=\E[%dC:SF=\E[%dS:SR=\E[%dT:UP=\E[%dA:ae=\E(B:al=\E[L:as=\E(0:bl=^G:bt=\E[Z:cd=\E[J:ce=\E[K:cl=\E[H\E[2J:cm=\E[%i%d;%dH:cr=\r:cs=\E[%i%d;%dr:ct=\E[3g:dc=\E[P:dl=\E[M:do=\n:ec=\E[%dX:ei=\E[4l:ho=\E[H:im=\E[4h:is=\E[!p\E[?3;4l\E[4l\E>:k1=\EOP:k2=\EOQ:k3=\EOR:k4=\EOS:k5=\E[15~:k6=\E[17~:k7=\E[18~:k8=\E[19~:k9=\E[20~:kD=\E[3~:kI=\E[2~:kN=\E[6~:kP=\E[5~:kb=\177:kd=\EOB:ke=\E[?1l\E>:kh=\EOH:kl=\EOD:kr=\EOC:ks=\E[?1h\E=:ku=\EOA:le=^H:mb=\E[5m:md=\E[1m:me=\E[0m:mh=\E[2m:mm=\E[?1034h:mo=\E[?1034l:mr=\E[7m:nd=\E[C:nw=\EE:rc=\E8:sc=\E7:se=\E[27m:sf=\n:so=\E[7m:sr=\EM:st=\EH:ta=^I:te=\E[?1049l\E[23;0;0t:ti=\E[?1049h\E[22;0;0t:ue=\E[24m:up=\E[A:us=\E[4m:vb=\E[?5h\E[?5l:ve=\E[?12l\E[?25h:vi=\E[?25l:vs=\E[?12;25h:`;

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

const CLEAR = `#!/bin/bash
# Riff: no terminfo in the session, so the xterm sequences directly.
printf '\\033[H\\033[2J\\033[3J'
`;

const WHICH = `#!/bin/bash
# Riff: which, from bash's own PATH lookup.
status=0
for name in "$@"; do
  case $name in -*) continue ;; esac
  if path=$(type -P -- "$name"); then printf '%s\\n' "$path"; else status=1; fi
done
exit $status
`;

const MAN = `#!/bin/bash
# Riff: the session has no manual pages; say so rather than "command not found".
echo "man: Riff's terminal has no manual pages. Try: \${1:-<command>} --help" >&2
exit 1
`;

// less reads its keys from /dev/tty, which the session doesn't connect to
// the terminal: measured, `less file` drew the file and then ignored every
// key (they queued up for bash) until Ctrl-C. The terminal keeps scrollback,
// so print instead of paging. Options are a pager's own; skip them.
const PAGER = `#!/bin/bash
# Riff: no pager in this terminal (it can't read keys); the file is printed.
files=()
for arg in "$@"; do
  case $arg in
    -*|+*) ;;
    *) files+=("$arg") ;;
  esac
done
exec cat -- "\${files[@]}"
`;

// The session's one user already has uid 0, so sudo has nothing to grant: it
// runs the command. Habits (`sudo npm i -g`, a README's `sudo make install`)
// then work instead of ending in "command not found". Options that keep that
// meaning are accepted, and -v/-k/-K do nothing (there's no password); any
// other (another user, a root shell with -s/-i) would pretend to do
// something the session can't, so it says so.
const SUDO = `#!/bin/bash
# Riff: you are the session's only user and already have uid 0, so sudo
# just runs the command.
noop=
while [ $# -gt 0 ]; do
  case $1 in
    -n|-E|-H|--non-interactive|--preserve-env|--set-home) shift ;;
    # No password, so nothing to validate or forget.
    -v|-k|-K|--validate|--reset-timestamp|--remove-timestamp) noop=1; shift ;;
    -u|--user) case $2 in root|user|0|"#0") shift 2 ;; *) echo "sudo: Riff's terminal has one user ('user', already root); it can't run as '$2'" >&2; exit 1 ;; esac ;;
    -uroot|-uuser|--user=root|--user=user) shift ;;
    --) shift; break ;;
    -*) echo "sudo: option $1 isn't supported in Riff's terminal (sudo here only runs the command; you're already root)" >&2; exit 1 ;;
    *) break ;;
  esac
done
if [ $# -eq 0 ]; then
  [ -n "$noop" ] && exit 0
  echo "usage: sudo [-n] [-E] [-H] [-u root] [--] command [args...]" >&2
  exit 1
fi
exec "$@"
`;

/** Scripts for the session's bin directory (installBinaries). */
export function sessionHelperCommands(): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new Map([
    ["hostname", encoder.encode(HOSTNAME)],
    ["clear", encoder.encode(CLEAR)],
    ["which", encoder.encode(WHICH)],
    ["man", encoder.encode(MAN)],
    ["less", encoder.encode(PAGER)],
    ["more", encoder.encode(PAGER)],
    ["sudo", encoder.encode(SUDO)],
  ]);
}
