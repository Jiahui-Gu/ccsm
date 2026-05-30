/** The minimal, transport-agnostic surface the terminal protocol needs from a
 *  connected client. Both the LAN WebSocket server (`WsClient`) and the WebRTC
 *  DataChannel peer satisfy this — `handleClientMessage` and the pty.data
 *  fan-out depend ONLY on these two members, so the same protocol core serves
 *  both pipes (detail spec §6 "swap the pipe, keep the protocol"). */
export type PeerClient = {
  /** The single session id this client is viewing, set on `session.snapshot`.
   *  The pty.data fan-out forwards a session's bytes only to clients whose
   *  `subscribedSid` matches — without it every client gets every session's raw
   *  output (cross-session leak). `null` = not subscribed yet. */
  subscribedSid: string | null;
  send: (payload: unknown) => void;
};
