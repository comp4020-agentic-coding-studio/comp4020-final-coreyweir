// A host who has just created a room shouldn't have to find the Room tab
// and press Boot Claude before the ~79 MB download even starts (Corey, 8
// Nov): creating the room marks it, and the room's terminal boots Claude
// once, as if Boot Claude had been pressed. Only on create: a reload, or
// coming back to the room later, boots nothing by itself. sessionStorage,
// so the mark stays in the tab that created the room (and survives the
// GitHub sign-in round trip there), never in a link.
const KEY = "riff-auto-boot";

export function markAutoBoot(roomId: string) {
  try {
    sessionStorage.setItem(KEY, roomId);
  } catch {
    // no storage: the host presses Boot Claude, as before
  }
}

/** True once, for the room just created in this tab. */
export function takeAutoBoot(roomId: string) {
  try {
    if (sessionStorage.getItem(KEY) !== roomId) return false;
    sessionStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
