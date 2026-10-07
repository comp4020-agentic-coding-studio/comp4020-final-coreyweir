'use strict';

// Entrypoint for Claude Code inside a Nodepod VFS (or plain Node).
// Mirrors ../nanovm_poc/claude-node/run.mjs + browser.mjs layout:
//   /opt/claude/{shim,run,claude-booted.js[.patched.js|.gz]}
//   /work/repo  as cwd

require('./shim.cjs');

// Nodepod / browser polyfill gaps that Claude Code trips over.
(() => {
  // Ink expects `require('console').Console` / `new console.Console({stdout,stderr})`.
  const makeConsoleCtor = () => {
    return class Console {
      constructor(stdout, stderr, ignoreErrors) {
        // Node supports both Console(stdout, stderr) and Console({ stdout, stderr }).
        let out = stdout;
        let err = stderr;
        if (stdout && typeof stdout === 'object' && !stdout.write && (stdout.stdout || stdout.stderr)) {
          out = stdout.stdout;
          err = stdout.stderr;
        }
        this._stdout = out || process.stdout;
        this._stderr = err || process.stderr || this._stdout;
        const write = (stream, args) => {
          try {
            const line =
              args
                .map((a) => {
                  if (typeof a === 'string') return a;
                  try {
                    return JSON.stringify(a);
                  } catch {
                    return String(a);
                  }
                })
                .join(' ') + '\n';
            if (stream && typeof stream.write === 'function') stream.write(line);
          } catch {
            // ignore
          }
        };
        this.log = (...args) => write(this._stdout, args);
        this.info = (...args) => write(this._stdout, args);
        this.debug = (...args) => write(this._stdout, args);
        this.warn = (...args) => write(this._stderr, args);
        this.error = (...args) => write(this._stderr, args);
      }
    };
  };

  // Nodepod's require('console') can hand out fresh shallow copies; cache one
  // patched module object so Ink's `import { Console } from 'console'` sees it
  // when the binding is resolved through Module.require.
  let cachedConsoleModule = null;
  const ensureConsoleModule = (mod) => {
    if (cachedConsoleModule && typeof cachedConsoleModule.Console === 'function') {
      return cachedConsoleModule;
    }
    if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) return mod;
    const Console = typeof mod.Console === 'function' ? mod.Console : makeConsoleCtor();
    try {
      mod.Console = Console;
      cachedConsoleModule = mod;
      return mod;
    } catch {
      cachedConsoleModule = {
        Console,
        log: mod.log,
        error: mod.error,
        warn: mod.warn,
        info: mod.info,
        debug: mod.debug,
        trace: mod.trace,
        dir: mod.dir,
        assert: mod.assert,
        clear: mod.clear,
        count: mod.count,
        countReset: mod.countReset,
        group: mod.group,
        groupCollapsed: mod.groupCollapsed,
        groupEnd: mod.groupEnd,
        table: mod.table,
        time: mod.time,
        timeEnd: mod.timeEnd,
        timeLog: mod.timeLog,
      };
      return cachedConsoleModule;
    }
  };

  try {
    if (typeof console === 'object' && console) {
      ensureConsoleModule(console);
    }
  } catch {
    // ignore
  }

  // Node 22+ URL.parse(input[, base]) — returns URL or null (non-throwing).
  try {
    if (typeof URL === 'function' && typeof URL.parse !== 'function') {
      URL.parse = function parse(input, base) {
        try {
          return base === undefined ? new URL(input) : new URL(input, base);
        } catch {
          return null;
        }
      };
    }
  } catch {
    // ignore
  }

  // Interactive Ink paints via CSI writes without trailing newlines. If
  // stdout.isTTY is false, Node buffers those writes and the UI never appears
  // while newline-terminated --debug-to-stderr lines still do. Force TTY-ish
  // shape for non -p launches; createTerminal should already provide setRawMode.
  const forceInteractiveTty = () => {
    const argv = process.argv || [];
    if (argv.includes('-p') || argv.includes('--print') || argv.includes('--version') || argv.includes('-h') || argv.includes('--help')) {
      return;
    }
    const force = (stream, { columns, rows } = {}) => {
      if (!stream || typeof stream !== 'object') return;
      try {
        if (!stream.isTTY) {
          try {
            Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
          } catch {
            stream.isTTY = true;
          }
        }
      } catch {
        // ignore
      }
      if (columns != null) {
        try {
          if (!stream.columns) stream.columns = columns;
        } catch {
          // ignore
        }
      }
      if (rows != null) {
        try {
          if (!stream.rows) stream.rows = rows;
        } catch {
          // ignore
        }
      }
      if (typeof stream.setRawMode !== 'function') {
        try {
          stream.setRawMode = function setRawMode() {
            return stream;
          };
        } catch {
          // ignore
        }
      }
      if (typeof stream.ref !== 'function') {
        try {
          stream.ref = function ref() {
            return stream;
          };
        } catch {
          // ignore
        }
      }
      if (typeof stream.unref !== 'function') {
        try {
          stream.unref = function unref() {
            return stream;
          };
        } catch {
          // ignore
        }
      }
    };
    force(process.stdout, { columns: 80, rows: 24 });
    force(process.stderr);
    force(process.stdin);
    try {
      if (!process.env.TERM) process.env.TERM = 'xterm-256color';
      if (!process.env.COLORTERM) process.env.COLORTERM = 'truecolor';
      // Claude Ink reads this when relaunching; also helps if columns/rows are 0.
      if (!process.env.CLAUDE_CODE_RELAUNCH_TERMINAL_SIZE) {
        process.env.CLAUDE_CODE_RELAUNCH_TERMINAL_SIZE = '80x24';
      }
    } catch {
      // ignore
    }
  };
  try {
    forceInteractiveTty();
  } catch {
    // ignore
  }

  // Nodepod's guest stdin (`_m(false)`) only emits 'data' — it never emits
  // 'readable' and its `.read()` returns null. Claude's Ink reads stdin via
  // `'readable'` events + `.read()` (handleReadable), and the early-input
  // capture also uses `on('readable')` + `read()`. So keystrokes die in the
  // buffer even though Nodepod forwards them as 'data' events.
  //
  // Fix: wrap process.stdin so 'data' chunks feed an internal queue that backs
  // a real readable-style API: emit('readable'), .read() (string when an
  // encoding was set, else Buffer), .readableLength, plus pass-throughs for
  // setRawMode/ref/unref/resume/pause and event forwarding.
  const wrapStdinReadable = (stdin) => {
    if (!stdin || typeof stdin.on !== 'function' || stdin.__nodepodClaudeReadable) return stdin;
    let queue = Buffer.alloc(0);
    let encoding = null;
    const underlying = stdin;
    try {
      const emitter = underlying;
      const onData = (chunk) => {
        try {
          const buf =
            typeof chunk === 'string'
              ? Buffer.from(chunk, 'utf8')
              : Buffer.isBuffer(chunk)
                ? chunk
                : chunk instanceof Uint8Array
                  ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                  : Buffer.from(String(chunk ?? ''), 'utf8');
          if (buf.length === 0) return;
          queue = Buffer.concat([queue, buf]);
          const hasReadable = emitter.listenerCount('readable') > 0;
          const hasData = emitter.listenerCount('data') > 0;
          if (hasReadable) {
            queueMicrotask(() => {
              try {
                emitter.emit('readable');
              } catch {
                // ignore
              }
            });
          } else if (hasData) {
            // Fall back to raw 'data' forwarding when nobody reads via readable.
            const out = encoding ? queue.toString(encoding) : queue;
            queue = Buffer.alloc(0);
            try {
              emitter.emit('data', out);
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      };
      try {
        underlying.removeAllListeners('data');
      } catch {
        // ignore
      }
      underlying.on('data', onData);

      // If a 'readable' listener attaches while we already have buffered data
      // (e.g. Nodepod delivered keystrokes before Ink subscribed), flush it.
      try {
        underlying.on('newListener', (evt) => {
          if (evt === 'readable' && queue.length > 0) {
            queueMicrotask(() => {
              try {
                underlying.emit('readable');
              } catch {
                // ignore
              }
            });
          }
        });
      } catch {
        // ignore
      }

      const doRead = () => {
        if (queue.length === 0) return null;
        const out = encoding ? queue.toString(encoding) : queue;
        queue = Buffer.alloc(0);
        return out;
      };

      Object.defineProperty(underlying, 'read', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function read() {
          return doRead();
        },
      });
      Object.defineProperty(underlying, 'readableLength', {
        configurable: true,
        enumerable: false,
        get() {
          return queue.length;
        },
      });
      const origSetEncoding =
        typeof underlying.setEncoding === 'function'
          ? underlying.setEncoding.bind(underlying)
          : null;
      Object.defineProperty(underlying, 'setEncoding', {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function setEncoding(enc) {
          encoding = enc || null;
          if (origSetEncoding) {
            try {
              return origSetEncoding(enc);
            } catch {
              // ignore
            }
          }
          return underlying;
        },
      });
      // Give the underlying stream a working `on('readable')` so listenerCount
      // reflects real readers; `data` listeners are handled above.
      try {
        underlying.__nodepodClaudeReadable = true;
      } catch {
        // ignore
      }
      return underlying;
    } catch {
      try {
        underlying.__nodepodClaudeReadable = true;
      } catch {
        // ignore
      }
      return underlying;
    }
  };

  try {
    // Interactive (non -p) launches read stdin through Ink's `'readable'`
    // handler; Nodepod only emits 'data'. Wrap once at startup.
    const argv = process.argv || [];
    if (!argv.includes('-p') && !argv.includes('--print') && !argv.includes('--version') && !argv.includes('-h') && !argv.includes('--help')) {
      wrapStdinReadable(process.stdin);
    }
  } catch {
    // ignore
  }

  // Nodepod worker VFS sometimes ENOENT on chmod right after creating a temp
  // file (Claude atomic ~/.claude.json writes). Soft-succeed so config can
  // persist and stop the chmod retry storm.
  const wrapFsChmod = (fsMod) => {
    if (!fsMod || fsMod.__nodepodClaudeFsPatched) return fsMod;
    const patchSync = (name) => {
      const orig = fsMod[name];
      if (typeof orig !== 'function') {
        try {
          fsMod[name] = function patchedMissingChmodSync() {
            return undefined;
          };
        } catch {
          // ignore
        }
        return;
      }
      try {
        fsMod[name] = function patchedChmodSync(path, mode) {
          try {
            return orig.apply(this, arguments);
          } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'ENOTSUP')) {
              return undefined;
            }
            throw err;
          }
        };
      } catch {
        // ignore
      }
    };
    const patchAsync = (name) => {
      const orig = fsMod[name];
      if (typeof orig !== 'function') {
        try {
          fsMod[name] = function patchedMissingChmod(path, mode, cb) {
            const callback = typeof mode === 'function' ? mode : cb;
            if (typeof callback === 'function') callback(null);
            return undefined;
          };
        } catch {
          // ignore
        }
        return;
      }
      try {
        fsMod[name] = function patchedChmod(path, mode, cb) {
          const args = [...arguments];
          const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
          if (!callback) {
            try {
              return orig.apply(this, arguments);
            } catch (err) {
              if (err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'ENOTSUP')) {
                return undefined;
              }
              throw err;
            }
          }
          const fwd = args.slice(0, -1);
          fwd.push((err, ...rest) => {
            if (err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'ENOTSUP')) {
              callback(null, ...rest);
              return;
            }
            callback(err, ...rest);
          });
          try {
            return orig.apply(this, fwd);
          } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'ENOTSUP')) {
              callback(null);
              return;
            }
            throw err;
          }
        };
      } catch {
        // ignore
      }
    };
    patchSync('chmodSync');
    patchSync('lchmodSync');
    patchSync('fchmodSync');
    patchAsync('chmod');
    patchAsync('lchmod');
    patchAsync('fchmod');
    try {
      fsMod.__nodepodClaudeFsPatched = true;
    } catch {
      // ignore
    }
    return fsMod;
  };
  const wrapFsPromisesChmod = (fsPromises) => {
    if (!fsPromises || fsPromises.__nodepodClaudeFsPatched || typeof fsPromises.open !== 'function') {
      return fsPromises;
    }
    const origOpen = fsPromises.open;
    try {
      fsPromises.open = async function patchedOpen() {
        const handle = await origOpen.apply(this, arguments);
        if (!handle || typeof handle.chmod !== 'function' || handle.chmod.__nodepodClaudePatched) {
          return handle;
        }
        const origChmod = handle.chmod;
        async function patchedFileHandleChmod() {
          try {
            return await origChmod.apply(this, arguments);
          } catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'ENOTSUP')) {
              return undefined;
            }
            throw err;
          }
        }
        patchedFileHandleChmod.__nodepodClaudePatched = true;
        try {
          handle.chmod = patchedFileHandleChmod;
        } catch {
          // ignore
        }
        return handle;
      };
      fsPromises.__nodepodClaudeFsPatched = true;
    } catch {
      // ignore
    }
    return fsPromises;
  };
  try {
    wrapFsChmod(require('fs'));
    wrapFsPromisesChmod(require('fs/promises'));
  } catch {
    // ignore
  }

  // Anthropic/LiteLLM guest interceptor (better than a page SW here: Claude's
  // outbound calls run in Nodepod process workers, where a host SW is unreliable
  // and would fight Nodepod's own /__sw__.js).
  //
  // 1) Stub /api/hello — LiteLLM doesn't implement Anthropic's warmup/preflight
  //    route; the fire-and-forget HEAD can sit on a ~10s AbortSignal timeout.
  // 2) Rewrite POST /v1/messages JSON so thinking.display = "summarized".
  //    Claude currently forces "omitted" and config/CLI can't override it.
  const urlPathname = (raw) => {
    try {
      return new URL(String(raw), 'http://local').pathname;
    } catch {
      return '';
    }
  };
  const isHelloUrl = (raw) => {
    const p = urlPathname(raw);
    return p === '/api/hello' || p.endsWith('/api/hello');
  };
  const isMessagesUrl = (raw) => {
    const p = urlPathname(raw);
    return p === '/v1/messages' || p.endsWith('/v1/messages');
  };
  const rewriteThinkingDisplayText = (bodyText) => {
    try {
      const json = JSON.parse(bodyText);
      if (!json || typeof json !== 'object' || Array.isArray(json)) return bodyText;
      if (json.thinking && typeof json.thinking === 'object' && !Array.isArray(json.thinking)) {
        if (json.thinking.type !== 'disabled' && json.thinking.display !== 'summarized') {
          json.thinking.display = 'summarized';
        }
        return JSON.stringify(json);
      }
      return bodyText;
    } catch {
      return bodyText;
    }
  };
  const rewriteThinkingDisplayValue = (data) => {
    if (data == null) return data;
    if (typeof data === 'string') return rewriteThinkingDisplayText(data);
    if (typeof data === 'object' && !Array.isArray(data)) {
      if (data.thinking && typeof data.thinking === 'object' && !Array.isArray(data.thinking)) {
        if (data.thinking.type !== 'disabled' && data.thinking.display !== 'summarized') {
          return { ...data, thinking: { ...data.thinking, display: 'summarized' } };
        }
      }
      return data;
    }
    return data;
  };
  const bodyToText = async (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return body.toString('utf8');
    if (body instanceof Uint8Array) return new TextDecoder().decode(body);
    if (typeof Blob !== 'undefined' && body instanceof Blob) return await body.text();
    if (typeof Response !== 'undefined' && typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return await new Response(body).text();
    }
    if (typeof body.text === 'function') return await body.text();
    try {
      return String(body);
    } catch {
      return '';
    }
  };
  const helloResponse = (method) => {
    const m = String(method || 'GET').toUpperCase();
    if (m === 'HEAD' || m === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    return new Response(JSON.stringify({ type: 'hello', ok: true, via: 'nodepod-claude-polyfill' }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
  const patchFetch = (fetchFn) => {
    if (typeof fetchFn !== 'function' || fetchFn.__nodepodClaudePatched) return fetchFn;
    const patched = async function patchedFetch(input, init) {
      let url = '';
      let method = 'GET';
      let body = init?.body;
      if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) {
        url = String(input);
        method = String(init?.method || 'GET').toUpperCase();
      } else if (input && typeof input === 'object') {
        url = String(input.url || '');
        method = String(init?.method || input.method || 'GET').toUpperCase();
        if (body === undefined) body = input.body;
      }

      if (isHelloUrl(url)) return helloResponse(method);

      if (isMessagesUrl(url) && method === 'POST' && body != null) {
        const text = await bodyToText(body);
        const rewritten = rewriteThinkingDisplayText(text);
        if (rewritten !== text) {
          if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) {
            return fetchFn(input, { ...(init || {}), method, body: rewritten });
          }
          try {
            const headers = init?.headers || input.headers;
            const reqInit = { method, headers, body: rewritten };
            // Node fetch may require duplex when sending a body from a Request.
            try {
              reqInit.duplex = 'half';
            } catch {
              // ignore
            }
            return fetchFn(new Request(url, reqInit));
          } catch {
            return fetchFn(url, { method, headers: init?.headers || input.headers, body: rewritten });
          }
        }
      }
      return fetchFn(input, init);
    };
    patched.__nodepodClaudePatched = true;
    return patched;
  };
  try {
    if (typeof globalThis.fetch === 'function') {
      globalThis.fetch = patchFetch(globalThis.fetch);
    }
  } catch {
    // ignore
  }
  try {
    if (typeof global !== 'undefined' && global && global.fetch && !global.fetch.__nodepodClaudePatched) {
      global.fetch = patchFetch(global.fetch);
    }
  } catch {
    // ignore
  }

  const ensureAxios = (axios) => {
    if (!axios || axios.__nodepodClaudePatched) return axios;
    const apply = (instance) => {
      if (!instance || typeof instance.interceptors?.request?.use !== 'function') return;
      if (instance.__nodepodClaudeAxiosPatched) return;
      instance.__nodepodClaudeAxiosPatched = true;
      instance.interceptors.request.use((config) => {
        try {
          const rawUrl =
            typeof config.url === 'string' && /^https?:/i.test(config.url)
              ? config.url
              : `${config.baseURL || ''}${config.url || ''}`;
          if (isHelloUrl(rawUrl)) {
            config.adapter = async (cfg) => ({
              data: { type: 'hello', ok: true, via: 'nodepod-claude-polyfill' },
              status: 200,
              statusText: 'OK',
              headers: { 'content-type': 'application/json' },
              config: cfg,
              request: {},
            });
            return config;
          }
          if (isMessagesUrl(rawUrl) && String(config.method || 'get').toUpperCase() === 'POST') {
            config.data = rewriteThinkingDisplayValue(config.data);
          }
        } catch {
          // ignore
        }
        return config;
      });
    };
    try {
      apply(axios);
      if (typeof axios.create === 'function') {
        const origCreate = axios.create.bind(axios);
        axios.create = function patchedCreate() {
          const inst = origCreate.apply(this, arguments);
          apply(inst);
          return inst;
        };
      }
      axios.__nodepodClaudePatched = true;
    } catch {
      // ignore
    }
    return axios;
  };

  const encodeOut = (value, encoding) => {
    if (value == null) return encoding ? '' : value;
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return encoding ? value.toString(encoding) : value;
    if (value instanceof Uint8Array) {
      const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      return encoding ? buf.toString(encoding) : buf;
    }
    if (typeof value === 'object') {
      try {
        const buf = Buffer.from(Uint8Array.from(value));
        return encoding ? buf.toString(encoding) : buf;
      } catch {
        return encoding ? String(value) : value;
      }
    }
    return encoding ? String(value) : value;
  };

  const ensureNet = (net) => {
    if (!net || typeof net !== 'object') return net;
    if (typeof net.BlockList !== 'function') {
      class BlockList {
        constructor() {
          this._rules = [];
        }
        addAddress(address, type) {
          this._rules.push({ kind: 'address', address, type });
        }
        addRange(start, end, type) {
          this._rules.push({ kind: 'range', start, end, type });
        }
        addSubnet(subnet, prefix, type) {
          this._rules.push({ kind: 'subnet', subnet, prefix, type });
        }
        check(_address, _type) {
          return false;
        }
        getRules() {
          return this._rules.slice();
        }
      }
      try {
        net.BlockList = BlockList;
      } catch {
        // ignore sealed exports
      }
    }
    try {
      if (typeof net.Socket !== 'function' && typeof net.TcpSocket === 'function') {
        net.Socket = net.TcpSocket;
      }
      if (typeof net.Server !== 'function' && typeof net.TcpServer === 'function') {
        net.Server = net.TcpServer;
      }
    } catch {
      // ignore
    }
    return net;
  };

  const ensureEvents = (events) => {
    // Node's `require('events')` is the EventEmitter function plus helpers.
    if (!events || (typeof events !== 'object' && typeof events !== 'function')) {
      return events;
    }
    if (typeof events.setMaxListeners === 'function') return events;

    const setMaxListeners = function setMaxListeners(n, ...targets) {
      if (targets.length === 0) {
        if (typeof n === 'number') {
          try {
            events.defaultMaxListeners = n;
          } catch {
            // ignore
          }
        }
        return;
      }
      for (const target of targets) {
        if (target && typeof target.setMaxListeners === 'function') {
          target.setMaxListeners(n);
        }
      }
    };

    try {
      events.setMaxListeners = setMaxListeners;
    } catch {
      // ignore
    }
    return events;
  };

  const normalizeShellCommand = (command) =>
    command === '/bin/bash' || command === '/usr/bin/bash' ? 'bash' : command;

  const wrapCommand = (commandFn) => {
    if (typeof commandFn !== 'function') return commandFn;
    return function patchedCommand(command, ...args) {
      return commandFn(normalizeShellCommand(command), ...args);
    };
  };

  const wrapSpawnSync = (spawnSync) => {
    if (typeof spawnSync !== 'function' || spawnSync.__nodepodClaudePatched) return spawnSync;
    const patched = function patchedSpawnSync(command, args, options) {
      let argv = args;
      let opts = options;
      if (argv && !Array.isArray(argv) && typeof argv === 'object') {
        opts = argv;
        argv = undefined;
      }
      opts = opts || {};
      const encoding =
        typeof opts.encoding === 'string' && opts.encoding !== 'buffer'
          ? opts.encoding
          : undefined;
      const result =
        argv === undefined
          ? spawnSync(normalizeShellCommand(command), opts)
          : spawnSync(normalizeShellCommand(command), argv, opts);
      if (!result || typeof result !== 'object') return result;
      result.stdout = encodeOut(result.stdout, encoding);
      result.stderr = encodeOut(result.stderr, encoding);
      if (Array.isArray(result.output)) {
        result.output = result.output.map((chunk, i) =>
          i === 0 ? chunk : encodeOut(chunk, encoding),
        );
      }
      return result;
    };
    patched.__nodepodClaudePatched = true;
    return patched;
  };

  const wrapChildProcess = (cp) => {
    if (!cp || typeof cp !== 'object' || cp.__nodepodClaudePatched) return cp;
    const spawnSync = wrapSpawnSync(cp.spawnSync.bind(cp));
    const spawn = wrapCommand(cp.spawn?.bind(cp));
    const execFile = wrapCommand(cp.execFile?.bind(cp));
    const execFileSync = wrapCommand(cp.execFileSync?.bind(cp));
    return new Proxy(cp, {
      get(target, prop, receiver) {
        if (prop === 'spawnSync') return spawnSync;
        if (prop === 'spawn') return spawn;
        if (prop === 'execFile') return execFile;
        if (prop === 'execFileSync') return execFileSync;
        if (prop === '__nodepodClaudePatched') return true;
        return Reflect.get(target, prop, receiver);
      },
    });
  };

  try {
    // Warm Buffer-like prototype with `.trim()` for spawnSync stdout fallback.
    const rawCp = require('child_process');
    const sample = rawCp.spawnSync('echo', ['x'], { encoding: 'utf8' });
    const out = sample && sample.stdout;
    if (out && typeof out === 'object' && typeof out.trim !== 'function') {
      const proto = Object.getPrototypeOf(out);
      if (proto && typeof proto.trim !== 'function') {
        proto.trim = function trim(arg) {
          return this.toString('utf8').trim(arg);
        };
      }
    }
  } catch {
    // ignore
  }

  try {
    ensureNet(require('net'));
    ensureEvents(require('events'));
  } catch {
    // ignore
  }

  try {
    const Module = require('module');
    if (Module?.prototype?.require && !Module.prototype.require.__nodepodClaudePatched) {
      const origRequire = Module.prototype.require;
      function patchedRequire(id) {
        const exp = origRequire.apply(this, arguments);
        if (id === 'events' || id === 'node:events') return ensureEvents(exp);
        if (id === 'net' || id === 'node:net') return ensureNet(exp);
        if (id === 'child_process' || id === 'node:child_process') return wrapChildProcess(exp);
        if (id === 'console' || id === 'node:console') return ensureConsoleModule(exp);
        if (id === 'fs' || id === 'node:fs') return wrapFsChmod(exp);
        if (id === 'fs/promises' || id === 'node:fs/promises') return wrapFsPromisesChmod(exp);
        if (id === 'axios') return ensureAxios(exp);
        return exp;
      }
      patchedRequire.__nodepodClaudePatched = true;
      Module.prototype.require = patchedRequire;
    }
  } catch {
    // ignore
  }

  globalThis.__nodepodClaudeShellProbe = async function shellProbe() {
    const cp = require('child_process');
    const probeFs = require('fs');
    const probeFsPromises = require('fs/promises');
    const results = {};
    const text = (value) => value && typeof value.toString === 'function'
      ? value.toString('utf8')
      : String(value ?? '');
    const capture = async (api, run) => {
      try {
        results[api] = await run();
      } catch (error) {
        results[api] = { error: error && error.message ? error.message : String(error) };
      }
    };
    await capture('spawnSync', () => text(cp.spawnSync(
      'bash',
      ['-c', '-l', "printf 'spawnSync_ok\\n'"],
      { encoding: 'utf8' },
    ).stdout));
    await capture('execFileSync', () => text(cp.execFileSync(
      'bash',
      ['-c', "printf 'execFileSync_ok\\n'"],
      { encoding: 'utf8' },
    )));
    await capture('spawn', () => new Promise((resolve, reject) => {
      const child = cp.spawn('bash', ['-c', '-l', "printf 'spawn_ok\\n'"]);
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`spawn exited ${code}`)));
    }));
    await capture('execFile', () => new Promise((resolve, reject) => {
      cp.execFile('bash', ['-c', "printf 'execFile_ok\\n'"], { encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }));
    await capture('shellDetection', () => new Promise((resolve, reject) => {
      cp.execFile('bash', ['--version'], { encoding: 'utf8', timeout: 10000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }));
    await capture('numericStdio', () => new Promise((resolve, reject) => {
      const outputPath = '/work/repo/.shell-routing-output';
      const fd = probeFs.openSync(outputPath, 'w');
      const child = cp.spawn('bash', ['-c', '-l', "printf 'numericStdio_ok\\n'"], {
        stdio: ['pipe', fd, fd],
      });
      let stdout = '';
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        probeFs.closeSync(fd);
        if (code !== 0) reject(new Error(`numeric stdio spawn exited ${code}`));
        else resolve({ file: probeFs.readFileSync(outputPath, 'utf8'), stdout });
      });
    }));
    await capture('atomicUpdate', async () => {
      const target = '/work/repo/.atomic-update-target';
      const temp = '/work/repo/.atomic-update-target.tmp';
      await probeFsPromises.writeFile(target, 'old');
      await probeFsPromises.writeFile(temp, 'new');
      await probeFsPromises.chmod(temp, 0o600);
      await probeFsPromises.rename(temp, target);
      return probeFsPromises.readFile(target, 'utf8');
    });
    await capture('atomicFileHandleUpdate', async () => {
      const target = '/work/repo/.atomic-handle-target';
      const temp = '/work/repo/.atomic-handle-target.tmp';
      await probeFsPromises.writeFile(target, 'old');
      const originalMode = (await probeFsPromises.stat(target)).mode;
      const flags = probeFs.constants.O_WRONLY
        | probeFs.constants.O_CREAT
        | probeFs.constants.O_EXCL
        | (probeFs.constants.O_NOFOLLOW ?? 0);
      const handle = await probeFsPromises.open(temp, flags);
      try {
        await handle.writeFile('new', { encoding: 'utf8' });
        await handle.chmod(originalMode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await probeFsPromises.rename(temp, target);
      return probeFsPromises.readFile(target, 'utf8');
    });
    process.stdout.write(`${JSON.stringify(results)}\n`);
  };
})();

const fs = require('fs');
const path = require('path');

const here = __dirname;
const workRepo = '/work/repo';
try {
  fs.mkdirSync(workRepo, { recursive: true });
  process.chdir(workRepo);
} catch {
  // Host-side plain Node may not have /work; stay put.
}

process.env.DISABLE_AUTOUPDATER ??= '1';
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--nodepod-shell-probe') {
  globalThis.__nodepodClaudeShellProbe().then(
    () => process.exit(0),
    (error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exit(1);
    },
  );
} else {
  const compressed = path.join(here, 'claude-booted.js.gz');
  const plain = path.join(here, 'claude-booted.js');
  const patched = path.join(here, 'claude-booted.patched.js');

  function patchClaudeSource(code) {
    // Targeted patch for AbortController helper:
    //   Uxu=require("events"); ... Uxu.setMaxListeners(e, t.signal)
    if (code.includes('Uxu=require("events")') && !code.includes('Uxu.__nodepodSetMaxListenersPatched')) {
      code = code.replace(
        'Uxu=require("events")',
        'Uxu=require("events");Uxu.__nodepodSetMaxListenersPatched=1;if(typeof Uxu.setMaxListeners!=="function")Uxu.setMaxListeners=function(n,...t){if(!t.length){try{Uxu.defaultMaxListeners=n}catch{}}for(const x of t){if(x&&typeof x.setMaxListeners==="function")x.setMaxListeners(n)}}',
      );
    }
    const bashOutputMode = 'G=await m.getEnvironmentOverrides(e,u),U=!!c,F=r$("local_bash")';
    if (code.includes(bashOutputMode)) {
      code = code.replace(
        bashOutputMode,
        'G=await m.getEnvironmentOverrides(e,u),U=!0/*NODEPOD_BASH_PIPE_OUTPUT_PATCHED*/,F=r$("local_bash")',
      );
    }
    return code;
  }

  let entry = patched;
  if (!fs.existsSync(entry)) {
    // Fallback: build patched bundle in-guest (slow — prefer host prepare:claude).
    let source;
    if (fs.existsSync(compressed) && !fs.existsSync(plain)) {
      const zlib = require('zlib');
      source = zlib.gunzipSync(fs.readFileSync(compressed)).toString('utf8');
    } else {
      source = fs.readFileSync(plain, 'utf8');
    }
    fs.writeFileSync(patched, patchClaudeSource(source));
    entry = patched;
  }

  process.argv = [process.execPath || 'node', entry, ...args];
  require(entry);
}
