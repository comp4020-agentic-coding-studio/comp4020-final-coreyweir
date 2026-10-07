#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { bootClaudePod } from "../../../nodepod_wasm_wip/scripts/lib/claude-pod.mjs";

const hasCredentials =
  process.env.ANTHROPIC_API_KEY ||
  (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN);

if (!hasCredentials) {
  console.error(
    "Set ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, before running test:claude-stream.",
  );
  process.exit(1);
}

const marker = `RIFF_${randomUUID().slice(0, 8)}`;
const sessionId = randomUUID();
const firstPrompt = `Remember this marker: ${marker}. Reply only with READY.`;
const pod = await bootClaudePod();
let proc;

try {
  proc = await pod.spawn(
    "node",
    [
      "/opt/claude/run.cjs",
      "-p",
      firstPrompt,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--include-hook-events",
      "--replay-user-messages",
      "--session-id",
      sessionId,
      "--permission-mode",
      "dontAsk",
    ],
    { cwd: "/work/repo" },
  );

  const events = [];
  const pendingResults = [];
  let stdoutBuffer = "";
  let stderr = "";

  function rejectPending(error) {
    while (pendingResults.length > 0) pendingResults.shift().reject(error);
  }

  function handleLine(line) {
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`Claude emitted non-JSON stdout: ${line.slice(0, 240)}`);
    }

    events.push(event);
    if (event.type === "result") pendingResults.shift()?.resolve(event);
  }

  proc.on("output", (chunk) => {
    try {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    } catch (error) {
      rejectPending(error);
      proc.kill();
    }
  });
  proc.on("error", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
    if (/Worker error:/i.test(chunk)) {
      rejectPending(new Error(`Claude worker failed: ${chunk.trim()}`));
      proc.kill();
    }
  });
  proc.on("exit", (code) => {
    rejectPending(new Error(`Claude exited with code ${code}. stderr: ${stderr.slice(-500)}`));
  });

  function nextResult(timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for Claude result. stderr: ${stderr.slice(-500)}`));
      }, timeoutMs);

      pendingResults.push({
        resolve(event) {
          clearTimeout(timeout);
          resolve(event);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  function send(text) {
    proc.write(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    })}\n`);
  }

  const firstResultPromise = nextResult();
  const first = await firstResultPromise;
  if (first.is_error) throw new Error(`First turn failed: ${JSON.stringify(first.errors ?? first)}`);

  const secondResultPromise = nextResult();
  send("Reply only with the exact marker I asked you to remember.");
  const second = await secondResultPromise;
  if (second.is_error) throw new Error(`Second turn failed: ${JSON.stringify(second.errors ?? second)}`);
  if (first.session_id !== second.session_id) {
    throw new Error(`Session changed between turns: ${first.session_id} -> ${second.session_id}`);
  }
  if (!JSON.stringify(second).includes(marker)) {
    throw new Error(`Second turn did not recall ${marker}: ${JSON.stringify(second)}`);
  }

  const eventCounts = new Map();
  for (const event of events) eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
  console.log(
    `[claude-stream] two turns shared session ${first.session_id}; events=${[...eventCounts]
      .map(([type, count]) => `${type}:${count}`)
      .join(",")}`,
  );
} finally {
  proc?.kill();
  pod.teardown();
}
