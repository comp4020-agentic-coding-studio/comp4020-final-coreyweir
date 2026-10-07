#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Bridge stub v4: a WASIX binary that forwards argv/env/cwd to the host over
 * a shared request pipe and relays the host's response frames from its own
 * per-pid response pipe back to stdout/stderr. Guest signals are forwarded to
 * the host on the shared request pipe.
 *
 * The shared request pipe is read by the host only, so concurrent stubs can
 * each send a request. Responses go to a private pipe per guest pid
 * (`<RIFF_BRIDGE_ROOT>/.wasix-session/bridge/<pid>`), planted on demand by
 * the host once it sees the request, so no two stubs ever contend for the
 * same response bytes. Guest->host signal frames ride the shared request
 * pipe: the host is the only reader, so they cannot be stolen by another
 * stub, and the pipe stays open for the life of the process.
 *
 * Environment:
 *   RIFF_BRIDGE_PIPE   path of the shared request pipe device
 *   RIFF_BRIDGE_ROOT   guest root of the session control directory
 *
 * Request frame  : [u32 LE len][type u8 = 0][JSON body]
 *   JSON: {"pid":N,"cwd":"...","argv":["..."],"env":["K=V",...]}
 * Response frame (on <pid>): [u32 LE len][type u8][body]
 *   type 1 = stdout body     type 2 = stderr body
 *   type 3 = exit code (body = i32 LE)   type 4 = host error (body text)
 * Signal frame (on the shared pipe): [u32 LE len][type u8 = 5][i32 LE pid][u8 sig]
 */

#define MAX_BUF 65536

static volatile sig_atomic_t g_pending_sig = 0;
static int g_req_fd = -1;      /* shared request pipe, kept open for signals */
static long g_pid = 0;

/* Read exactly n bytes. */
static int read_exact(int fd, uint8_t *buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, buf + got, n - got);
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (r == 0) return -2; /* EOF */
    got += (size_t)r;
  }
  return 0;
}

static int write_all(int fd, const uint8_t *buf, size_t n) {
  size_t sent = 0;
  while (sent < n) {
    ssize_t r = write(fd, buf + sent, n - sent);
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    sent += (size_t)r;
  }
  return 0;
}

/* Write one framed message: [u32 LE len][type u8][body]. */
static int write_frame(int fd, uint8_t type, const uint8_t *payload, uint32_t plen) {
  uint8_t frame[MAX_BUF + 5];
  if (plen > MAX_BUF) return -1;
  uint32_t len = 1 + plen;
  frame[0] = (uint8_t)(len & 0xff);
  frame[1] = (uint8_t)((len >> 8) & 0xff);
  frame[2] = (uint8_t)((len >> 16) & 0xff);
  frame[3] = (uint8_t)((len >> 24) & 0xff);
  frame[4] = type;
  if (plen > 0) memcpy(frame + 5, payload, plen);
  return write_all(fd, frame, (size_t)len + 4);
}

/* Forward a guest signal to the host. Runs at a syscall boundary (the runtime
 * invokes the registered handler there). We only set a flag here — the main
 * loop writes the frame so we never re-enter the syscall machinery from inside
 * the handler. */
static void on_signal(int sig) {
  /* IMPORTANT: no blocking I/O here. This runs inside the runtime's signal
   * handler, which holds a `&mut FunctionEnvMut`; any syscall (fprintf, write)
   * from here deadlocks and the runtime aborts with SIGABRT. Just latch the
   * signal; the main loop flushes the frame. */
  if (g_pending_sig == 0) {
    g_pending_sig = (sig_atomic_t)sig;
  }
}

/* Write a pending signal frame to the shared request pipe: type 5, body =
 * [i32 LE pid][u8 sig]. */
static void flush_pending_signal(void) {
  if (g_pending_sig != 0 && g_req_fd >= 0) {
    uint8_t body[5];
    body[0] = (uint8_t)(g_pid & 0xff);
    body[1] = (uint8_t)((g_pid >> 8) & 0xff);
    body[2] = (uint8_t)((g_pid >> 16) & 0xff);
    body[3] = (uint8_t)((g_pid >> 24) & 0xff);
    body[4] = (uint8_t)g_pending_sig;
    (void)write_frame(g_req_fd, 5, body, 5);
    g_pending_sig = 0;
  }
}

static void put_escaped(char *out, size_t *pos, const char *s) {
  out[(*pos)++] = '"';
  for (const char *p = s; *p; p++) {
    if (*p == '"' || *p == '\\') {
      out[(*pos)++] = '\\';
      out[(*pos)++] = *p;
    } else if (*p == '\n') {
      out[(*pos)++] = '\\';
      out[(*pos)++] = 'n';
    } else if (*p == '\r') {
      out[(*pos)++] = '\\';
      out[(*pos)++] = 'r';
    } else if (*p == '\t') {
      out[(*pos)++] = '\\';
      out[(*pos)++] = 't';
    } else {
      out[(*pos)++] = *p;
    }
  }
  out[(*pos)++] = '"';
}

/* Build the request JSON. Returns length, or -1 if it doesn't fit. */
static int build_request(char *buf, size_t cap, int argc, char **argv, const char *cwd, long pid) {
  char pid_s[32];
  snprintf(pid_s, sizeof(pid_s), "%ld", pid);

  size_t pos = 0;
  buf[pos++] = '{';
  memcpy(buf + pos, "\"pid\":", 6);
  pos += 6;
  memcpy(buf + pos, pid_s, strlen(pid_s));
  pos += strlen(pid_s);
  memcpy(buf + pos, ",\"cwd\":", 7);
  pos += 7;
  put_escaped(buf, &pos, cwd ? cwd : "");
  memcpy(buf + pos, ",\"argv\":[", 9);
  pos += 9;
  for (int i = 0; i < argc; i++) {
    if (i > 0) buf[pos++] = ',';
    put_escaped(buf, &pos, argv[i]);
  }
  memcpy(buf + pos, "],\"env\":[", 9);
  pos += 9;
  /* Forward the entire environment: bridged processes previously only saw
   * PATH/HOME, which made any token-bearing env var (e.g. GITHUB_TOKEN for
   * the git stub) vanish between the WASIX shell and Nodepod. Host side
   * replaces its spawn env wholesale, so this list IS the child's env. */
  {
    extern char **environ;
    int first = 1;
    for (char **e = environ; e && *e; e++) {
      if (!first) buf[pos++] = ',';
      first = 0;
      put_escaped(buf, &pos, *e);
    }
  }
  buf[pos++] = ']';
  buf[pos++] = '}';
  if (pos > cap) return -1;
  return (int)pos;
}

int main(int argc, char **argv) {
  const char *pipe_path = getenv("RIFF_BRIDGE_PIPE");
  const char *root = getenv("RIFF_BRIDGE_ROOT");
  const char *cwd = getenv("PWD");
  g_pid = (long)getpid();
  if (!pipe_path || !root) {
    fprintf(stderr, "bridge stub: missing RIFF_BRIDGE_PIPE/RIFF_BRIDGE_ROOT\n");
    return 127;
  }

  /* Register handlers FIRST, before any pipe I/O, so a signal arriving while we
   * open/retry the response pipe is still caught (a handler only sets a flag;
   * the main loop flushes the frame). SIGQUIT is registered too so the
   * runtime's teardown SIGQUIT storm does not abort us mid-relay. */
  if (signal(SIGINT, on_signal) == SIG_ERR) fprintf(stderr, "bridge stub: SIGINT register failed\n");
  if (signal(SIGTERM, on_signal) == SIG_ERR) fprintf(stderr, "bridge stub: SIGTERM register failed\n");
  if (signal(SIGQUIT, on_signal) == SIG_ERR) fprintf(stderr, "bridge stub: SIGQUIT register failed\n");

  int fd = open(pipe_path, O_RDWR);
  if (fd < 0) {
    fprintf(stderr, "bridge stub: cannot open %s: %s\n", pipe_path, strerror(errno));
    return 127;
  }

  static char req[MAX_BUF];
  int req_len = build_request(req, sizeof(req), argc, argv, cwd, g_pid);
  if (req_len < 0) {
    fprintf(stderr, "bridge stub: request too large\n");
    return 127;
  }
  /* Write the header and body in one write() call so the host sees one
   * pipe message per request. Frame: [u32 len][type u8][json]. */
  uint32_t payload_len = (uint32_t)req_len + 1;
  static uint8_t req_frame[MAX_BUF + 4];
  uint8_t hdr[4] = {(uint8_t)(payload_len & 0xff), (uint8_t)((payload_len >> 8) & 0xff),
                    (uint8_t)((payload_len >> 16) & 0xff), (uint8_t)((payload_len >> 24) & 0xff)};
  memcpy(req_frame, hdr, 4);
  req_frame[4] = 0; /* type 0 = request */
  memcpy(req_frame + 5, req, (size_t)req_len);
  if (write_all(fd, req_frame, (size_t)payload_len + 4) < 0) {
    fprintf(stderr, "bridge stub: request write failed\n");
    return 127;
  }
  /* Keep the shared request pipe open so signals can ride it later. */
  g_req_fd = fd;

  /* Open our private response pipe. The host plants it after reading our
   * request, so retry; the first request through a fresh session may need to
   * wait for the host to create the pipe (worker round-trip + install). */
  char resp_path[1024];
  int r = snprintf(resp_path, sizeof(resp_path), "%s/.wasix-session/bridge/%ld", root, g_pid);
  if (r < 0 || (size_t)r >= sizeof(resp_path)) {
    fprintf(stderr, "bridge stub: response path too long\n");
    return 127;
  }
  int resp_fd = -1;
  for (int attempt = 0; attempt < 2000 && resp_fd < 0; attempt++) {
    resp_fd = open(resp_path, O_RDWR);
    if (resp_fd < 0) usleep(5000);
  }
  if (resp_fd < 0) {
    fprintf(stderr, "bridge stub: cannot open response pipe %s: %s\n", resp_path, strerror(errno));
    return 127;
  }

  static uint8_t frame[MAX_BUF + 5];
  for (;;) {
    flush_pending_signal();
    /* Each host HostPipe.write() is one pipe message = one complete frame:
     * [u32 LE len][type u8][payload len-1]. Read the whole message at once. */
    ssize_t n = read(resp_fd, frame, sizeof(frame));
    if (n < 0) {
      if (errno == EINTR) {
        flush_pending_signal();
        continue;
      }
      fprintf(stderr, "bridge stub: response read failed: %s\n", strerror(errno));
      return 127;
    }
    if (n == 0) {
      fprintf(stderr, "bridge stub: response pipe closed\n");
      return 127;
    }
    if (n < 4) {
      fprintf(stderr, "bridge stub: short frame header (%zd bytes)\n", n);
      return 127;
    }
    uint32_t len = (uint32_t)frame[0] | ((uint32_t)frame[1] << 8) |
                   ((uint32_t)frame[2] << 16) | ((uint32_t)frame[3] << 24);
    if (len == 0 || len > MAX_BUF || (ssize_t)(len + 4) > n) {
      fprintf(stderr, "bridge stub: bad response frame length %u (n=%zd); head=", len, n);
      for (int i = 0; i < 12; i++) fprintf(stderr, "%02x ", frame[i]);
      fprintf(stderr, "\n");
      return 127;
    }
    uint8_t type = frame[4];
    const uint8_t *body = frame + 5;
    uint32_t blen = len - 1;
    if (type == 3) {
      if (blen < 4) {
        fprintf(stderr, "bridge stub: bad exit frame\n");
        return 127;
      }
      int32_t code = (int32_t)body[0] | ((int32_t)body[1] << 8) |
                     ((int32_t)body[2] << 16) | ((int32_t)body[3] << 24);
      close(resp_fd);
      return (int)code;
    }
    if (type == 1) {
      fwrite(body, 1, blen, stdout);
      fflush(stdout);
    } else if (type == 2 || type == 4) {
      fwrite(body, 1, blen, stderr);
      fflush(stderr);
    } else {
      fprintf(stderr, "bridge stub: unknown frame type %u\n", type);
    }
  }
}
