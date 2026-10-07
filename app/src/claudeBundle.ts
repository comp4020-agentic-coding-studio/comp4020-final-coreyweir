/**
 * Derives `claude-booted.patched.js` in the browser instead of shipping it.
 *
 * The published npm tarball is fetched, gunzipped and untarred on the fly; the
 * `claude` entry is a Bun single-file executable, so the JavaScript bundle is
 * read straight out of its Mach-O `__BUN,__bun` section and then patched. Only
 * the ~23 MB of JavaScript is ever retained — the surrounding ~280 MB of
 * executable streams past and is discarded.
 *
 * The extraction mirrors unbuned.py, the boot patch mirrors
 * nanovm_poc/claude-node/boot.mjs and the source patches mirror
 * nodepod_wasm_wip/scripts/lib/patch-claude-source.mjs. Any drift between those
 * and this file shows up immediately as a CLAUDE_BUNDLE_SHA256 mismatch.
 */

/** Pinned release. Bumping it requires re-pinning CLAUDE_BUNDLE_SHA256. */
export const CLAUDE_VERSION = "2.1.221";
export const CLAUDE_TARBALL_URL =
  `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-x64/-/claude-code-darwin-x64-${CLAUDE_VERSION}.tgz`;
/** The Bun executable inside the tarball. */
export const CLAUDE_TAR_ENTRY = "package/claude";
/**
 * SHA-256 of the fully patched bundle. Pinning the *output* rather than the
 * tarball lets us verify without buffering 82 MB, and it also catches a patch
 * that silently stopped matching after an upstream rename.
 */
export const CLAUDE_BUNDLE_SHA256 = "9dd6baed2f2144fc7c78bc835d0a1792e47e87b4bfe89249dbf00ddcf27c5bd8";

const CACHE_NAME = "riff-claude-bundle-v1";
const BUN_JS_MARKER = "// @bun";
const TAR_BLOCK = 512;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_MAGIC_32 = 0xfeedface;
const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const LC_SEGMENT_64 = 0x19;

export type BundleReport = (status: string) => void;

export type LoadClaudeBundleOptions = {
  tarballUrl?: string;
  entryName?: string;
  /** Pass null to skip verification (only useful when re-pinning a new version). */
  expectedSha256?: string | null;
  report?: BundleReport;
  signal?: AbortSignal;
  /** Set false to always re-derive, e.g. from a smoke test. */
  cache?: boolean;
};

// ---------------------------------------------------------------------------
// Byte plumbing
// ---------------------------------------------------------------------------

/**
 * A pull-based cursor over a byte stream. Chunks are handed out at most once,
 * so a caller can skip megabytes without ever materialising them.
 */
class ByteStream {
  /** Bytes consumed so far; the stream's absolute read offset. */
  position = 0;
  private pending: Uint8Array | null = null;
  private ended = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  // Not a parameter property: this module is also imported directly by the
  // smoke test, and Node's type-stripping loader rejects those.
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  static from(stream: ReadableStream<Uint8Array>) {
    return new ByteStream(stream.getReader());
  }

  /** Next chunk of at most `limit` bytes, or null at end of stream. */
  async next(limit = Infinity): Promise<Uint8Array | null> {
    let chunk = this.pending;
    this.pending = null;
    while (!chunk) {
      if (this.ended) return null;
      const { done, value } = await this.reader.read();
      if (done) {
        this.ended = true;
        return null;
      }
      if (value && value.byteLength > 0) chunk = value;
    }
    if (chunk.byteLength > limit) {
      this.pending = chunk.subarray(limit);
      chunk = chunk.subarray(0, limit);
    }
    this.position += chunk.byteLength;
    return chunk;
  }

  /** Exactly `count` bytes, copied into a fresh buffer. */
  async exact(count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = await this.next(count - filled);
      if (!chunk) throw new Error(`Truncated stream: wanted ${count} bytes, got ${filled}`);
      out.set(chunk, filled);
      filled += chunk.byteLength;
    }
    return out;
  }

  /** Discard bytes until `position` reaches `offset`. */
  async skipTo(offset: number): Promise<void> {
    if (offset < this.position) throw new Error(`Cannot rewind stream to ${offset} from ${this.position}`);
    while (this.position < offset) {
      const chunk = await this.next(offset - this.position);
      if (!chunk) throw new Error(`Truncated stream: wanted offset ${offset}, ended at ${this.position}`);
    }
  }

  async cancel(): Promise<void> {
    this.pending = null;
    this.ended = true;
    await this.reader.cancel().catch(() => {});
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  const limit = haystack.length - needle.length;
  outer: for (let start = 0; start <= limit; start++) {
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) continue outer;
    }
    return start;
  }
  return -1;
}

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** ustar numeric field: octal ASCII, or base-256 when the high bit is set. */
function tarNumber(field: Uint8Array): number {
  if ((field[0] & 0x80) !== 0) {
    let value = 0;
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
    return value;
  }
  const text = cString(field).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`Malformed tar numeric field: ${JSON.stringify(text)}`);
  return value;
}

/**
 * Advance to the file data of `wanted` and return its size. Non-matching
 * entries — including pax/global headers, which carry a non-regular typeflag —
 * are skipped without being buffered.
 */
async function openTarEntry(stream: ByteStream, wanted: string): Promise<number> {
  for (;;) {
    const header = await stream.exact(TAR_BLOCK);
    if (header.every((byte) => byte === 0)) throw new Error(`Tar entry ${wanted} not found`);
    const prefix = cString(header.subarray(345, 500));
    const name = prefix ? `${prefix}/${cString(header.subarray(0, 100))}` : cString(header.subarray(0, 100));
    const size = tarNumber(header.subarray(124, 136));
    const typeFlag = header[156];
    const isFile = typeFlag === 0 || typeFlag === 0x30; // '\0' or '0'
    if (isFile && name === wanted) return size;
    await stream.skipTo(stream.position + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK);
  }
}

// ---------------------------------------------------------------------------
// Mach-O
// ---------------------------------------------------------------------------

export type BunSection = { offset: number; size: number };

/**
 * Locate `__BUN,__bun` by reading only the Mach-O header and load commands.
 * `base` is the stream offset at which the executable starts; the returned
 * offset is relative to that.
 */
async function readBunSection(stream: ByteStream, base: number): Promise<BunSection> {
  const header = await stream.exact(32);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0, true);
  if (view.getUint32(0, false) === FAT_MAGIC || view.getUint32(0, false) === FAT_MAGIC_64) {
    throw new Error("Universal (FAT) Mach-O binaries are not supported");
  }
  if (magic === MH_MAGIC_32) throw new Error("32-bit Mach-O binaries are not supported");
  if (magic !== MH_MAGIC_64) throw new Error(`Not a 64-bit Mach-O executable (magic 0x${magic.toString(16)})`);

  const commandCount = view.getUint32(16, true);
  const commandsSize = view.getUint32(20, true);
  const commands = await stream.exact(commandsSize);
  const commandsView = new DataView(commands.buffer, commands.byteOffset, commands.byteLength);

  let cursor = 0;
  for (let index = 0; index < commandCount && cursor + 8 <= commandsSize; index++) {
    const command = commandsView.getUint32(cursor, true);
    const commandSize = commandsView.getUint32(cursor + 4, true);
    if (commandSize < 8 || cursor + commandSize > commandsSize) throw new Error("Malformed Mach-O load command");
    if (command === LC_SEGMENT_64) {
      const sectionCount = commandsView.getUint32(cursor + 64, true);
      for (let section = 0; section < sectionCount; section++) {
        const at = cursor + 72 + section * 80;
        if (at + 80 > cursor + commandSize) throw new Error("Malformed Mach-O section table");
        const sectionName = cString(commands.subarray(at, at + 16));
        const segmentName = cString(commands.subarray(at + 16, at + 32));
        if (sectionName === "__bun" && segmentName === "__BUN") {
          const size = Number(commandsView.getBigUint64(at + 40, true));
          const offset = commandsView.getUint32(at + 48, true);
          if (size === 0) throw new Error("Empty __BUN,__bun section");
          return { offset, size };
        }
      }
    }
    cursor += commandSize;
  }
  // Keep `base` in the message: it is the only clue about which stream offset
  // the failed parse started from.
  throw new Error(`Could not find __BUN,__bun section (executable started at offset ${base})`);
}

// ---------------------------------------------------------------------------
// Bundle extraction
// ---------------------------------------------------------------------------

/**
 * Read the JavaScript bundle out of the section: everything from the first
 * `// @bun` marker up to the NUL that terminates it. Both boundaries match
 * unbuned.py's Mach-O path.
 */
async function readBunJs(stream: ByteStream, base: number, section: BunSection): Promise<Uint8Array> {
  const marker = new TextEncoder().encode(BUN_JS_MARKER);
  const start = base + section.offset;
  const end = start + section.size;
  await stream.skipTo(start);

  const parts: Uint8Array[] = [];
  let total = 0;
  let carry = new Uint8Array(0);
  let scanning = true;

  while (stream.position < end) {
    const chunk = await stream.next(end - stream.position);
    if (!chunk) throw new Error("Truncated __BUN,__bun section");

    let tail: Uint8Array | null = null;
    if (scanning) {
      const hit = indexOfBytes(chunk, marker);
      if (hit !== -1) {
        tail = chunk.subarray(hit);
      } else if (carry.byteLength > 0) {
        // The marker may straddle the chunk boundary; a full marker cannot fit
        // in the carried bytes alone, so only the bridge needs re-checking.
        const overlap = Math.min(chunk.byteLength, marker.byteLength - 1);
        const bridge = concatBytes([carry, chunk.subarray(0, overlap)], carry.byteLength + overlap);
        const bridged = indexOfBytes(bridge, marker);
        if (bridged !== -1) {
          tail = concatBytes(
            [bridge.subarray(bridged), chunk.subarray(overlap)],
            bridge.byteLength - bridged + chunk.byteLength - overlap,
          );
        }
      }
      if (!tail) {
        carry = chunk.subarray(Math.max(0, chunk.byteLength - (marker.byteLength - 1)));
        continue;
      }
      scanning = false;
    } else {
      tail = chunk;
    }

    const terminator = tail.indexOf(0);
    if (terminator !== -1) {
      const last = tail.subarray(0, terminator);
      parts.push(last);
      total += last.byteLength;
      return concatBytes(parts, total);
    }
    // These are views over per-chunk buffers the stream never reuses, so
    // retaining them holds ~23 MB rather than the 280 MB executable.
    parts.push(tail);
    total += tail.byteLength;
  }

  if (scanning) throw new Error(`Could not find ${BUN_JS_MARKER} marker in __BUN,__bun section`);
  throw new Error("Unterminated JavaScript bundle in __BUN,__bun section");
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/**
 * Port of nanovm_poc/claude-node/boot.mjs: Bun's loader invokes the trailing
 * IIFE, Node/Nodepod does not, so call it with the CommonJS wrapper arguments.
 */
export function applyBootPatch(code: string): string {
  const signature = "ZhS();})";
  if (!code.includes(signature)) throw new Error("Unexpected claude.js tail: boot signature not found");
  return code.replace(signature, "ZhS();})(exports, require, module, __filename, __dirname);");
}

/** Port of nodepod_wasm_wip/scripts/lib/patch-claude-source.mjs. */
export function patchClaudeSource(code: string): string {
  // Targeted patch for AbortController helper:
  //   Uxu=require("events"); ... Uxu.setMaxListeners(e, t.signal)
  if (code.includes('Uxu=require("events")') && !code.includes("Uxu.__nodepodSetMaxListenersPatched")) {
    code = code.replace(
      'Uxu=require("events")',
      'Uxu=require("events");Uxu.__nodepodSetMaxListenersPatched=1;if(typeof Uxu.setMaxListeners!=="function")Uxu.setMaxListeners=function(n,...t){if(!t.length){try{Uxu.defaultMaxListeners=n}catch{}}for(const x of t){if(x&&typeof x.setMaxListeners==="function")x.setMaxListeners(n)}}',
    );
  }

  // Prompt inputs pass preserveTrailingWhitespace:o where o = isScreenReaderEnabled
  // (false here), so V.render trims a trailing space from the visible line. A
  // trailing-space-only edit then diffs to zero ops and the cursor never moves
  // until the next non-whitespace char. Force preserve for the prompt input
  // hooks (na = main prompt, XOf = vim-mode prompt) so the cursor tracks a
  // typed/backspaced trailing space immediately. Replaces the flag with a
  // literal truthy value; naturally idempotent (no 'preserveTrailingWhitespace:o'
  // left to match on a second run).
  if (code.includes("preserveTrailingWhitespace:o")) {
    code = code.replaceAll("preserveTrailingWhitespace:o", "preserveTrailingWhitespace:1");
  }

  // wrap-ansi drops whitespace at the end of its source even with trim:false,
  // so Nd cannot measure or paint the accepted trailing cells. A temporary
  // cursor-cell sentinel makes those spaces interior and preserves wrapping;
  // remove it before constructing the measured lines.
  const measuredTextWrap = "measureWrappedText(){let e=U3(this.text,this.columns,{hard:!0,trim:!1}),t=[]";
  if (code.includes(measuredTextWrap)) {
    code = code.replace(
      measuredTextWrap,
      'measureWrappedText(){let NPW="x",e=U3(this.text+NPW,this.columns,{hard:!0,trim:!1});if(e.endsWith(NPW))e=e.slice(0,-NPW.length);let t=[]',
    );
  }

  // Nodepod's keyboard callbacks run outside React's event system. The text
  // store can render before cursor offset state commits, so synchronously flush
  // one local update after Claude applies its existing offset setter.
  const inputStateHook = "[F]=$Yp.useState(LYp),W=";
  const inputUpdate =
    'if(Re.preventDefault(),!V.equals(qe)){if(V.text!==qe.text){if(V.text!==""&&qe.text==="")F.editedEmptyAtMs=Date.now();t(qe.text)}j(qe.offset),V=qe}';
  if (!code.includes("[,NPF]=$Yp.useReducer") && code.includes(inputStateHook) && code.includes(inputUpdate)) {
    code = code.replace(inputStateHook, "[F]=$Yp.useState(LYp),[,NPF]=$Yp.useReducer((e)=>e+1,0),W=");
    code = code.replace(
      inputUpdate,
      'if(Re.preventDefault(),!V.equals(qe)){if(V.text!==qe.text){if(V.text!==""&&qe.text==="")F.editedEmptyAtMs=Date.now();t(qe.text)}V=qe,zLe.flushSyncFromReconciler(()=>{j(qe.offset),NPF()})}',
    );
  }

  // Claude normally redirects Bash output to numeric file descriptors and then
  // rereads that file. Nodepod exposes those descriptors as pipes instead, so
  // the file stays empty even though child.stdout has the command output. Force
  // Claude's existing piped-output path in the Nodepod-specific bundle.
  const bashOutputMode = 'G=await m.getEnvironmentOverrides(e,u),U=!!c,F=r$("local_bash")';
  if (code.includes(bashOutputMode)) {
    code = code.replace(
      bashOutputMode,
      'G=await m.getEnvironmentOverrides(e,u),U=!0/*NODEPOD_BASH_PIPE_OUTPUT_PATCHED*/,F=r$("local_bash")',
    );
  }

  // A cold Mithic process can take longer than Claude's native 1s shell probe
  // inside Nodepod. Keep validation enabled, but allow the WASM-backed shell to
  // start before Claude concludes that no POSIX shell exists.
  const shellValidation = 'cn(e,["--version"],{timeout:1000,useCwd:!1})';
  if (code.includes(shellValidation)) {
    code = code.replace(
      shellValidation,
      'cn(e,["--version"],{timeout:10000/*NODEPOD_SHELL_TIMEOUT_PATCHED*/,useCwd:!1})',
    );
  }

  return code;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Report progress off the compressed side, where content-length is known.
 * Unpacking is interleaved with the transfer rather than following it, so one
 * download label covers the whole stream.
 */
function progressTap(totalBytes: number, report: BundleReport): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  let reportedAt = 0;
  const step = 4 * 1024 * 1024;
  const mb = (value: number) => Math.round(value / (1024 * 1024));
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen - reportedAt >= step) {
        reportedAt = seen;
        report(
          totalBytes > 0
            ? `Downloading Claude runtime ${mb(seen)}/${mb(totalBytes)} MB`
            : `Downloading Claude runtime ${mb(seen)} MB`,
        );
      }
      controller.enqueue(chunk);
    },
  });
}

/** Fetch, unpack and patch — no caching. Exported for the smoke test. */
export async function deriveClaudeBundle(options: LoadClaudeBundleOptions = {}): Promise<Uint8Array> {
  const url = options.tarballUrl ?? CLAUDE_TARBALL_URL;
  const entryName = options.entryName ?? CLAUDE_TAR_ENTRY;
  const report = options.report ?? (() => {});

  report("Downloading Claude runtime");
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
  if (!response.body) throw new Error(`${url} returned no body`);

  const totalBytes = Number(response.headers.get("content-length") ?? 0);
  const stream = ByteStream.from(
    response.body.pipeThrough(progressTap(totalBytes, report)).pipeThrough(new DecompressionStream("gzip")),
  );

  let source: string;
  try {
    await openTarEntry(stream, entryName);
    const base = stream.position;
    const section = await readBunSection(stream, base);
    const js = await readBunJs(stream, base, section);
    source = new TextDecoder().decode(js);
  } finally {
    // The bundle ends well before the executable does; stop the transfer.
    await stream.cancel();
  }

  report("Patching Claude runtime");
  return new TextEncoder().encode(patchClaudeSource(applyBootPatch(source)));
}

/**
 * The patched bundle, derived from the published npm tarball on first use and
 * kept in Cache Storage afterwards. The cache is content-addressed by the
 * pinned digest, so bumping the version or a patch naturally misses.
 */
export async function loadClaudeBundle(options: LoadClaudeBundleOptions = {}): Promise<Uint8Array> {
  const report = options.report ?? (() => {});
  const expected = options.expectedSha256 === undefined ? CLAUDE_BUNDLE_SHA256 : options.expectedSha256;
  // Without a pinned digest a cached entry cannot be validated, so unpinned
  // callers (re-pinning a new version) always re-derive.
  const useCache = expected !== null && options.cache !== false && typeof caches !== "undefined";
  const cacheKey = `https://claude-bundle.riff.invalid/${expected}.js`;
  const cache = useCache ? await caches.open(CACHE_NAME).catch(() => null) : null;

  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if ((await digestHex(bytes)) === expected) {
        report("Loaded Claude runtime from cache");
        return bytes;
      }
      await cache.delete(cacheKey).catch(() => undefined);
    }
  }

  const bytes = await deriveClaudeBundle(options);
  const digest = await digestHex(bytes);
  if (expected && digest !== expected) {
    throw new Error(`Claude bundle digest mismatch: expected ${expected}, got ${digest}`);
  }

  if (cache) {
    await cache.put(cacheKey, new Response(bytes)).catch(() => undefined);
    // Drop bundles from older versions/patch revisions so the cache stays at
    // one entry rather than growing by 23 MB per bump.
    for (const request of await cache.keys().catch(() => [])) {
      if (request.url !== cacheKey) await cache.delete(request).catch(() => undefined);
    }
  }
  return bytes;
}
