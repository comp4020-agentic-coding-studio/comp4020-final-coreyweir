import assert from "node:assert/strict";
import test from "node:test";
import { wrapNote } from "./terminalWrap.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const SUMMARY = "Saved in this browser: everything under /work and /home/user, node_modules and .git included. Not saved: /tmp and the rest of the filesystem, Claude's settings, and bash's tools (the boot writes those fresh).";

test("wraps at spaces, never past the width, with the words intact", () => {
  for (const cols of [20, 41, 47, 80]) {
    const wrapped = strip(wrapNote(SUMMARY, cols));
    for (const line of wrapped.split("\n")) assert.ok(line.length <= cols, `${cols}: "${line}" is ${line.length}`);
    assert.equal(wrapped.split("\n").join(" "), SUMMARY, `${cols}: same words, one space where each break is`);
  }
});

test("escapes take no columns and survive", () => {
  const note = `\x1b[38;5;244m${SUMMARY}\x1b[0m`;
  const wrapped = wrapNote(note, 41);
  assert.ok(wrapped.startsWith("\x1b[38;5;244m") && wrapped.endsWith("\x1b[0m"));
  assert.equal(strip(wrapped), strip(wrapNote(SUMMARY, 41)));
});

test("a short line, a narrow terminal and a long word are left alone", () => {
  assert.equal(wrapNote("Cloning into /work/repo...", 80), "Cloning into /work/repo...");
  assert.equal(wrapNote(SUMMARY, 5), SUMMARY);
  const url = "https://github.com/some-organisation/a-very-long-repository-name.git";
  assert.deepEqual(strip(wrapNote(`Not cloned: ${url} isn't here`, 30)).split("\n"), ["Not cloned:", url, "isn't here"]);
});
