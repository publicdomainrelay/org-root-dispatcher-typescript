#!/usr/bin/env -S deno run --allow-all
import { assert } from "@std/assert";
import { Secp256k1Keypair } from "@atproto/crypto";
import { Hono } from "@hono/hono";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { createIngress } from "@publicdomainrelay/did-key-ingress-proxy";
import { createATProto, createLocalPDSAgent } from "@publicdomainrelay/atproto-helpers";
import { createBadgeBlueSigner } from "@publicdomainrelay/market-atproto";
import { createPlcDirectoryClient } from "@publicdomainrelay/did-plc";
import { createMarketBidder } from "@publicdomainrelay/market-bidder";
import { createComputeProviderHooks } from "@publicdomainrelay/market-bidder-compute";
import { createLocalComputeProvider } from "@publicdomainrelay/compute-provider-local";
import type { ComputeAtproto } from "@publicdomainrelay/compute-provider-abc";
import { createRelayFactory } from "@publicdomainrelay/hono-factory-did-key-ingress-proxy-xrpc";
import { createRequesterPDS, runComputeContract, createSshSessionProvider } from "@publicdomainrelay/requester-xrpc";
import { installFetchInterceptor } from "../atproto-market/test/fetch-interceptor.ts";

const OUTPUT_DIR = new URL(".", import.meta.url).pathname;
const LOG_FILE = `${OUTPUT_DIR}/full-flow.log`;
const RECORDS_FILE = `${OUTPUT_DIR}/atproto-records.json`;
const SUMMARY_FILE = `${OUTPUT_DIR}/SUMMARY.md`;

function didWebToHttps(s: string): string {
  return s.startsWith("did:web:") ? "https://" + s.slice("did:web:".length) : s;
}

function createFakePlc() {
  const ops = new Map<string, Record<string, unknown>>();
  const app = new Hono();

  function didFromPath(path: string): string {
    const raw = decodeURIComponent(path.startsWith("/") ? path.slice(1) : path);
    return raw;
  }

  app.post("/*", async (c) => {
    const did = didFromPath(new URL(c.req.url).pathname);
    const op = await c.req.json().catch(() => ({}));
    ops.set(did, op as Record<string, unknown>);
    return c.json({ ok: true });
  });

  app.get("/*", (c) => {
    const did = didFromPath(new URL(c.req.url).pathname);
    const op = ops.get(did);
    if (!op) return c.json({ message: `DID not found: ${did}` }, 404);
    const vms = (op.verificationMethods ?? {}) as Record<string, string>;
    const svcs = (op.services ?? {}) as Record<string, { type: string; endpoint: string }>;
    const doc = {
      "@context": [
        "https://www.w3.org/ns/did/v1",
        "https://w3id.org/security/multikey/v1",
      ],
      id: did,
      alsoKnownAs: (op.alsoKnownAs ?? []) as string[],
      verificationMethod: Object.entries(vms).map(([name, didKey]) => ({
        id: `${did}#${name}`,
        type: "Multikey",
        controller: did,
        publicKeyMultibase: String(didKey).replace(/^did:key:/, ""),
      })),
      service: Object.entries(svcs).map(([name, s]) => ({
        id: `#${name}`,
        type: s.type,
        serviceEndpoint: s.endpoint,
      })),
    };
    return c.json(doc);
  });

  return { app };
}

async function main() {
  const logLines: string[] = [];
  const collectedRecords: Record<string, unknown>[] = [];

  const log = (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}`;
    logLines.push(line);
    console.error(line);
  };

  log("=== compute-contract-full-flow ===");
  log("Starting dispatcher, fake PLC, bidder, requester...");

  const logger = createLogger({ serviceName: "full-flow" });
  const cleanups: Array<() => void> = [];

  const dispatcherApp = createRelayFactory({ hostname: "localhost" }).createApp();
  const dispatcherCtl = new AbortController();
  const { promise: dispPortReady, resolve: resolveDispPort } = Promise.withResolvers<number>();
  Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: dispatcherCtl.signal,
      onListen: (addr) => resolveDispPort((addr as Deno.NetAddr).port) },
    dispatcherApp.fetch,
  );
  const dispPort = await dispPortReady;
  cleanups.push(() => dispatcherCtl.abort());
  const ingressProxyHost = `localhost:${dispPort}`;
  log(`dispatcher listening on ${ingressProxyHost}`);

  const plc = createFakePlc();
  const plcCtl = new AbortController();
  const { promise: plcPortReady, resolve: resolvePlcPort } = Promise.withResolvers<number>();
  Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: plcCtl.signal,
      onListen: (addr) => resolvePlcPort((addr as Deno.NetAddr).port) },
    plc.app.fetch,
  );
  const plcPort = await plcPortReady;
  cleanups.push(() => plcCtl.abort());
  const plcDirectoryUrl = `http://localhost:${plcPort}`;
  log(`fake PLC listening on ${plcDirectoryUrl}`);

  const restoreFetch = installFetchInterceptor({
    realFetch: globalThis.fetch,
    plcDirectoryUrl,
    dispPort,
  });
  cleanups.push(restoreFetch);

  // ── bidder ──────────────────────────────────────────────
  const bidderKeypair = await Secp256k1Keypair.create({ exportable: true });
  const bidderPrivHex = Array.from(await bidderKeypair.export())
    .map((b) => b.toString(16).padStart(2, "0")).join("");

  const bidderPdsServe = createServe({ logger });
  const pdsAgent = await createLocalPDSAgent({
    logger, keypair: bidderKeypair,
    serve: bidderPdsServe,
    plcDirectoryUrl, ingressProxyHost,
  });
  await pdsAgent.beginServe();
  log(`bidder PDS ready: did=${pdsAgent.did}`);

  const atproto = await createATProto({
    logger,
    badgeBlueSigner: await createBadgeBlueSigner({ privateKeyHex: bidderPrivHex }),
    plcDirectory: createPlcDirectoryClient({ plcDirectoryUrl }),
    agent: pdsAgent,
  });

  const makeRelay = async () => {
    const kp = await Secp256k1Keypair.create({ exportable: true });
    return createIngress({ logger, ingressProxyHost, signer: atproto.signer, keypair: kp });
  };

  const providerRelay = await makeRelay();
  const providerServe = createServe({ logger, relays: [providerRelay] });

  const computeProvider = createLocalComputeProvider({
    logger,
    atproto: atproto as unknown as ComputeAtproto,
    serve: providerServe,
    getIssuerUrl: () => didWebToHttps(providerRelay.ingressRef),
    containerMode: "container",
    xrpcRelay: false,
  });

  const provider = createComputeProviderHooks({ provider: computeProvider });
  await providerServe.beginServe();
  log(`provider relay ready: ingressRef=${providerRelay.ingressRef}`);

  const bidderRelay = await makeRelay();
  const bidderServe = createServe({ logger, tcp: { addr: "127.0.0.1", port: 0 }, relays: [bidderRelay] });

  const marketBidder = await createMarketBidder({
    logger, atproto, providers: [provider], relay: bidderRelay,
    rfpWatcherFactory: undefined,
    offeringRefreshMs: undefined,
    serve: bidderServe,
  });
  await marketBidder.beginServe();
  cleanups.push(() => marketBidder.shutdown());
  log(`bidder ready: did=${atproto.did} ingressRef=${bidderRelay.ingressRef}`);

  // ── requester ───────────────────────────────────────────
  const requesterServe = createServe({ logger, tcp: { addr: "127.0.0.1", port: 0 } });
  const requester = await createRequesterPDS({
    logger, serve: requesterServe,
    plcDirectoryUrl, ingressProxyHost, label: "requester",
  });
  cleanups.push(() => requesterServe.shutdown());
  await requester.beginServe();
  log(`requester ready: did=${requester.did} ingressRef=${requester.ingressRef}`);

  // ── collect ALL atproto records from both repos ──────────
  async function collectRecords(label: string, pdsApi: { listRecords(did: string, collection: string, opts?: { limit?: number; cursor?: string }): Promise<{ records: Array<{ uri: string; cid: string; value: Record<string, unknown> }>; cursor?: string }> }, did: string) {
    const collections = [
      "com.publicdomainrelay.temp.market.offering",
      "com.publicdomainrelay.temp.market.rfp",
      "com.publicdomainrelay.temp.market.bid",
      "com.publicdomainrelay.temp.market.accept",
      "com.publicdomainrelay.temp.market.receipt",
      "com.publicdomainrelay.temp.market.policy",
      "com.publicdomainrelay.temp.auth.allowlist.rbacDid",
      "com.publicdomainrelay.temp.compute.vm",
    ];
    for (const col of collections) {
      try {
        let cursor: string | undefined;
        do {
          const result = await pdsApi.listRecords(did, col, { limit: 100, cursor });
          for (const rec of result.records) {
            collectedRecords.push({
              source: label,
              did,
              collection: col,
              uri: rec.uri,
              cid: rec.cid,
              value: rec.value,
            });
            log(`record: ${label} ${col} ${rec.uri}`);
          }
          cursor = result.cursor;
        } while (cursor);
      } catch (err) {
        log(`collect error (${label} ${col}): ${String(err)}`);
      }
    }
  }

  // ── run the contract flow ────────────────────────────────
  log("=== starting compute contract flow ===");
  log(`requester did: ${requester.did}`);
  log(`bidder did: ${atproto.did}`);

  const sshProvider = createSshSessionProvider(logger);

  const contract = await runComputeContract(requester, {
    logger,
    ingressProxyHost,
    skipSsh: false,
    keepVm: true,
    bidWindowSec: 15,
    vmReadyTimeoutSec: 60,
    execProgram: "hostname",
    extraBidderDids: [atproto.did],
    denyBidderDids: ["did:plc:centraldefaultbidder000000"],
    sshProvider,
  });

  log(`contract result: ${JSON.stringify(contract)}`);

  // ── collect records post-flow ────────────────────────────
  try {
    await collectRecords("requester", requester.api, requester.did);
  } catch (err) {
    log(`collect requester records error: ${String(err)}`);
  }
  try {
    await collectRecords("bidder", atproto, atproto.did);
  } catch (err) {
    log(`collect bidder records error: ${String(err)}`);
  }

  // ── write outputs ────────────────────────────────────────
  await Deno.writeTextFile(LOG_FILE, logLines.join("\n") + "\n");
  log(`log written to ${LOG_FILE}`);

  await Deno.writeTextFile(RECORDS_FILE, JSON.stringify(collectedRecords, null, 2));
  log(`records written to ${RECORDS_FILE}`);

  const recordsByCollection: Record<string, unknown[]> = {};
  for (const r of collectedRecords) {
    const col = r.collection as string;
    (recordsByCollection[col] ??= []).push(r);
  }

  const summary = `# Compute Contract Full Flow — Summary

## Participants

| Role | DID |
|------|-----|
| Requester | \`${requester.did}\` |
| Bidder | \`${atproto.did}\` |

## Result

\`\`\`json
${JSON.stringify(contract, null, 2)}
\`\`\`

## Dispatcher

Host: \`${ingressProxyHost}\`
PLC: \`${plcDirectoryUrl}\`

## AT Protocol Records Created

| Collection | Count |
|------------|-------|
${Object.entries(recordsByCollection).map(([col, recs]) => `| \`${col}\` | ${recs.length} |`).join("\n")}

## Full Record Details

See [atproto-records.json](./atproto-records.json)

## Log

See [full-flow.log](./full-flow.log)

## How to Reproduce

\`\`\`bash
# From the polyrepo root:
deno run --allow-all compute-contract-full-flow/run_full_flow.ts
\`\`\`

## Architecture

\`\`\`
Requester                    AT Protocol (PDS/relay)              Bidder                    Guest Container
────────                     ──────────────────────              ──────                    ───────────────
runComputeContract()
  ├─ ssh-keygen ed25519
  ├─ buildDefaultUserData()  ──►  compute.vm record
  ├─ createSignedRepoRecord  ──►  market.rfp (signed)
  ├─ discoverBidders         ──►  relay index + extraBidderDids
  ├─ submitRfp XRPC          ──►  ──►  rfpCallback → bid
  │                                    ├─ onAccept → provision
  │                                    │    ├─ OIDC enrichment
  │                                    │    ├─ runContainer()
  │                                    │    └─ cloud-init: sshd + websocat
  │                                    └─ eventCallbacks
  ├─ wait bidWindowSec (15s)
  ├─ pick lowest-cost bid
  ├─ createSignedRepoRecord  ──►  market.accept
  ├─ submitAccept XRPC       ──►  ──►  provision guest
  ├─ verify receipt
  ├─ pollReady → SSH         ──►  ──►  websocat ws:// → sshd
  │  └─ exec 'hostname'
  └─ vm.delete event         ──►  ──►  destroy()
\`\`\`

## SSH Tunnel Path

\`\`\`
requester SSH client
  ProxyCommand websocat --binary wss://<service>--did-plc-<key>.localhost
    → dispatcher (did-key-relay, routes by SNI subdomain)
      → relay WebSocket → bidder PDS → guest container
        → websocat ws-l:127.0.0.1:8080
          → sshd 127.0.0.1:22
\`\`\`

Generated: ${new Date().toISOString()}
`;

  await Deno.writeTextFile(SUMMARY_FILE, summary);
  log(`summary written to ${SUMMARY_FILE}`);

  // ── cleanup ──────────────────────────────────────────────
  for (const c of cleanups.reverse()) {
    try { c(); } catch { /* best effort */ }
  }
  await new Promise((r) => setTimeout(r, 200));

  log("=== flow complete ===");
}

main().catch((err) => {
  console.error(`FATAL: ${err}`);
  Deno.exit(1);
});
