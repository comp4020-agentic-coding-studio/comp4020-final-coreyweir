import assert from "node:assert/strict";
import test from "node:test";
import { COLOURS, pickColour } from "./colours.ts";

test("takes a colour nobody present has", () => {
  for (let index = 0; index < 50; index++) {
    const taken = COLOURS.slice(0, 4);
    assert.equal(pickColour(taken), COLOURS[4]);
  }
});

test("everyone different while there are colours to go round", () => {
  const room: string[] = [];
  for (let index = 0; index < COLOURS.length; index++) room.push(pickColour(room));
  assert.deepEqual([...room].sort(), [...COLOURS].sort());
});

test("past five, the least used; ties at random; unknown colours ignored", () => {
  const taken = [...COLOURS, COLOURS[0], COLOURS[1], "#999999"];
  const seen = new Set<string>();
  for (let index = 0; index < 200; index++) seen.add(pickColour(taken));
  assert.deepEqual([...seen].sort(), COLOURS.slice(2).sort());
  assert.equal(pickColour([], () => 0), COLOURS[0]);
  assert.equal(pickColour([], () => 0.999), COLOURS[4]);
});
