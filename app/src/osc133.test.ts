import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Osc133Parser } from "./osc133.ts";

describe("Osc133Parser", () => {
  test("recognises split BEL and ST terminated markers", () => {
    const parser = new Osc133Parser();
    assert.deepEqual(parser.push(new TextEncoder().encode("text\x1b]13")), []);
    assert.deepEqual(parser.push(new TextEncoder().encode("3;D;")), []);
    assert.deepEqual(parser.push(new TextEncoder().encode("17\x07x\x1b]133;A\x1b\\")), [
      { code: "D", exitCode: 17 },
      { code: "A" },
    ]);
  });

  test("ignores unrelated OSC payloads", () => {
    const parser = new Osc133Parser();
    assert.deepEqual(parser.push(new TextEncoder().encode("\x1b]9;ignored\x07\x1b]133;B\x07")), [{ code: "B" }]);
  });
});
