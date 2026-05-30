import type { Env, Config } from "./lib/config";
import { loadConfig } from "./lib/config";

const MAX_MEMBERS = 8;

interface Member {
  ws: WebSocket;
  role: "desktop" | "phone";
  peerId: string;
}

type ErrCode = "bad-message" | "not-registered" | "peer-not-found" | "room-full";

export class PairingDurableObject {
  private members = new Map<string, Member>();
  private state: DurableObjectState;
  private cfg: Config;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.cfg = loadConfig(env);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.wireSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendErr(ws: WebSocket, code: ErrCode, message: string): void {
    ws.send(JSON.stringify({ type: "error", code, message }));
  }

  private broadcastExcept(exceptPeerId: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const m of this.members.values()) {
      if (m.peerId !== exceptPeerId) m.ws.send(data);
    }
  }

  private wireSocket(ws: WebSocket): void {
    let self: Member | null = null;

    ws.addEventListener("message", (ev) => {
      let msg: { type?: string; role?: string; peerId?: string; to?: string };
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return this.sendErr(ws, "bad-message", "invalid json");
      }

      if (msg.type === "register") {
        if (self) return this.sendErr(ws, "bad-message", "already registered");
        if (msg.role !== "desktop" && msg.role !== "phone") {
          return this.sendErr(ws, "bad-message", "bad role");
        }
        if (typeof msg.peerId !== "string" || !msg.peerId) {
          return this.sendErr(ws, "bad-message", "bad peerId");
        }
        if (this.members.size >= MAX_MEMBERS) {
          return this.sendErr(ws, "room-full", "too many peers");
        }
        self = { ws, role: msg.role, peerId: msg.peerId };
        this.members.set(self.peerId, self);
        ws.send(
          JSON.stringify({
            type: "registered",
            peerId: self.peerId,
            peers: [...this.members.values()]
              .filter((m) => m.peerId !== self!.peerId)
              .map((m) => ({ role: m.role, peerId: m.peerId })),
          }),
        );
        this.broadcastExcept(self.peerId, {
          type: "peer-present",
          role: self.role,
          peerId: self.peerId,
        });
        return;
      }

      if (!self) return this.sendErr(ws, "not-registered", "register first");

      if (msg.type === "offer" || msg.type === "answer" || msg.type === "ice") {
        const target = msg.to ? this.members.get(msg.to) : undefined;
        if (!target) return this.sendErr(ws, "peer-not-found", `no peer ${msg.to}`);
        target.ws.send(JSON.stringify({ ...msg, from: self.peerId }));
        return;
      }

      this.sendErr(ws, "bad-message", `unknown type ${msg.type}`);
    });

    ws.addEventListener("close", () => {
      if (!self) return;
      this.members.delete(self.peerId);
      this.broadcastExcept(self.peerId, {
        type: "peer-gone",
        role: self.role,
        peerId: self.peerId,
      });
      this.scheduleRoomGc();
    });
  }

  private scheduleRoomGc(): void {
    if (this.members.size === 0) {
      void this.state.storage.setAlarm(Date.now() + this.cfg.roomTtlMs);
    }
  }

  async alarm(): Promise<void> {
    // members empty -> no-op; an idle DO instance is reclaimed by the platform.
  }
}
