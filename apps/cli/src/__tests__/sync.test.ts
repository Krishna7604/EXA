import { describe, expect, test } from "bun:test";
import { canonicalJson, makeEvent, newId, type PolicyBundle } from "@exa/protocol";
import { ExaApi } from "../services/api.service.ts";
import { EventForwarder } from "../sync/event-forwarder.ts";
import { LeaseKeeper } from "../sync/lease-keeper.ts";
import { MirrorStore } from "../sync/mirror-store.ts";
import { verifyPolicy } from "../sync/verify-policy.ts";

function fakeApi() {
  const calls: Array<{ path: string; body: any }> = [];
  const fetchFn = (async (url: any, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path.endsWith("/lease")) return Response.json({ fencing: 7, ttlMs: 60000 });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return { api: new ExaApi("http://srv", "exa_tok", fetchFn), calls };
}

describe("cli sync", () => {
  test("policy signature verification (Ed25519 over canonical JSON)", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
    const bundle: PolicyBundle = {
      tenantId: "t",
      version: 1,
      issuedAt: 1,
      expiresAt: 2,
      rules: [],
      settings: { b: 1, a: 2 },
      serverChecked: ["bash"],
    };
    const sig = Buffer.from(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        kp.privateKey,
        new TextEncoder().encode(canonicalJson(bundle)),
      ),
    ).toString("base64");
    expect(await verifyPolicy({ bundle, signature: sig, keyId: "k" }, pub)).toBe(true);
    expect(
      await verifyPolicy(
        { bundle: { ...bundle, serverChecked: [] }, signature: sig, keyId: "k" },
        pub,
      ),
    ).toBe(false);
    expect(
      await verifyPolicy(
        { bundle, signature: sig, keyId: "k" },
        Buffer.alloc(32).toString("base64"),
      ),
    ).toBe(false);
  });

  test("forwarder coalesces deltas, tags child-session events, mirrors steps with the fencing token", async () => {
    const { api, calls } = fakeApi();
    const root = newId();
    const child = newId();
    const lease = new LeaseKeeper(api, root);
    await lease.acquire();
    const fwd = new EventForwarder(api, root, lease, { intervalMs: 5 });
    for (const d of ["Hel", "lo", " world"])
      fwd.publish(
        makeEvent("message.part.delta", root, {
          messageId: "m",
          partId: "p",
          field: "text",
          delta: d,
        }),
      );
    fwd.publish(makeEvent("session.status", child, { status: "busy" }));
    fwd.publish(makeEvent("session.abort", root, { by: "x" })); // server-originated: not echoed back
    const store = new MirrorStore(fwd);
    const info = {
      id: newId(),
      sessionId: root,
      parentId: null,
      role: "user" as const,
      agent: "build",
      model: "exa",
      time: { created: 1 },
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    };
    await store.putMessage(info);
    await store.putParts([
      { type: "text", id: newId(), messageId: info.id, sessionId: root, text: "hi" },
    ]);
    await fwd.flush();
    const ingest = calls.filter((c) => c.path.endsWith("/ingest"));
    expect(ingest.length).toBe(1);
    const body = ingest[0].body;
    expect(body.fencing).toBe(7);
    expect(body.events.length).toBe(2);
    expect(body.events[0].data.delta).toBe("Hello world");
    expect(body.events[1].sessionId).toBe(child);
    expect(body.persist[0].parts[0].text).toBe("hi");
    await lease.release();
    expect(calls.at(-1)!.body).toMatchObject({ action: "release", fencing: 7 });
  });

  test("failed sends keep content mirrors for retry", async () => {
    let fail = true;
    const sent: any[] = [];
    const fetchFn = (async (url: any, init?: RequestInit) => {
      if (String(url).endsWith("/lease")) return Response.json({ fencing: 1 });
      if (fail) return Response.json({ error: { code: "x", message: "down" } }, { status: 503 });
      sent.push(JSON.parse(String(init!.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const api = new ExaApi("http://srv", "t", fetchFn);
    const root = newId();
    const lease = new LeaseKeeper(api, root);
    await lease.acquire();
    const fwd = new EventForwarder(api, root, lease, { intervalMs: 1000 });
    const store = new MirrorStore(fwd);
    const info = {
      id: newId(),
      sessionId: root,
      parentId: null,
      role: "user" as const,
      agent: "build",
      model: "exa",
      time: { created: 1 },
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    };
    await store.putMessage(info);
    await fwd.flush();
    expect(fwd.failures).toBe(1);
    fail = false;
    await fwd.flush();
    expect(sent[0].persist[0].info.id).toBe(info.id);
    await lease.release();
  });
});
