# Refactor CLI Patterns Across Polyrepo — Plan v6 (Final)

## Context

CLIs across the polyrepo have inconsistent patterns: mixed logger styles, raw `Deno.serve()` in both CLI and lib layers, monolithic callback factories, no lifecycle (`beginServe`), providers built in if/else branches. The target pseudocode in `refactor.md` defines the clean shape we want. This plan refactors `atproto-market/hono-bidder/mod.ts` to match that sketch ~1:1, extracts the shared abstractions it relies on (`createServe`, `createIngress`, `createATProto`/`LocalPDSAgent`, `createComputeProviderMarketBidderHooks`), refactors the compute-provider factories to take `atproto` directly, then migrates every other CLI to the same patterns and documents them in CLAUDE.md.

User decisions (this session): (1) **all CLIs** migrate, not just hono-bidder; (2) compute-provider factories **refactored to take `atproto`** (import `parseAtUri` internally, default `acceptPathVm`, mount their own OIDC); (3) DenoWorker **unified** behind `createComputeProviderMarketBidderHooks`; (4) **sketch-named thin wrappers** added (`createLogger({serviceName})`, `createBadgeBlueSigner`, `createPlcDirectoryClient`).

## Target end-state CLI (`atproto-market/hono-bidder/mod.ts`)

```typescript
import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger } from "@publicdomainrelay/logger";
import { createServe } from "@publicdomainrelay/serve";
import { createIngress } from "@publicdomainrelay/xrpc-relay";
import { createMarketBidder, createComputeProviderMarketBidderHooks } from "@publicdomainrelay/market-bidder";
import { createComputeProviderDenoWorker } from "@publicdomainrelay/market-bidder-worker";
import { createATProto, createLocalPDSAgent } from "@publicdomainrelay/atproto-helpers";
import { createBadgeBlueSigner } from "@publicdomainrelay/market-atproto";
import { createPlcDirectoryClient } from "@publicdomainrelay/did-plc";
import { createDigitalOceanComputeProvider } from "@publicdomainrelay/compute-provider-digitalocean";
import { createLocalComputeProvider } from "@publicdomainrelay/compute-provider-local";
import { Agent, CredentialSession } from "@atproto/api";
import { Secp256k1Keypair } from "@atproto/crypto";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig = null;
try { runtimeConfig = (await import("./config.json", { with: { type: "json" } })).default; } catch { /* optional */ }
const { options } = await new Command("CONFIG_PATH_HONO_BIDDER", cliArgsEnv, runtimeConfig).resolve();

const logger = createLogger({ serviceName: options.serviceName ?? "bidder" });

function didWebToHttps(s) { return s.startsWith("did:web:") ? "https://" + s.slice("did:web:".length) : s; }

const keypair = options.privateKeyHex
  ? await Secp256k1Keypair.import(options.privateKeyHex)
  : await Secp256k1Keypair.create({ exportable: true });

let atprotoAgent;
if (options.atprotoHandle && options.atprotoPassword) {
  const session = new CredentialSession(new URL(options.atprotoPdsUrl));
  await session.login({ identifier: options.atprotoHandle, password: options.atprotoPassword });
  atprotoAgent = new Agent(session);
} else {
  atprotoAgent = await createLocalPDSAgent({
    logger, keypair,
    serve: createServe({ logger }),
    plcDirectoryUrl: options.plcDirectoryUrl,
    dispatcherHost: options.relayDispatcherHost,
  });
  await atprotoAgent.beginServe();
}

const atproto = await createATProto({
  logger,
  badgeBlueSigner: await createBadgeBlueSigner({ privateKeyHex: options.privateKeyHex }),
  plcDirectory: createPlcDirectoryClient({ plcDirectoryUrl: options.plcDirectoryUrl }),
  agent: atprotoAgent,
});

function cliCreateIngress() {
  return createIngress({ logger, dispatcherHost: options.relayDispatcherHost, signer: atproto.signer, keypair });
}

const providers = [];
const serves = [];

if (options.computeProviderDigitaloceanToken) {
  const relay = cliCreateIngress();
  const serve = createServe({ logger, relays: [relay] });
  serves.push(serve);
  providers.push(createComputeProviderMarketBidderHooks({
    provider: createDigitalOceanComputeProvider({
      logger, atproto, serve,
      getIssuerUrl: () => didWebToHttps(relay.ingressRef),
      digitaloceanBaseUrl: options.computeProviderDigitaloceanBaseUrl || "https://api.digitalocean.com",
      doToken: options.computeProviderDigitaloceanToken,
    }),
  }));
}

if (options.computeProviderLocal) {
  const relay = cliCreateIngress();
  const serve = createServe({ logger, relays: [relay] });
  serves.push(serve);
  providers.push(createComputeProviderMarketBidderHooks({
    provider: createLocalComputeProvider({
      logger, atproto, serve,
      getIssuerUrl: () => didWebToHttps(relay.ingressRef),
      containerMode: options.computeProviderLocalContainerMode,
      vmImage: options.computeProviderLocalVmImage,
      containerImage: options.computeProviderLocalContainerImage,
      cacheDir: options.computeProviderLocalCacheDir,
    }),
  }));
}

if (options.computeProviderDenoWorker) {
  const relay = cliCreateIngress();
  const serve = createServe({ logger, relays: [relay] });
  serves.push(serve);
  providers.push(createComputeProviderMarketBidderHooks({
    provider: await createComputeProviderDenoWorker({ logger, atproto, serve, getIssuerUrl: () => didWebToHttps(relay.ingressRef) }),
  }));
}

const relays = [];
if (!options.noXrpcRelay) relays.push(cliCreateIngress());

const bidder = await createMarketBidder({
  logger, atproto, providers,
  serve: createServe({
    logger,
    tcp: { addr: options.serveAddr, port: options.servePort },
    unix: options.serveUnix ? { socketPath: options.serveUnix } : undefined,
    relays,
  }),
});

const shutdown = () => { bidder.shutdown(); for (const s of serves) s.shutdown(); Deno.exit(); };
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
await bidder.beginServe();
```

This is ~1:1 with the `refactor.md` sketch. Differences from sketch are intentional and minor: `cliCreateIngress()` also takes `signer`/`keypair` (service-auth + nonce need them); `createMarketBidder` internally owns `activeContracts` + the provider `setup`/`teardown`/callback-merge loops (honors the sketch's "just pass `providers` and have it happen" TODO); `ingressRef` read only lazily (server-assigned, decision below).

## Architecture Decisions

1. **`createServe` owns the app**. Factories/providers mount routes on `serve.app`. Composable modes `{ tcp?, unix?, relays? }`. The "≥1 mode" guard runs at **`beginServe()`**, not the constructor (LocalPDSAgent constructs an empty serve then `addRelay`s).
2. **`ingressRef` is dispatcher-assigned**, NOT precomputed client-side. Known only after `createSubscriber` resolves. Read **lazily everywhere** via `() => relay.ingressRef`. The one eager consumer (OIDC `serviceUrl`) runs in a post-connect hook (`serve.onConnected`).
3. **Relay late-binding**: `createIngress` builds synchronously with empty `ingressRef`; defers the WebSocket connect into async `onServe(fetch)`. `createServe.beginServe()` mounts routes, `await relay.onServe(app.fetch)` (connect → set `ingressRef`), then fires `serve.onConnected(ingressRef)`. Resolves the serve→relay→app→serve cycle.
4. **Logger**: add `createLogger({ serviceName })` overload returning `StructuredLoggerInterface` (JSON lines). CLI/bidder/providers pass this object everywhere. Where an internal callee wants function-style `Logger` (e.g. `createVmBidderCallbacks`), the bidder adapts with one shim `(lvl,msg,meta)=>logger[lvl]?.(msg,meta)` (typed `lvl: LogLevel`). Keep existing positional `createLogger(prefix)` overload for back-compat.
5. **`ATProto` is the single source of atproto ops** (consumed by BOTH the CLI's providers and `createMarketBidder`): identity (`did`, `getAgentDid()`, `signer`, `attestationKp`, `idResolver`, `plcClient`) + low-level (`applyWrites`, `getRecord`, `listRecords`) + builders (`createRecord`, `createRepoRecord`, `createSignedRepoRecord`, `deleteRecord`, `callService`, `resolve`). These builder closures move OUT of `createMarketBidder` (currently mod.ts:177-253) INTO `createATProto`. `signer` comes from the `agent` (LocalPDSAgent exposes `.signer`; remote `Agent` via a session adapter). `listRecords` required by `ensureOffering`/`ensureOperatorAllowlist` (mod.ts:339,367).
6. **Compute providers take `atproto` + `serve` + `getIssuerUrl`** (decision: refactor signatures). They import `parseAtUri` internally, default `acceptPathVm`, and mount their own OIDC issuer on `serve.app` via `serve.onConnected`. The provider ctx uses a minimal **structural** `ComputeAtproto` interface declared in `hono-compute-provider`'s ABC (so the repo never imports `atproto-market` — no cycle; the real `ATProto` is a structural superset).
7. **`createComputeProviderMarketBidderHooks({ provider })`** (in `market-bidder`) bridges a provider to a `MarketBidderProviderRef` carrying `serviceId`, optional `setup`/`teardown` (delegating to the provider's), and `buildCallbacks(deps)` (binds `createVmBidderCallbacks` for VM providers / `createWorkerBidderCallbacks` for the worker variant). Callbacks need `deps`, so they cannot be eager — `buildCallbacks(deps)` is called inside `createMarketBidder` where deps exist.
8. **`createMarketBidder` owns provider lifecycle**: accepts `providers[]`, internally runs `setup`/`teardown` loops and merges `buildCallbacks(deps)` across providers into the `CallbackSet` (rfp/onAccept/event — merge preserves shared `pdr_temp_market` serviceId across VM+worker, mirroring current mod.ts:166-172). Owns `activeContracts`. Explicit `setup`/`teardown`/`callbackFactory` remain optional extras.
9. **callService keeps 4 params** `(endpointUrl, nsid, lxm, body)` (mod.ts:76,219).
10. **XRPC relay package** `atproto-market/lib/xrpc-relay/` — not `typescript-helpers` (cycle). Needs raw `keypair` (did:key nonce sig, subscriber/mod.ts:71) AND `signer` (PLC-did service-auth `iss`, mod.ts:261-262); relay using `signer` is built after PLC registration.

## Implementation Phases

### Phase 1 — `createServe()` (`typescript-helpers/lib/serve/`)
NEW `mod.ts`:
```typescript
export interface IngressRef {
  ingressRef: string;                                   // "" until connected; read lazily
  onServe(fetch: (req: Request) => Promise<Response>): Promise<void>;  // connects, sets ingressRef
  close(): void;
}
export interface CreateServeOpts {
  logger?: StructuredLoggerInterface;
  tcp?: { addr?: string; port?: number };
  unix?: { socketPath: string };
  relays?: IngressRef[];
}
export interface ServeHandle {
  app: Hono;
  addRelay(relay: IngressRef): void;                    // attach a relay built after createServe (LocalPDSAgent)
  onConnected(cb: (ingressRef: string) => void | Promise<void>): void;  // fired after relays connect (OIDC mount)
  beginServe(): Promise<void>;
  shutdown(): void;
}
export function createServe(opts: CreateServeOpts): ServeHandle;
```
`beginServe()`: guard ≥1 mode (tcp/unix/relays, including `addRelay`ed) else throw; tcp→`Deno.serve({hostname,port,onListen,signal})`; unix→`Deno.serve({path,onListen,signal})` (clean stale socket); for each relay `await relay.onServe(app.fetch)`; then `await` each `onConnected(primaryProxyRef)`. `shutdown()`: abort `AbortController` + `relay.close()` each. NEW `deno.json` (`@publicdomainrelay/serve`, deps `@hono/hono`, `@publicdomainrelay/logger`). MODIFY `typescript-helpers/deno.json` workspace.

### Phase 2 — `createLogger({ serviceName })` overload (`typescript-helpers/lib/logger/mod.ts`)
Add object-arg overload returning `StructuredLoggerInterface` (delegates to `createStructuredLogger(serviceName)`). Keep positional `createLogger(prefix)`.

### Phase 3 — `createIngress()` (`atproto-market/lib/xrpc-relay/`)
Synchronous constructor, empty `ingressRef`; `onServe(fetch)` builds `createSubscriberFactory({ app:{fetch} })` then `await createSubscriber({ keypair, getServiceAuthToken, dispatcherHost, handleRequest })`, sets `ingressRef = handle.ingressRef`, `ws`. `getServiceAuthToken=(lxm)=>signServiceAuth(signer,{aud:"did:web:"+hostnameOnly(host),lxm})`. `close()`→`ws?.close()`. **did-key-relay prerequisite (MAYBE)**: if the dispatcher assigns the subdomain, `createSubscriber` must return the server-confirmed `ingressRef` (parse `#registered`, subscriber/mod.ts:103) rather than the client-derived value (:54) — confirm dispatcher behavior. NEW `deno.json` (deps: xrpc-subscriber-xrpc, hono-factory-xrpc-subscriber-xrpc, xrpc-subscriber-abc, xrpc-dispatcher-common, logger, hostname-helpers, atproto-repo-deno for `signServiceAuth`). MODIFY `atproto-market/deno.json`: workspace + imports (`xrpc-relay`, `serve`).

### Phase 4 — `createATProto()` + `LocalPDSAgent` + thin wrappers
NEW `atproto-market/lib/atproto-helpers/agent.ts`:
- `ATProto` interface per decision #5; `createATProto({ logger, badgeBlueSigner, plcDirectory, agent })` builds the builder closures (moved from market-bidder:177-253), reading `agent` for `did`/`signer`/`api` (LocalPDSAgent: `.repoApi`/`.signer`/`.did`; remote `Agent`: `com.atproto.repo.*` adapter + session-derived signer). `attestationKp` = `badgeBlueSigner`.
- `LocalPDSAgent` owns its relay internally (decision #10 ordering): PLC-register keypair→did; `signer={did:()=>did,sign:keypair.sign}`; `createRepoFactory` mounts on `opts.serve.app`; `createIngress({signer,keypair,...})`; `opts.serve.addRelay(relay)`; exposes `.signer`,`.did`,`.repoApi`,`beginServe()`(=`opts.serve.beginServe()`),`stop()`.
- MODIFY `atproto-helpers/mod.ts`: `export * from "./agent.ts"`.
NEW thin wrappers: `createBadgeBlueSigner({ privateKeyHex })` in `market-atproto` (wraps `loadOrGenerateKeypair`); `createPlcDirectoryClient({ plcDirectoryUrl })` in `did-plc` (wraps `new PlcClient({baseUrl})`).

### Phase 5 — Compute providers take `atproto` (`hono-compute-provider` repo)
- ABC `lib/abc/compute-provider/mod.ts`: declare structural `ComputeAtproto` (`getAgentDid():string; createRecord(...); deleteRecord(...)`); change ctx to `{ logger, atproto: ComputeAtproto, serve, getIssuerUrl, ...providerSpecific }`; default `acceptPathVm`; drop `parseAtUri` from ctx (import internally).
- `lib/compute-provider-digitalocean/mod.ts` + `lib/compute-provider-local/mod.ts`: adopt new ctx; pull `getAgentDid`/`createRecord`/`deleteRecord` from `atproto`; mount OIDC via `serve.onConnected(ingressRef => serve.app.route("/", createOidcIssuer({getIssuerUrl, serviceUrl: didWebToHttps(ingressRef), ...}).app))`. Add `@publicdomainrelay/serve` to their deno.json (+ `hono-compute-provider/deno.json` import map).

### Phase 6 — `createComputeProviderDenoWorker` + unify hooks
- NEW `createComputeProviderDenoWorker({ logger, atproto, serve, getIssuerUrl })` in `atproto-market/lib/market-bidder-worker/mod.ts`: builds bundler/manifest-store/instance-store/runner (currently inline in CLI), returns a worker-kind provider object.
- `createComputeProviderMarketBidderHooks({ provider })` in `market-bidder`: detects VM vs worker provider; returns `MarketBidderProviderRef` with `buildCallbacks(deps)` binding `createVmBidderCallbacks`/`createWorkerBidderCallbacks`.

### Phase 7 — Refactor `createMarketBidder` (`atproto-market/lib/market-bidder/mod.ts`)
Remove I/O (→ CLI): `Deno.serve` (:394), `AbortController`+signal listeners (:406-416), internal `createSubscriber`/`createSubscriberFactory`. Remove builder closures (→ `createATProto`). New config `{ logger, serve, atproto, providers?, setup?, teardown?, callbackFactory? }`; owns `activeContracts`. `beginServe()`: build deps from `atproto`(+relay/activeContracts); run `providers[].setup(deps)`+`setup?`; merge `providers[].buildCallbacks(deps)`(+`callbackFactory?`)→wire `createMarketFactory` onto `serve.app`; run `ensureOperatorAllowlist`/`ensureOffering` via `atproto.listRecords`/`applyWrites`; `await serve.beginServe()`. Return `{ beginServe, shutdown }`; `shutdown()`=`teardown?`+`providers[].teardown()`+`serve.shutdown()`.

### Phase 8 — Rewrite CLI (`atproto-market/hono-bidder/{mod.ts,cli-args-env.json,deno.json}`)
`mod.ts` = the target file above. `cli-args-env.json` add: `service-name`(def "bidder"), `atproto-handle`/`-password`/`-pds-url`, `relay-dispatcher-host`(def "xrpc.fedproxy.com"), `compute-provider-digitalocean-token`/`-base-url`, `compute-provider-local`(bool)+`-container-mode`/`-vm-image`/`-container-image`/`-cache-dir`, `compute-provider-deno-worker`(bool), `no-xrpc-relay`(bool), `serve-addr`(def "0.0.0.0")/`serve-port`(def 0)/`serve-unix`, keep `private-key-hex`/`plc-directory-url`. `deno.json` add imports: serve, xrpc-relay, atproto-helpers, market-bidder-worker, compute-provider-*, oidc deps already mapped, `@atproto/api`.

### Phase 9 — CLAUDE.md patterns
ALWAYS: `createLogger({serviceName})` JSON logger; `createServe()` (composable, `beginServe()`, `shutdown()`→SIGINT/SIGTERM); `beginServe()` resolves after all deps ready; provider array each owning relay+serve+OIDC (OIDC mounted on provider's serve in `serve.onConnected`); `cliCreateIngress()` (sync, defers connect, `ingressRef` server-assigned/lazy); pass `atproto` instance directly; `createMarketBidder({providers})` owns lifecycle; signal handlers in CLI only. NEVER: raw `Deno.serve` in CLI/lib; wrapping methods in intermediate objects; OIDC bolted on bidder app post-hoc; if-branch single provider; I/O in lib (`Deno.serve`/`addSignalListener`/WS connect/`Deno.env.get`); precompute/eager-read `ingressRef`.

### Phases 10-12 — All other CLIs (per-CLI: logger→`createLogger({serviceName})`, `Deno.serve`→`createServe`, hand-rolled subscriber→`createIngress`, `shutdown()` wired, no I/O left in lib; `deno check` + `--help` each)
- **Tier 1 (serve-only)**: `typescript-helpers/hono-http-static`, `deno-worker-sandbox/hono-sandbox`, `atproto-relay/hono-atproto-relay`.
- **Tier 2 (relay+serve)**: `did-key-relay/hono-xrpc-dispatcher`, `did-key-relay/hono-xrpc-subscriber`, `deno-worker-sandbox/hono-compute-deno`, `hono-pds/main.ts` (keep `createFromEnv`/`start`+`import.meta.main`), `hono-jsr/hono-package-registry`, `hono-compute-provider/hono-compute-provider` (route `killAllDroplets` via teardown).
- **Tier 3 (logger-only, no serve)**: `hono-compute-provider/hono-qemu-standalone`, `atproto-market/request-vm-ssh`.
- **Cross-repo cycle note**: `xrpc-relay` lives in `atproto-market`; repos needing it but not depending on `atproto-market` (`did-key-relay`, `deno-worker-sandbox`) would cycle. Default: those CLIs keep raw `createSubscriber` (it's their home repo), OR promote `xrpc-relay` to a standalone sibling repo — decide in Tier 2.

## Files Changed (hono-bidder core; Tiers add per-CLI mod.ts + deno.json)

| Action | File |
|--------|------|
| NEW | `typescript-helpers/lib/serve/{mod.ts,deno.json}` |
| MODIFY | `typescript-helpers/lib/logger/mod.ts` (createLogger overload) |
| MODIFY | `typescript-helpers/deno.json` |
| NEW | `atproto-market/lib/xrpc-relay/{mod.ts,deno.json}` |
| NEW | `atproto-market/lib/atproto-helpers/agent.ts` |
| MODIFY | `atproto-market/lib/atproto-helpers/mod.ts` |
| MODIFY | `atproto-market/lib/market-atproto/*` (createBadgeBlueSigner) |
| MODIFY | `atproto-market/lib/did-plc/*` (createPlcDirectoryClient) |
| MODIFY | `atproto-market/lib/market-bidder/mod.ts` (createMarketBidder + hooks) |
| MODIFY | `atproto-market/lib/market-bidder-worker/mod.ts` (createComputeProviderDenoWorker) |
| MODIFY | `hono-compute-provider/lib/abc/compute-provider/mod.ts` (ComputeAtproto ctx) |
| MODIFY | `hono-compute-provider/lib/compute-provider-{digitalocean,local}/mod.ts` (+deno.json) |
| MODIFY | `hono-compute-provider/deno.json` (serve import) |
| MODIFY | `atproto-market/hono-bidder/{mod.ts,cli-args-env.json,deno.json}` |
| MODIFY | `atproto-market/deno.json` |
| MAYBE | `did-key-relay/lib/xrpc-subscriber-xrpc/mod.ts` (server ingressRef from `#registered`) |
| MODIFY | `CLAUDE.md` |

## Verification

Per-phase `deno check` from each repo root: serve (Phase 1), xrpc-relay (3), atproto-helpers (4), compute-provider-* (5), market-bidder/-worker (6-7), hono-bidder (8). E2E:
```bash
cd atproto-market && deno run --allow-all hono-bidder/mod.ts --help
cd atproto-market && deno run --allow-all hono-bidder/mod.ts --compute-provider-local --plc-directory-url <test-plc>
```
Behavior: `beginServe()` resolves only after relay `ingressRef`s set + routes mounted; SIGINT closes all WebSockets, process exits ~1s (no hang); OIDC discovery reachable on each provider's relay endpoint post-connect; rewritten `mod.ts` structurally matches `refactor.md`. Each Tier CLI: `deno check` + `--help` before moving on.
