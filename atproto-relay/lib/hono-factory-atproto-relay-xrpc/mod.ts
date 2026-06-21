import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { upgradeWebSocket } from "@hono/hono/deno";
import { registerErrorMiddleware } from "@publicdomainrelay/hono-error-middleware";
import { createLogger, type LoggerInterface } from "@publicdomainrelay/logger";
import { hostnameToDid, hostnameOnly } from "@publicdomainrelay/hostname-helpers";
import { now } from "@publicdomainrelay/atproto-relay-common";
import type {
  HostStore,
  AccountStore,
  RelaySequencer,
  RelayFrame,
  CollectionIndex,
} from "@publicdomainrelay/atproto-relay-abc";
import {
  createRelaySequencer,
  createPdsSubscription,
  createDenoKvHostStore,
  createDenoKvAccountStore,
  resolvePdsIdentity,
  createDenoKvCollectionIndex,
} from "@publicdomainrelay/atproto-relay-xrpc";

export interface RelayFactoryOptions {
  hostname: string;
  kv?: Deno.Kv;
  log?: LoggerInterface;
}

export interface RelayFactory {
  app: Hono;
}

const activeSubscriptions = new Map<string, { close(): void }>();

export function createRelayFactory(opts: RelayFactoryOptions): RelayFactory {
  const log = opts.log ?? createLogger("atproto-relay");
  let kvPromise: Promise<Deno.Kv> | null = null;

  function getKv(): Promise<Deno.Kv> {
    if (opts.kv) return Promise.resolve(opts.kv);
    if (!kvPromise) kvPromise = Deno.openKv();
    return kvPromise;
  }

  const sequencer = createRelaySequencer();
  const app = new Hono();

  app.use("*", cors());

  registerErrorMiddleware(app, log);

  app.get("/xrpc/_health", (c) => {
    return c.json({ version: "0.0.0" });
  });

  app.get("/xrpc/com.atproto.server.describeServer", (c) => {
    return c.json({
      did: hostnameToDid(opts.hostname),
      version: "0.0.0",
      availableUserDomains: [],
      inviteCodeRequired: false,
    });
  });

  app.get("/.well-known/atproto-did", (c) => {
    return c.text(hostnameToDid(opts.hostname));
  });

  app.get("/.well-known/did.json", (c) => {
    const host = hostnameOnly(c.req.header("host") ?? opts.hostname);
    return c.json({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: hostnameToDid(host),
      service: [{
        id: "#atproto_relay",
        type: "AtprotoRelay",
        serviceEndpoint: `https://${host}`,
      }],
    });
  });

  app.post("/xrpc/com.atproto.sync.requestCrawl", async (c) => {
    let body: { hostname?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "InvalidRequest", message: "invalid JSON" }, 400);
    }
    const pdsHostname = body.hostname;
    if (!pdsHostname || typeof pdsHostname !== "string") {
      return c.json({ error: "InvalidRequest", message: "missing hostname" }, 400);
    }

    const kv = await getKv();
    const hostStore = createDenoKvHostStore(kv);
    const existing = await hostStore.get(pdsHostname);

    if (existing && existing.state === "active") {
      await hostStore.upsert(pdsHostname, { did: existing.did, lastSeen: Date.now() });
      return c.json({});
    }

    let did: string;
    try {
      const identity = await resolvePdsIdentity(pdsHostname);
      did = identity.did;
    } catch (err) {
      log.warn("resolve_pds_failed", { hostname: pdsHostname, err: String(err) });
      return c.json({ error: "PdsNotFound", message: "could not resolve PDS identity" }, 502);
    }

    const accountStore = createDenoKvAccountStore(kv);
    const collectionIndex = createDenoKvCollectionIndex(kv);

    if (activeSubscriptions.has(pdsHostname)) {
      activeSubscriptions.get(pdsHostname)!.close();
    }

    const sub = createPdsSubscription(pdsHostname, existing?.cursor ?? undefined, {
      log,
      onEvent: (frame) => {
        hostStore.upsert(pdsHostname, { did, cursor: frame.seq, lastSeen: Date.now(), state: "active" }).catch(() => {});
        accountStore.upsert(frame.repo, { hostHostname: pdsHostname, rev: frame.rev }).catch(() => {});
        for (const op of frame.ops) {
          if (op.path) {
            const slashIdx = op.path.indexOf("/");
            if (slashIdx > 0) {
              const collection = op.path.slice(0, slashIdx);
              collectionIndex.add(collection, frame.repo).catch(() => {});
            }
          }
        }
        sequencer.append(pdsHostname, frame);
      },
    });

    activeSubscriptions.set(pdsHostname, sub);

    await hostStore.upsert(pdsHostname, { did, state: "active" });

    log.info("crawl_started", { hostname: pdsHostname, did });
    return c.json({});
  });

  app.get(
    "/xrpc/com.atproto.sync.subscribeRepos",
    upgradeWebSocket((_c) => ({
      onOpen(_evt, ws) {
        (async () => {
          try {
            const serialize = (f: RelayFrame) => {
              const blocks = f.frame.blocks instanceof Uint8Array
                ? Array.from(f.frame.blocks)
                : f.frame.blocks;
              return JSON.stringify({
                ...f,
                frame: { ...f.frame, blocks },
              });
            };
            for await (const frame of sequencer.backfill()) {
              ws.send(serialize(frame));
            }
            for await (const frame of sequencer.live()) {
              ws.send(serialize(frame));
            }
          } catch {
            // client disconnected
          }
        })();
      },
      onClose() {},
    })),
  );

  app.get("/xrpc/com.atproto.sync.getRepo", async (c) => {
    const did = c.req.query("did");
    if (!did) return c.json({ error: "InvalidRequest", message: "missing did" }, 400);
    const kv = await getKv();
    const accountStore = createDenoKvAccountStore(kv);
    const account = await accountStore.get(did);
    if (!account) return c.json({ error: "RepoNotFound", message: "unknown DID" }, 404);
    return c.redirect(
      `https://${account.hostHostname}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`,
      307,
    );
  });

  app.get("/xrpc/com.atproto.sync.getRepoStatus", async (c) => {
    const did = c.req.query("did");
    if (!did) return c.json({ error: "InvalidRequest", message: "missing did" }, 400);
    const kv = await getKv();
    const accountStore = createDenoKvAccountStore(kv);
    const account = await accountStore.get(did);
    if (!account) return c.json({ error: "RepoNotFound", message: "unknown DID" }, 404);
    return c.json({
      did: account.did,
      hostname: account.hostHostname,
      rev: account.rev,
      seq: account.seq,
    });
  });

  app.get("/xrpc/com.atproto.sync.listRepos", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 1000);
    const cursor = c.req.query("cursor") ?? undefined;
    const kv = await getKv();
    const accountStore = createDenoKvAccountStore(kv);
    const all = await accountStore.list();
    const startIdx = cursor ? all.findIndex((a) => a.did > cursor) : 0;
    const slice = all.slice(startIdx, startIdx + limit);
    return c.json({
      repos: slice.map((a) => ({ did: a.did, head: a.rev ?? "", rev: a.rev ?? "" })),
      cursor: slice.length === limit ? slice[slice.length - 1].did : undefined,
    });
  });

  app.get("/xrpc/com.atproto.sync.listReposByCollection", async (c) => {
    const collection = c.req.query("collection");
    if (!collection) return c.json({ error: "InvalidRequest", message: "missing collection" }, 400);
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50") || 50, 1000);
    const cursor = c.req.query("cursor") ?? undefined;
    const kv = await getKv();
    const collectionIndex = createDenoKvCollectionIndex(kv);
    const result = await collectionIndex.listRepos(collection, cursor, limit);
    return c.json(result);
  });

  app.get("/xrpc/com.atproto.sync.getLatestCommit", async (c) => {
    const did = c.req.query("did");
    if (!did) return c.json({ error: "InvalidRequest", message: "missing did" }, 400);
    const kv = await getKv();
    const accountStore = createDenoKvAccountStore(kv);
    const account = await accountStore.get(did);
    if (!account || !account.rev) return c.json({ error: "RepoNotFound" }, 404);
    return c.json({ cid: account.rev, rev: account.rev });
  });

  app.get("/xrpc/com.atproto.sync.listHosts", async (c) => {
    const kv = await getKv();
    const hostStore = createDenoKvHostStore(kv);
    const hosts = await hostStore.list();
    return c.json({ hosts });
  });

  app.get("/xrpc/com.atproto.sync.getHostStatus", async (c) => {
    const hostname = c.req.query("hostname");
    if (!hostname) return c.json({ error: "InvalidRequest", message: "missing hostname" }, 400);
    const kv = await getKv();
    const hostStore = createDenoKvHostStore(kv);
    const host = await hostStore.get(hostname);
    if (!host) return c.json({ error: "HostNotFound" }, 404);
    return c.json(host);
  });

  return { app };
}
