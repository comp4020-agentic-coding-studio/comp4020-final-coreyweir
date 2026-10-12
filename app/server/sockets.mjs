// Closing a socket from the server's side. ws sends a close frame and then
// waits (up to 30s) for the TCP connection to end; behind nginx and fly's
// proxy the client was left in CLOSING for seconds, never told it had been
// shut out. So after the close frame, give the handshake a moment, then
// drop the connection outright.
const GRACE_MS = 500;

export function hangUp(websocket, code, reason) {
  websocket.close(code, reason);
  setTimeout(() => websocket.terminate(), GRACE_MS).unref?.();
}
