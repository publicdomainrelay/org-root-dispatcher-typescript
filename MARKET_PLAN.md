# MARKET_PLAN.md — atproto-market integration roadmap

## 1. CLI: `hono-market-generic-participant`

Thin market participant server. Receives RFPs, creates bids, settles contracts, handles lifecycle events. "Generic participant" — same binary works as bidder (on receipt) or requester (on submitAccept) depending on config. Settlement mode swap via config file.

### Files

```
atproto-market/
  hono-market-generic-participant/
    deno.json
    mod.ts
    cli-args-env.json
    config.json
```

### cli-args-env.json

```json
{
  "name": "hono-market-generic-participant",
  "description": "ATProto compute marketplace generic participant",
  "options": {
    "port": {
      "type": "number",
      "description": "Port to listen on",
      "env": "PORT",
      "default": 4021
    },
    "hostname": {
      "type": "string",
      "description": "Public hostname for did:web + serviceEndpoint",
      "env": "HOSTNAME"
    },
    "settlement": {
      "type": "string",
      "description": "Settlement mode: free or x402",
      "env": "SETTLEMENT",
      "default": "free"
    },
    "role": {
      "type": "string",
      "description": "Participant role: bidder or requester",
      "env": "MARKET_ROLE",
      "default": "bidder"
    },
    "handle": {
      "type": "string",
      "description": "ATProto handle for login",
      "env": "ATPROTO_HANDLE"
    },
    "password": {
      "type": "string",
      "description": "ATProto password",
      "env": "ATPROTO_PASSWORD"
    },
    "pds-url": {
      "type": "string",
      "description": "PDS base URL",
      "env": "ATPROTO_PDS_URL",
      "default": "https://bsky.social"
    },
    "block-private-egress": {
      "type": "boolean",
      "description": "Block private/loopback IPs in egress guard",
      "env": "MARKET_BLOCK_PRIVATE_EGRESS"
    },
    "verify-signatures": {
      "type": "boolean",
      "description": "Verify badge.blue inline signatures on records",
      "env": "MARKET_VERIFY_SIGNATURES",
      "default": true
    },
    "bind-keys": {
      "type": "boolean",
      "description": "Bind signature did:key to author DID document",
      "env": "MARKET_BIND_KEYS",
      "default": true
    },
    "registry-endpoints": {
      "type": "string",
      "description": "Comma-separated market registry endpoint URLs",
      "env": "MARKET_REGISTRY_ENDPOINTS"
    }
  }
}
```

### config.json

```json
{
  "port": 4021,
  "settlement": "free",
  "role": "bidder",
  "pds-url": "https://bsky.social",
  "verify-signatures": true
}
```

### deno.json

```json
{
  "version": "0.0.0",
  "license": "Unlicense",
  "imports": {
    "@publicdomainrelay/cli-args-env": "../typescript-helpers/lib/cli-args-env/mod.ts",
    "@publicdomainrelay/logger": "../typescript-helpers/lib/logger/mod.ts",
    "@publicdomainrelay/atproto-helpers": "../typescript-helpers/lib/atproto-helpers/mod.ts",
    "@publicdomainrelay/market-atproto": "./lib/market-atproto/mod.ts",
    "@publicdomainrelay/market-common": "./lib/common/market-common/mod.ts",
    "@publicdomainrelay/market-abc": "./lib/abc/market/mod.ts",
    "@publicdomainrelay/hono-factory-market-atproto": "./lib/hono-factory-market-atproto/mod.ts",
    "@publicdomainrelay/hono-factory-market-settlement-free": "./lib/hono-factory-market-settlement-free/mod.ts",
    "@publicdomainrelay/hono-factory-market-settlement-x402": "./lib/hono-factory-market-settlement-x402/mod.ts"
  },
  "compile": {
    "include": ["cli-args-env.json", "config.json"]
  }
}
```

### mod.ts

```ts
import { Command } from "@publicdomainrelay/cli-args-env";
import { createLogger } from "@publicdomainrelay/logger";
import { loginAgent, agent, agentDid, idResolver } from "@publicdomainrelay/atproto-helpers";
import { createMarketFactory, createVerifyHandler } from "@publicdomainrelay/hono-factory-market-atproto";
import { createFreeSettlementFactory } from "@publicdomainrelay/hono-factory-market-settlement-free";
import { createX402SettlementFactory } from "@publicdomainrelay/hono-factory-market-settlement-x402";
import { createRecordResolver, loadOrGenerateKeypair } from "@publicdomainrelay/market-atproto";
import { loadOrCreateAttestationKeyHex } from "@publicdomainrelay/utils-attestation-key";
import { createBidFactory } from "@publicdomainrelay/market-atproto";
import { Settlement } from "@publicdomainrelay/market-abc";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default;
} catch { /* optional */ }

const { options } = await new Command(
  "CONFIG_PATH_HONO_MARKET_GENERIC_PARTICIPANT",
  cliArgsEnv,
  runtimeConfig,
).resolve();

const log = createLogger({ service: "hono-market-generic-participant" });

await loginAgent(options.handle, options.password);
const resolve = createRecordResolver(idResolver);

const attestationKeyHex = await loadOrCreateAttestationKeyHex(
  new URL("./attestation.jwk", import.meta.url),
);
const attestationKeypair = await loadOrGenerateKeypair(attestationKeyHex);
const signer = {
  keypair: attestationKeypair,
  issuer: options.hostname ? `did:web:${options.hostname}` : agentDid,
};

const services = [
  { id: "pdr_temp_market", type: "XrpcMarketParticipant" },
  { id: "pdr_temp_compute_event", type: "XrpcComputeEvent" },
];

const marketFactory = createMarketFactory({
  deps: {
    hostname: options.hostname,
    idResolver,
    resolve,
    log,
    verifySignatures: options.verifySignatures,
    bindKeys: options.bindKeys,
    signer,
  },
  services,
});

let settlementApp: ((req: Request) => Response | Promise<Response>) | undefined;

if (options.role === "bidder") {
  const settlementCtx = {
    getAgent: () => agent,
    resolve,
    getSigner: () => signer,
    log,
    baseUrl: options.hostname ? `https://${options.hostname}` : "",
  };

  if (options.settlement === "x402") {
    const factory = createX402SettlementFactory({
      getAgent: () => agent,
      resolve,
      getSigner: () => signer,
      log,
    });
    settlementApp = factory.fetch.bind(factory);
  } else {
    const factory = createFreeSettlementFactory({
      getAgent: () => agent,
      resolve,
      getSigner: () => signer,
      log,
    });
    settlementApp = factory.fetch.bind(factory);
  }
}

const app = marketFactory.createApp();

Deno.serve(
  { port: options.port, hostname: "0.0.0.0" },
  (req) => {
    const url = new URL(req.url);
    if (settlementApp) {
      if (url.pathname.startsWith("/free/receipt/") ||
          url.pathname.startsWith("/x402/receipt/")) {
        return settlementApp(req);
      }
    }
    return app.fetch(req);
  },
);

log("info", "market participant listening", {
  port: options.port,
  hostname: options.hostname,
  role: options.role,
  settlement: options.settlement,
  did: agentDid,
});
```

### Routes served

| Route | Handler | Purpose |
|-------|---------|---------|
| `POST /xrpc/com.publicdomainrelay.temp.market.submitRfp` | createSubmitRfpHandler | Receive RFP from requester, create bid |
| `POST /xrpc/com.publicdomainrelay.temp.market.submitAccept` | createSubmitAcceptHandler | Requester sends accept, bidder provisions |
| `POST /xrpc/com.publicdomainrelay.temp.market.submitEvent` | createSubmitEventHandler | Lifecycle events (vm.delete etc) |
| `POST /xrpc/com.publicdomainrelay.temp.market.registerBidder` | createRegisterBidderHandler | Register with market registry |
| `GET /xrpc/com.publicdomainrelay.temp.market.listBidders` | createListBiddersHandler | List registered bidders |
| `POST /xrpc/network.attested.verify` | createVerifyHandler | Verify badge.blue attestations |
| `GET /free/receipt/*` | createFreeSettlementFactory | Free-mode settlement receipt |
| `GET /x402/receipt/*` | createX402SettlementFactory | x402 payment settlement receipt |
| `GET /.well-known/did.json` | auto-generated | did:web document with service entries |
| `GET /xrpc/_health` | auto-generated | Health check |

### Run

```
# Dev — free settlement, bidder role
deno run --allow-net --allow-env --allow-read --allow-write \
  ./hono-market-generic-participant/mod.ts

# With custom config
CONFIG_PATH_HONO_MARKET_GENERIC_PARTICIPANT=./prod.json \
  ./hono-market-generic-participant/mod.ts

# Binary
deno compile --allow-net --allow-env --allow-read --allow-write \
  --output market-participant \
  ./hono-market-generic-participant/mod.ts
./market-participant
```

### What it does NOT do (yet)

- Auto-discover bidders via vouches (spindle role needs `discoverAndNotifyBidders`)
- Provision compute (bidder role needs `ComputeProvider` wired in)
- Firehose bid collection (bid window logic stays in spindle)
- Publish offering record on startup (bidder needs `ensureOfferingRecord`)

These are callbacks the factory expects from the consumer. Phase 2 addresses this.

---

## 2. Wire `hono-compute-provider` → `atproto-market`

### Goal

`hono-compute-provider` already has:
- `@publicdomainrelay/compute-provider-abc` — ComputeProvider interface
- `@publicdomainrelay/compute-provider-local` — local Docker/QEMU provisioning
- `@publicdomainrelay/compute-provider-digitalocean` — DO API provisioning
- `@publicdomainrelay/oidc-issuer-abc` + `@publicdomainrelay/oidc-issuer` — OIDC token issuance
- `@publicdomainrelay/rbac-atproto` — ATProto RBAC policy enforcement

`atproto-market` now provides:
- `@publicdomainrelay/market-atproto` — submitRfp/submitBid/submitAccept/submitEvent handlers
- `@publicdomainrelay/market-settlement-free` — free settlement
- `@publicdomainrelay/market-settlement-x402` — x402 settlement

### Integration points

**A. Bidder `onAccept` callback** — when `submitAccept` handler fires, the bidder must provision. Currently in .reference this lives in `bidder/main.ts` — an inline callback that calls `createDroplet`. Wire it so `ComputeProvider.provision()` is called from the accept handler.

```ts
// In hono-compute-provider CLI
import { createMarketFactory } from "@publicdomainrelay/hono-factory-market-atproto";
import { createComputeProvider } from "@publicdomainrelay/compute-provider-local";

const compute = createComputeProvider({ /* ... */ });

const marketFactory = createMarketFactory({
  deps: { hostname, idResolver, resolve, log },
  callbacks: {
    submitAccept: async (ctx) => {
      const { accept, issuerDid, resolve } = ctx;
      const vm = await resolve.resolve<ComputeVM>(accept.payload);
      const result = await compute.provision(vm, issuerDid);
      return { body: { providerId: result.providerId } };
    },
  },
});
```

**B. Settlement receipt endpoints** — `hono-compute-provider` CLI mounts either free or x402 receipt factory alongside compute routes.

**C. Import path** — add to `hono-compute-provider/deno.json`:
```json
"@publicdomainrelay/market-atproto": "../atproto-market/lib/market-atproto/mod.ts",
"@publicdomainrelay/hono-factory-market-atproto": "../atproto-market/lib/hono-factory-market-atproto/mod.ts"
```

### Files touched

- `hono-compute-provider/deno.json` — add cross-repo imports
- `hono-compute-provider/hono-compute-provider/mod.ts` — wire market factory
- New optional file: `hono-compute-provider/hono-compute-provider/market-handlers.ts` — bidder callbacks

---

## 3. Test scaffolding

### Goal

Smoke tests for every layer. No integration tests yet — just verify imports resolve and basic functions work.

### Test files

```
atproto-market/test/
  market-lexicons_test.ts     — NSID constants resolve, types are exported
  market-common_test.ts       — strongRef() factory, egress guard blocks metadata IP
  market-atproto_test.ts      — parseAtUri, refKey, MarketClient creation
  settlement-free_test.ts     — parseGrantPath
  settlement-x402_test.ts     — parseReceiptPath
```

### market-lexicons_test.ts

```ts
import { $nsid as RFP_NSID } from "@publicdomainrelay/market-lexicons/com/publicdomainrelay/temp/market/rfp.ts";
import { $nsid as BID_NSID } from "@publicdomainrelay/market-lexicons/com/publicdomainrelay/temp/market/bid.ts";
import { assertEquals } from "@std/assert";

Deno.test("NSIDs resolve", () => {
  assertEquals(RFP_NSID, "com.publicdomainrelay.temp.market.rfp");
  assertEquals(BID_NSID, "com.publicdomainrelay.temp.market.bid");
});
```

### market-common_test.ts

```ts
import { assertSafeEgressUrl, strongRef } from "@publicdomainrelay/market-common";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("strongRef factory", () => {
  const ref = strongRef("at://alice.test/market.rfp/abc", "cid123");
  assertEquals(ref.uri, "at://alice.test/market.rfp/abc");
  assertEquals(ref.cid, "cid123");
});

Deno.test("egress blocks metadata IP", () => {
  assertThrows(() => assertSafeEgressUrl("http://169.254.169.254/latest/meta-data"));
  assertThrows(() => assertSafeEgressUrl("http://metadata.google.internal/"));
});

Deno.test("egress blocks private with opt-in", () => {
  assertThrows(() => assertSafeEgressUrl("http://10.0.0.1/", { blockPrivate: true }));
});
```

### Run

```
cd atproto-market
deno test --allow-net --allow-env test/
```

Add to `deno.json`:
```json
"tasks": {
  "test": "deno test --allow-net --allow-env test/"
}
```

---

## 4. Port `ephemeral-bidder` from .reference

### Goal

Self-contained bidder for e2e testing. Wraps `createEphemeralBidder` from `.reference/lib/hono-factory-ephemeral-compute-bidder/`. Creates in-memory PDS + relay + bidder in single process. Used by `sshTest.ts` to run full compute contract flow without external infra.

### Strategy

Copy `.reference/lib/hono-factory-ephemeral-compute-bidder/mod.ts` to `atproto-market/lib/hono-factory-ephemeral-compute-bidder/mod.ts`. Adapt imports to use new package structure.

### Key function: `createEphemeralBidder(opts): Promise<EphemeralBidder>`

Returns:
```ts
interface EphemeralBidder {
  did: string;
  signer: Signer;
  keypair: Secp256k1Keypair;
  api: RepoApi;
  app: Hono;
  proxyRef: string;
  relaySubdomain: string;
  ready: Promise<{ subdomain: string; proxyRef: string }>;
  stop: () => void;
  attestationKp: AttestationKeypair;
  activeContracts: Map<string, ActiveContract>;
}
```

### What it does

1. Creates in-memory PDS via `createRepoFactory` (from typescript-helpers or hono-pds)
2. Registers with XRPC relay (did-key-relay pattern)
3. Publishes did:web doc with market service entries
4. Creates `market.offering` record
5. Wires market factory callbacks (onRfp → create bid, onAccept → provision)
6. Starts periodic heartbeat/registry update

### Files

```
atproto-market/
  lib/hono-factory-ephemeral-compute-bidder/
    deno.json
    mod.ts
  hono-ephemeral-bidder/              (optional CLI wrapper)
    mod.ts
    cli-args-env.json
    config.json
```

### Imports to adapt

| .reference import | New import |
|---|---|
| `@publicdomainrelay/market` | `@publicdomainrelay/market-atproto` + `@publicdomainrelay/market-abc` + `@publicdomainrelay/market-common` |
| `@publicdomainrelay/hono-factory-atproto-repo` | `@publicdomainrelay/hono-factory-atproto-repo-deno` (from hono-pds) |
| `@publicdomainrelay/xrpc-relay` | same (from did-key-relay) |
| `@publicdomainrelay/lexicons` | `@publicdomainrelay/market-lexicons` |
| `@publicdomainrelay/compute-provider` | `@publicdomainrelay/compute-provider-abc` (from hono-compute-provider) |

---

## 5. Lexicon regeneration pipeline

### Goal

Re-runnable `deno task generate-lexicons` that produces clean TypeScript from JSON schemas. Fix `listBidders.json` schema error (inline `object` type not valid ATProto lexicon spec).

### Fix: listBidders.json

Current problem: output schema uses `"type": "object"` in array items which @atproto/lex rejects. Valid lexicon types for query output: `ref`, `string`, `integer`, `boolean`, `bytes`, `cid-link`, `blob`, `unknown`, `union`.

Fix: define bidderEntry as a `$def` record type and reference via `ref`.

```json
{
  "lexicon": 1,
  "id": "com.publicdomainrelay.temp.market.listBidders",
  "defs": {
    "main": {
      "type": "query",
      "description": "List active bidders indexed by the market registry.",
      "parameters": {
        "type": "params",
        "properties": {
          "payloadNsid": { "type": "string", "format": "nsid" },
          "maxResults": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 },
          "cursor": { "type": "string" }
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {
          "type": "object",
          "required": ["bidders"],
          "properties": {
            "bidders": {
              "type": "array",
              "items": { "type": "ref", "ref": "#bidderItem" }
            },
            "cursor": { "type": "string" }
          }
        }
      }
    },
    "bidderItem": {
      "type": "object",
      "required": ["bidderDid", "appliesTo"],
      "properties": {
        "bidderDid": { "type": "string", "format": "did" },
        "appliesTo": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    }
  }
}
```

### Run

```bash
cd atproto-market
goat lex pull com.atproto.repo.strongRef
deno x -A -y npm:@atproto/lex build \
  --override \
  --import-ext ".ts" \
  --lexicons ./lexicons \
  --out lib/common/market-lexicons
```

### Known gap

Currently importing generated TS verbatim from .reference (pre-built). Once codegen runs clean, switch to `deno task generate-lexicons` as source of truth. Commit both JSON sources AND generated TS (so `deno check` works without `goat` CLI).

---

## Dependency graph (after all 5 steps)

```
typescript-helpers/
  atproto-attestation-port (badge.blue crypto)
  utils-attestation-key    (JWK key management)
  atproto-helpers          (ATProto session/PDS helpers)
  did-plc                  (did:plc client + resolver)
  logger, cli-args-env,    (existing)
  hono-error-middleware,
  event-bus, http-error

atproto-market/
  market-lexicons          ──(A) generated types + NSIDs
  market-common            ──(A) egress, helpers
  market-abc               ──(A) interfaces
  market-atproto           ──(B) ATProto impl
  market-settlement-free   ──(B+) free settlement
  market-settlement-x402   ──(B+) x402 settlement
  hono-factory-market-atproto         ──(C)
  hono-factory-market-settlement-free ──(C)
  hono-factory-market-settlement-x402 ──(C)
  hono-factory-did-plc-directory      ──(C)
  hono-factory-ephemeral-compute-bidder ──(C+) e2e test harness
  hono-market-generic-participant     ──(CLI) thin entrypoint

hono-compute-provider/
  └─ imports market-atproto, hono-factory-market-atproto

hono-pds/
  └─ imports atproto-attestation-port, did-plc (already via typescript-helpers)
```

## Order of operations

1. **hono-market-generic-participant** CLI — first runnable artifact, validates full stack
2. **Test scaffolding** — parallel with CLI, catches import errors early
3. **hono-compute-provider integration** — wires settlement callbacks to provisioning
4. **ephemeral-bidder port** — enables e2e testing without external infra
5. **Lexicon regeneration** — cleanup step, unblocks JSR publishing
