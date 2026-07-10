import { createBacklogSequencer } from "@publicdomainrelay/backlog-sequencer";
import type { LoggerInterface } from "@publicdomainrelay/logger";
import { now } from "@publicdomainrelay/atproto-relay-common";
import type {
  RelaySequencer,
  SubscribeReposFrame,
  PdsSubscriber,
  HostStore,
  HostInfo,
  AccountStore,
  AccountInfo,
  CollectionIndex,
} from "@publicdomainrelay/atproto-relay-abc";

const MAX_BACKLOG = 50000;

export function createRelaySequencer(maxBacklog?: number): RelaySequencer {
  return createBacklogSequencer<SubscribeReposFrame, SubscribeReposFrame>({
    maxBacklog: maxBacklog ?? MAX_BACKLOG,
    build: (seq, frame) => ({ ...frame, seq, time: now() }),
  });
}

export function createPdsSubscription(
  hostname: string,
  cursor?: number,
  opts?: { onEvent?: (frame: SubscribeReposFrame) => void; log?: LoggerInterface },
): PdsSubscriber {
  const log = opts?.log;
  const onEvent = opts?.onEvent;
  let retryCount = 0;
  let closed = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    const cursorParam = cursor !== undefined && cursor !== null ? `?cursor=${cursor}` : "";
    const url = `wss://${hostname}/xrpc/com.atproto.sync.subscribeRepos${cursorParam}`;
    log?.info("pds_connecting", { hostname, cursor });

    try {
      ws = new WebSocket(url);
    } catch (err) {
      log?.error("pds_ws_constructor_failed", { hostname, err: String(err) });
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      log?.info("pds_connected", { hostname });
    };

    ws.onmessage = (event: MessageEvent) => {
      retryCount = 0;
      try {
        let raw: unknown;
        if (event.data instanceof ArrayBuffer) {
          raw = new Uint8Array(event.data);
        } else if (typeof event.data === "string") {
          raw = JSON.parse(event.data);
        } else {
          return;
        }
        const frame = raw as SubscribeReposFrame;
        if (!frame || typeof frame.seq !== "number" || typeof frame.repo !== "string") return;
        cursor = frame.seq;
        onEvent?.(frame);
      } catch {
        // skip malformed frames
      }
    };

    ws.onerror = () => {
      log?.warn("pds_ws_error", { hostname });
    };

    ws.onclose = () => {
      log?.info("pds_disconnected", { hostname });
      ws = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
    retryCount++;
    log?.info("pds_reconnect_scheduled", { hostname, delayMs: delay, retryCount });
    reconnectTimer = setTimeout(connect, delay);
  }

  function close() {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch { /* ignore */ }
    ws = null;
  }

  connect();
  return { close };
}

export function createDenoKvHostStore(kv: Deno.Kv): HostStore {
  return {
    async list(): Promise<HostInfo[]> {
      const hosts: HostInfo[] = [];
      for await (const entry of kv.list<HostInfo>({ prefix: ["host"] })) {
        hosts.push(entry.value);
      }
      return hosts;
    },
    async get(hostname: string): Promise<HostInfo | null> {
      const res = await kv.get<HostInfo>(["host", hostname]);
      return res.value;
    },
    async upsert(hostname: string, info: Partial<HostInfo> & { did: string }) {
      const existing = await kv.get<HostInfo>(["host", hostname]);
      const merged: HostInfo = {
        hostname,
        did: info.did,
        state: info.state ?? existing.value?.state ?? "connecting",
        lastSeen: info.lastSeen ?? Date.now(),
        cursor: info.cursor ?? existing.value?.cursor ?? null,
        connectedAt: info.connectedAt ?? existing.value?.connectedAt ?? null,
        retryCount: info.retryCount ?? existing.value?.retryCount ?? 0,
      };
      await kv.set(["host", hostname], merged);
    },
  };
}

export function createDenoKvAccountStore(kv: Deno.Kv): AccountStore {
  return {
    async list(): Promise<AccountInfo[]> {
      const accounts: AccountInfo[] = [];
      for await (const entry of kv.list<AccountInfo>({ prefix: ["account"] })) {
        accounts.push(entry.value);
      }
      return accounts;
    },
    async get(did: string): Promise<AccountInfo | null> {
      const res = await kv.get<AccountInfo>(["account", did]);
      return res.value;
    },
    async upsert(did: string, info: Partial<AccountInfo>) {
      const existing = await kv.get<AccountInfo>(["account", did]);
      const merged: AccountInfo = {
        did,
        hostHostname: info.hostHostname ?? existing.value?.hostHostname ?? "",
        rev: info.rev ?? existing.value?.rev ?? null,
        seq: info.seq ?? existing.value?.seq ?? null,
      };
      await kv.set(["account", did], merged);
    },
  };
}

export async function resolvePdsIdentity(hostname: string): Promise<{ did: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://${hostname}/xrpc/com.atproto.server.describeServer`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`describeServer returned ${res.status}`);
    const body = await res.json();
    if (typeof body.did !== "string") throw new Error("missing did in describeServer response");
    return { did: body.did };
  } finally {
    clearTimeout(timeout);
  }
}

export function createDenoKvCollectionIndex(kv: Deno.Kv): CollectionIndex {
  function encodeCursor(key: Deno.KvKey): string {
    return btoa(JSON.stringify(key));
  }
  function decodeCursor(cursor: string): Deno.KvKey {
    try { return JSON.parse(atob(cursor)); } catch { return ["collection"]; }
  }

  return {
    async add(collection: string, did: string) {
      await kv.set(["collection", collection, did], { seen: Date.now() });
    },
    async listRepos(collection: string, cursor?: string, limit?: number) {
      const lim = limit ?? 50;
      const repos: Array<{ did: string }> = [];
      const listOpts: Deno.KvListOptions = { limit: lim };
      if (cursor) listOpts.cursor = cursor;
      const iter = kv.list<{ seen: number }>({ prefix: ["collection", collection] }, listOpts);
      let lastKey: Deno.KvKey | null = null;
      for await (const entry of iter) {
        const did = entry.key[2] as string;
        repos.push({ did });
        lastKey = entry.key;
      }
      const nextCursor = repos.length === lim && lastKey ? encodeCursor(lastKey) : undefined;
      return { repos, cursor: nextCursor };
    },
  };
}
