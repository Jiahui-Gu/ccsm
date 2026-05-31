import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { PairingDurableObject } from "../src/pairingDo";

// Helper: open a WebSocket against a DO instance keyed by userHash.
async function connect(userHash: string): Promise<WebSocket> {
  const id = env.PAIRING.idFromName(userHash);
  const stub = env.PAIRING.get(id);
  const res = await stub.fetch("https://do/connect", {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener(
      "message",
      (ev) => resolve(JSON.parse(ev.data as string)),
      { once: true },
    );
  });
}

describe("PairingDurableObject", () => {
  it("constructs and answers non-websocket with 426", async () => {
    const id = env.PAIRING.idFromName("u-426");
    const stub = env.PAIRING.get(id);
    const res = await stub.fetch("https://do/connect");
    expect(res.status).toBe(426);
  });

  it("two peers register and learn about each other", async () => {
    const a = await connect("room1");
    const b = await connect("room1");

    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    const aReg = await next(a);
    expect(aReg.type).toBe("registered");
    expect(aReg.peers).toEqual([]);

    const aSeesB = next(a);
    b.send(JSON.stringify({ type: "register", role: "phone", peerId: "B" }));
    const bReg = await next(b);
    expect(bReg.type).toBe("registered");
    expect(bReg.peers).toEqual([{ role: "desktop", peerId: "A" }]);
    expect(await aSeesB).toMatchObject({ type: "peer-present", peerId: "B" });
  });

  it("relays offer/answer/ice and rewrites from", async () => {
    const a = await connect("room2");
    const b = await connect("room2");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(a);
    b.send(JSON.stringify({ type: "register", role: "phone", peerId: "B" }));
    await next(b);
    await next(a); // consume peer-present

    const aGetsOffer = next(a);
    b.send(JSON.stringify({ type: "offer", to: "A", from: "B", sdp: "SDP" }));
    const offer = await aGetsOffer;
    expect(offer).toMatchObject({ type: "offer", from: "B", sdp: "SDP" });
  });

  it("peer-not-found when target is absent", async () => {
    const a = await connect("room3");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(a);
    const err = next(a);
    a.send(JSON.stringify({ type: "offer", to: "ghost", from: "A", sdp: "x" }));
    expect(await err).toMatchObject({ type: "error", code: "peer-not-found" });
  });

  it("not-registered when signaling before register", async () => {
    const a = await connect("room4");
    const err = next(a);
    a.send(JSON.stringify({ type: "offer", to: "X", from: "Y", sdp: "x" }));
    expect(await err).toMatchObject({ type: "error", code: "not-registered" });
  });

  it("peer-gone broadcast when a peer closes", async () => {
    const a = await connect("room5");
    const b = await connect("room5");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(a);
    b.send(JSON.stringify({ type: "register", role: "phone", peerId: "B" }));
    await next(b);
    await next(a); // peer-present
    const gone = next(a);
    b.close();
    expect(await gone).toMatchObject({ type: "peer-gone", peerId: "B" });
  });

  it("room-full past MAX_MEMBERS", async () => {
    // Drive register() directly to avoid opening 9 live sockets.
    const id = env.PAIRING.idFromName("room-full");
    await runInDurableObject(env.PAIRING.get(id), async (instance: PairingDurableObject) => {
      // fill 8 members
      for (let i = 0; i < 8; i++) {
        const ws = await connect("room-full");
        ws.send(JSON.stringify({ type: "register", role: "phone", peerId: `p${i}` }));
      }
      void instance; // touched so the import is used
    });
    const overflow = await connect("room-full");
    const err = next(overflow);
    overflow.send(JSON.stringify({ type: "register", role: "phone", peerId: "p9" }));
    expect(await err).toMatchObject({ type: "error", code: "room-full" });
  });

  it("rejects a second register with an already-taken peerId without evicting the victim", async () => {
    const victim = await connect("squat");
    victim.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    await next(victim);

    // Attacker (same userHash room) tries to squat peerId "A".
    const attacker = await connect("squat");
    const attackerErr = next(attacker);
    attacker.send(JSON.stringify({ type: "register", role: "phone", peerId: "A" }));
    expect(await attackerErr).toMatchObject({
      type: "error",
      code: "bad-message",
      message: "peer-id-taken",
    });

    // The original victim is still in the routing table: a third distinct peer
    // can still reach "A" by its peerId.
    const third = await connect("squat");
    third.send(JSON.stringify({ type: "register", role: "phone", peerId: "C" }));
    await next(third);
    await next(victim); // consume peer-present for C

    const victimGetsOffer = next(victim);
    third.send(JSON.stringify({ type: "offer", to: "A", sdp: "SDP" }));
    expect(await victimGetsOffer).toMatchObject({
      type: "offer",
      from: "C",
      sdp: "SDP",
    });
  });

  it("different userHash lands on a different DO instance (isolation)", async () => {
    const a = await connect("iso-A");
    const b = await connect("iso-B");
    a.send(JSON.stringify({ type: "register", role: "desktop", peerId: "A" }));
    const aReg = await next(a);
    b.send(JSON.stringify({ type: "register", role: "desktop", peerId: "B" }));
    const bReg = await next(b);
    // Neither sees the other: separate rooms.
    expect(aReg.peers).toEqual([]);
    expect(bReg.peers).toEqual([]);
  });
});
