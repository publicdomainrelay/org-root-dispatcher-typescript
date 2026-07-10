import { assertEquals } from "@std/assert";
import { createRelaySequencer } from "@publicdomainrelay/atproto-relay-xrpc";
import type { RelaySequencer, SubscribeReposFrame } from "@publicdomainrelay/atproto-relay-abc";
import { createRelayFactory } from "@publicdomainrelay/hono-factory-atproto-relay-xrpc";

const DID = "did:plc:firehosetestrelay0";
const RKEY = "3kabcrfprkey00";

function flatFrame(seq: number, collection: string): SubscribeReposFrame {
  return {
    $type: "com.atproto.sync.subscribeRepos#commit",
    seq,
    repo: DID,
    commit: { $link: "bafyreiboguscommit000000000000000000000000000000000000000" },
    rev: `3kabc${String(seq).padStart(3, "0")}rev0`,
    since: null,
    time: "2026-07-09T00:00:00.000Z",
    ops: [{ action: "create", path: `${collection}/${RKEY}`, cid: { $link: `bafyreirfpcidex${String(seq).padStart(3, "0")}0000` }, prev: null }],
    blocks: [] as unknown as Uint8Array,
  };
}

async function serveSubscribeRepos(sequencer: RelaySequencer): Promise<{ port: number; stop: () => void }> {
  const factory = createRelayFactory({ hostname: "localhost", sequencer });
  const ctl = new AbortController();
  const { promise: portReady, resolve: resolvePort } = Promise.withResolvers<number>();
  Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ctl.signal, onListen: (addr) => resolvePort((addr as Deno.NetAddr).port) }, factory.app.fetch);
  const port = await portReady;
  return { port, stop: () => ctl.abort() };
}

async function collectFrames(port: number, cursor?: number, timeoutMs = 500): Promise<unknown[]> {
  const frames: unknown[] = [];
  const url = cursor !== undefined
    ? `ws://127.0.0.1:${port}/xrpc/com.atproto.sync.subscribeRepos?cursor=${cursor}`
    : `ws://127.0.0.1:${port}/xrpc/com.atproto.sync.subscribeRepos`;
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs);
    ws.onopen = () => {};
    ws.onerror = (err) => { clearTimeout(timer); reject(new Error(String(err))); };
  });
  try { ws.close(); } catch { /* ignore */ }
  return frames;
}

Deno.test("subscribeRepos without cursor replays all frames from backlog", async () => {
  const sequencer = createRelaySequencer(10);
  sequencer.append(flatFrame(1, "market.rfp"));
  sequencer.append(flatFrame(2, "market.rfp"));
  sequencer.append(flatFrame(3, "market.rfp"));

  const { port, stop } = await serveSubscribeRepos(sequencer);
  try {
    const frames = await collectFrames(port);
    for (const f of frames) {
      const frame = f as Record<string, unknown>;
      assertEquals("frame" in frame, false);
      assertEquals("origin" in frame, false);
      assertEquals(typeof frame.time, "string");
    }
    const seqs = frames.map((f: any) => f.seq);
    assertEquals(seqs, [1, 2, 3]);
  } finally {
    stop();
  }
});

Deno.test("subscribeRepos with cursor replays only seq > cursor", async () => {
  const sequencer = createRelaySequencer(10);
  sequencer.append(flatFrame(1, "market.rfp"));
  sequencer.append(flatFrame(2, "market.rfp"));
  sequencer.append(flatFrame(3, "market.rfp"));

  const { port, stop } = await serveSubscribeRepos(sequencer);
  try {
    const frames = await collectFrames(port, 2);
    const seqs = frames.map((f: any) => f.seq);
    assertEquals(seqs, [3]);
  } finally {
    stop();
  }
});

Deno.test("subscribeRepos with cursor larger than max backlog gets live only", async () => {
  const sequencer = createRelaySequencer(10);
  sequencer.append(flatFrame(1, "market.rfp"));

  const { port, stop } = await serveSubscribeRepos(sequencer);
  try {
    const frames = await collectFrames(port, 999);
    assertEquals(frames.length, 0);
  } finally {
    stop();
  }
});
