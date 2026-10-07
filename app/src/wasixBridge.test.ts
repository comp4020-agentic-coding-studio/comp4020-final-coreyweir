import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bridgeRootOf, bridgeServeAll, type BridgeHostHandler } from "./wasixBridge.ts";

/**
 * A BridgeIo that records which channel each write landed on and lets a test
 * feed request frames in. `channelOf` mirrors production: the channel comes
 * from the RIFF_BRIDGE_ROOT the stub was launched with.
 */
function fakeIo() {
  const queue: Uint8Array[] = [];
  let notify: (() => void) | null = null;
  const writes: { channel: string; pid: number; bytes: Uint8Array }[] = [];
  const opened: string[] = [];
  const io = {
    read: async () => {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) return next;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
    openResp: async (channel: string, pid: number) => {
      opened.push(`${channel}/${pid}`);
    },
    writeTo: async (channel: string, pid: number, bytes: Uint8Array) => {
      writes.push({ channel, pid, bytes });
    },
    channelOf: (r: { env: string[] }) => bridgeRootOf(r as never) ?? "/default",
  };
  const push = (frame: Uint8Array) => {
    queue.push(frame);
    notify?.();
    notify = null;
  };
  const request = (pid: number, root: string | null, argv: string[]) => {
    const body = new TextEncoder().encode(JSON.stringify({
      pid,
      cwd: "/work/repo",
      argv,
      env: root === null ? [] : [`RIFF_BRIDGE_ROOT=${root}`],
    }));
    const frame = new Uint8Array(5 + body.byteLength);
    new DataView(frame.buffer).setUint32(0, body.byteLength + 1, true);
    frame[4] = 0;
    frame.set(body, 5);
    push(frame);
  };
  return { io, writes, opened, request };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("bridge channels — concurrent commands must not share a response pipe", () => {
  test("the channel comes from the stub's RIFF_BRIDGE_ROOT", () => {
    assert.equal(
      bridgeRootOf({ pid: 1, cwd: "/", argv: [], env: ["PATH=/bin", "RIFF_BRIDGE_ROOT=/work/repo/.wasix-session/c/7"] }),
      "/work/repo/.wasix-session/c/7",
    );
    assert.equal(bridgeRootOf({ pid: 1, cwd: "/", argv: [], env: [] }), undefined);
  });

  // Every top-level instance starts its own process tree at pid 1, so two
  // concurrent commands hand out the same pids. Before channels existed both
  // stubs read the same pipe device: one got the other's exit frame and the
  // loser blocked forever.
  test("same pid on different channels runs concurrently and never crosses streams", async () => {
    const { io, writes, request } = fakeIo();
    const running = new Set<string>();
    let sawBothAtOnce = false;
    const release = new Map<string, () => void>();
    const handler: BridgeHostHandler = async (req, out) => {
      const tag = req.argv[0];
      running.add(tag);
      if (running.size === 2) sawBothAtOnce = true;
      await new Promise<void>((resolve) => release.set(tag, resolve));
      await out.writeStdout(new TextEncoder().encode(tag));
      running.delete(tag);
      return 0;
    };

    void bridgeServeAll(io as never, handler);
    request(1, "/work/repo/.wasix-session/c/1", ["one"]);
    request(1, "/work/repo/.wasix-session/c/2", ["two"]);
    await settle();
    await settle();

    assert.equal(sawBothAtOnce, true, "requests on different channels must not serialize");
    release.get("one")?.();
    release.get("two")?.();
    await settle();
    await settle();

    const decoder = new TextDecoder();
    const stdout = writes.filter((w) => w.bytes[4] === 1);
    const byChannel = new Map(stdout.map((w) => [w.channel, decoder.decode(w.bytes.slice(5))]));
    assert.equal(byChannel.get("/work/repo/.wasix-session/c/1"), "one");
    assert.equal(byChannel.get("/work/repo/.wasix-session/c/2"), "two");
  });

  // Within one command the pid really can repeat (a shell spawning `git`
  // twice), and those two guest processes do share a pipe path, so the host
  // must still serialize them.
  test("same pid on the same channel still serializes", async () => {
    const { io, request } = fakeIo();
    let concurrent = 0;
    let overlapped = false;
    const release: (() => void)[] = [];
    const handler: BridgeHostHandler = async () => {
      concurrent += 1;
      if (concurrent > 1) overlapped = true;
      await new Promise<void>((resolve) => release.push(resolve));
      concurrent -= 1;
      return 0;
    };

    void bridgeServeAll(io as never, handler);
    request(1, "/work/repo/.wasix-session/c/1", ["first"]);
    request(1, "/work/repo/.wasix-session/c/1", ["second"]);
    await settle();
    await settle();

    assert.equal(overlapped, false, "one pipe path cannot carry two conversations at once");
    while (release.length > 0) release.shift()?.();
  });
});
