// Each person's colour in a room (their avatar, and their name on the
// board). Corey (8 Nov): two people shouldn't share one while there's a
// colour nobody present has. On joining, a browser takes the colour the
// fewest people in the room are showing, a random one of those on a tie,
// and keeps it for that room after (localStorage, per room), so it doesn't
// change under people mid-crit.
export const COLOURS = ["#315efb", "#b35642", "#39775d", "#8156a4", "#a16c17"];

/** The least-used colour among `taken` (others' colours), ties at random. */
export function pickColour(taken: string[], random = Math.random) {
  const counts = new Map(COLOURS.map((colour) => [colour, 0]));
  for (const colour of taken) if (counts.has(colour)) counts.set(colour, counts.get(colour)! + 1);
  const fewest = Math.min(...counts.values());
  const least = COLOURS.filter((colour) => counts.get(colour) === fewest);
  return least[Math.floor(random() * least.length)];
}

const key = (roomId: string) => `riff-colour:${roomId}`;

export function storedColour(roomId: string) {
  try {
    const colour = localStorage.getItem(key(roomId));
    return colour && COLOURS.includes(colour) ? colour : null;
  } catch {
    return null;
  }
}

export function storeColour(roomId: string, colour: string) {
  try {
    localStorage.setItem(key(roomId), colour);
  } catch {
    // kept for this page only
  }
}

/** With this browser's place in the room (api.ts forget). */
export function forgetColour(roomId: string) {
  try {
    localStorage.removeItem(key(roomId));
  } catch {
    // nothing stored
  }
}
