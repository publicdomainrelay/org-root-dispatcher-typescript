# Migration Status: Reference POC → Poly-Repo ABC Architecture

**Date**: 2026-06-17
**Reference**: `.reference/compute-contract-reference-implementation-poc/src/typescript/` (45 workspace members)
**Target**: Poly-repo org root with 7 submodules, each self-contained Deno workspace

## Submodule State

| Submodule | Status | Purpose |
|-----------|--------|---------|
| `typescript-helpers` | `heads/main` ✓ | Cross-repo shared: logger, event-bus, cli-args-env, did-plc, atproto-helpers, http-error, hono-error-middleware, hono-factory-static-files-fs |
| `hono-compute-provider` | `+` (dirty/diverged) | Compute provider ABC + impl + factory |
| `atproto-market` | **untracked** (`??` in git) | Market ABC + settlement + lexicons + factory |
| `did-key-relay` | `heads/main` ✓ | XRPC relay/subscriber ABC + impl + factory |
| `hono-pds` | `heads/master` ✓ | AT Protocol repo ABC + impl + factory |
| `hono-jsr` | `heads/master` ✓ | Package store ABC + impl + factory |
| `deno-worker-sandbox` | `heads/master` ✓ | Sandbox ABC + impl + factory |

**Issues**: `hono-compute-provider` shows `+` prefix = local checkout diverged from submodule pointer. `atproto-market` is untracked — not yet added as submodule, needs `git submodule add`.

## Full Reference POC → New Poly-Repo Mapping

### ✅ FULLY PORTED (ABC-layered)

| Ref POC Package | New Location | Layer |
|-----------------|-------------|-------|
| `lib/atproto-attestation-port` | `typescript-helpers/lib/atproto-attestation-port` | common |
| `lib/atproto-helpers` | `typescript-helpers/lib/atproto-helpers` | common |
| `lib/did-plc` | `typescript-helpers/lib/did-plc` | common |
| `lib/event-bus` | `typescript-helpers/lib/event-bus` | common |
| `lib/utils-log` | `typescript-helpers/lib/logger` | common |
| `lib/deno-hono-helpers` | Split → `typescript-helpers/lib/http-error` + `typescript-helpers/lib/hono-error-middleware` | common |
| `lib/compute-provider` | `hono-compute-provider/lib/abc/compute-provider` | abc |
| `lib/compute-provider-local` | `hono-compute-provider/lib/compute-provider-local` | impl |
| `lib/compute-provider-digitalocean` | `hono-compute-provider/lib/compute-provider-digitalocean` | impl |
| `lib/hono-factory-compute-provider-local` | `hono-compute-provider/lib/hono-factory-compute-provider-local` | factory |
| — (new ABC layer) | `hono-compute-provider/lib/hono-factory-compute-provider-digitalocean` | factory |
| — (new ABC layer) | `hono-compute-provider/lib/abc/oidc-issuer` | abc |
| — (new ABC layer) | `hono-compute-provider/lib/oidc-issuer` | impl |
| `lib/oidc-helper` | `hono-compute-provider/lib/abc/oidc-issuer` + `lib/oidc-issuer` | abc+impl |
| `lib/rbac-helper` | `hono-compute-provider/lib/rbac-atproto` | impl |
| `lib/xrpc-relay` | `did-key-relay/lib/did-key-relay-relayer-xrpc` + `did-key-relay/lib/did-key-relay-subscriber-xrpc` | impl |
| `lib/hono-factory-xrpc-relay` | `did-key-relay/lib/hono-factory-did-key-relay-relayer-xrpc` | factory |
| `lib/hono-factory-xrpc-subscriber` | `did-key-relay/lib/hono-factory-did-key-relay-subscriber-xrpc` | factory |
| `lib/hono-factory-atproto-repo` | `hono-pds/lib/hono-factory-atproto-repo-deno` | factory |
| `lib/datastore-package` | `hono-jsr/lib/abc/package-store` | abc |
| `lib/datastore-local-fs` | `hono-jsr/lib/package-store-local-fs` | impl |
| `lib/datastore-remote-git` | `hono-jsr/lib/package-store-remote-git` | impl |
| `lib/hono-factory-package-registry` | `hono-jsr/lib/hono-factory-package-registry` | factory |
| `lib/hono-factory-did-plc-directory` | `atproto-market/lib/hono-factory-did-plc-directory` | factory |

### ⚠️ PARTIALLY PORTED (core ABC done, logic gaps)

| Ref POC Package | New Location | Gap |
|-----------------|-------------|-----|
| `lib/market` (19 files) | `atproto-market/lib/abc/market` (4 files) | **Missing from ABC**: `types.ts`, `attest.ts`, `records.ts`, `signing.ts`, `auth.ts`, `egress.ts`, `server.ts`, `client.ts`, `registry.ts`, `discovery.ts`, `bid.ts`. Ported: `contract.ts`, `resolve.ts`, `settlement.ts` |
| `lib/market-free` (7 files) | `atproto-market/lib/market-settlement-free` | Restructured as settlement impl. Need verify completeness. |
| `lib/market-x402` (8 files) | `atproto-market/lib/market-settlement-x402` | Restructured as settlement impl. Need verify completeness. |
| `lib/market-settlement` | Folded into settlement-free/settlement-x402 | Need verify no orphaned logic. |
| `lib/lexicons` (19+ files) | `atproto-market/lib/common/market-lexicons` | Lexicon definitions ported. May need regeneration from latest schemas. |

### ❌ NOT YET PORTED (reference-only, by priority)

#### High Priority — Core Business Logic

| Ref POC Package | Files | Description | Target Submodule |
|-----------------|-------|-------------|-----------------|
| `lib/market/*` (remaining) | ~15 files | Market types, attest, records, signing, auth, egress, server, client, registry, discovery, bid | `atproto-market/lib/abc/market` + `atproto-market/lib/market-atproto` |
| `lib/compute` | 2 files (`mod.ts`, `eventDelete.ts`) | Compute event handler factories | `hono-compute-provider` (new ABC or impl layer) |
| `lib/hono-factory-compute` | 1 file | Hono routes for compute XRPC handlers | `hono-compute-provider` (factory) |
| `lib/hono-factory-ephemeral-compute-bidder` | 1 file | Ephemeral bidder Hono factory | `atproto-market` or new submodule |
| `lib/hono-factory-market-bids` | 1 file | Market bids Hono factory | `atproto-market` (factory) |
| `lib/hono-factory-market` | ? | Market Hono factory | `atproto-market` |

#### Medium Priority — Infrastructure/Helpers

| Ref POC Package | Files | Description | Target |
|-----------------|-------|-------------|--------|
| `lib/ssh` | 1 file (`mod.ts`) | SSH helper for provisioning | `hono-compute-provider` (impl) |
| `lib/utils-attestation-key` | ? | Attestation key utilities | `typescript-helpers` or `hono-compute-provider` |
| `lib/hono-factory-workload-identity-droplet-oidc-poc` | 3 files | OIDC workload identity for DigitalOcean droplets | `hono-compute-provider` (factory) |
| `lib/datastore-pds` | 1 file | PDS-backed datastore | `hono-jsr` (impl) |
| `lib/oidc-helper` | ? | OIDC helper (may already be in `oidc-issuer`) | `hono-compute-provider` |

#### Lower Priority — CLIs / Entrypoints / Frontends

| Ref POC Package | Files | Description |
|-----------------|-------|-------------|
| `spindle` | `main.ts`, `marketRFP.ts` | Spindle CLI — orchestrates market RFP flow |
| `bidder` | `main.ts`, `env.ts` | Bidder CLI |
| `market-registry` | `main.ts`, `health.ts`, `store.ts` | Market registry CLI |
| `ephemeral-bidder` | `main.ts` | Ephemeral bidder CLI |
| `ephemeral-package-registry` | `main.ts`, `mod.ts`, tests | Ephemeral package registry CLI |
| `did-plc-directory` | multiple | PLC directory CLI server |
| `qemu` | 11 `.ts` files | QEMU VM orchestration (database, oauth, oidc, rbac, provisioning) |
| `xrpc-relay-pds` | ? | PDS + relay config |
| `xrpc-relay-example` | `mod.ts` | Relay example/CLI |
| `compute-spa` | `vite.config.ts` | Vite SPA frontend |
| `web-client-example` | `vite.config.ts` | Vite web client example |
| `spindle-viewer-spa` | Pure JS | JavaScript SPA (not TS library) |
| `graph-viewer-deno` | 3 files | Deno graph viewer utility |
| `rookery-client` | `register.ts` | Client registration utility |
| `utils/client-xrpc-caller` | `main.ts` | XRPC client utility |

## Architecture Gaps (CLAUDE.md non-compliance)

### 1. No org-root `deno.json`
Reference POC had single root workspace. New approach: each submodule is own workspace. Works but no unified `deno check`/`deno test` across repos without custom scripting.

### 2. `atproto-market` not a submodule
Directory exists as untracked `??` in git. Needs `git submodule add` + proper pointer commit.

### 3. `hono-compute-provider` submodule diverged
`+` prefix in `git submodule status` = local checkout at different commit than recorded. Needs reconciling.

### 4. Reference POC `lib/market` is 19 files; new `lib/abc/market` is 4 files
ABC layer captures interfaces (contract, resolve, settlement) but misses:
- **types.ts** — wire types for market records
- **attest.ts** — attestation verification logic
- **records.ts** — AT Protocol record CRUD
- **signing.ts** — inter-service signing
- **auth.ts** — auth verification
- **egress.ts** — egress checking
- **server.ts** — framework-agnostic server handlers
- **client.ts** — MarketClient implementation
- **registry.ts** — registry client
- **discovery.ts** — service discovery
- **bid.ts** — bid logic

These likely belong as impl layer (`lib/market-atproto/`) or further split per CLAUDE.md: transport-agnostic logic in ABC, atproto-specific in impl.

### 5. CLI entrypoints not following CLAUDE.md CLI pattern
Reference CLIs (`spindle`, `bidder`, `qemu`, etc.) predate the `cli-args-env` + `Command` pattern. Each needs:
- `cli-args-env.json` with typed options
- `config.json` (optional)
- `new Command(...)` in `mod.ts`
- JSON files in `compile.include`/`publish.include`

### 6. `hono-compute-provider` uses `lib/oidc-issuer` (impl) but its ABC layer `lib/abc/oidc-issuer` exists
Layering looks correct. Need verify `lib/oidc-issuer/` implements `lib/abc/oidc-issuer/` interface and the ref `lib/oidc-helper` logic is fully subsumed.

## Summary Counts

| Category | Count |
|----------|-------|
| Reference POC workspace members | 45 |
| Fully ported (ABC-layered) | ~23 |
| Partially ported (logic gaps) | ~5 |
| Not ported — business logic | ~6 |
| Not ported — infrastructure | ~4 |
| Not ported — CLIs/entrypoints | ~12 |
| Not ported — auxiliary/SPAs | ~4 |

## Recommended Migration Order

1. **Fix git state**: commit `atproto-market` as proper submodule, reconcile `hono-compute-provider` pointer
2. **Complete market ABC → impl**: port remaining `lib/market/*` files into `atproto-market/lib/market-atproto/` (impl layer), verify settlement-free/settlement-x402 completeness
3. **Port `lib/compute` + `lib/hono-factory-compute`**: small, foundational for compute flow
4. **Port `lib/hono-factory-ephemeral-compute-bidder` + `lib/hono-factory-market-bids`**: factory layer for bidder
5. **Port `lib/ssh`**: needed by compute-provider provisioning
6. **Port `lib/utils-attestation-key`**: attestation dependency
7. **Port `lib/hono-factory-workload-identity-droplet-oidc-poc`**: OIDC integration
8. **Port `lib/datastore-pds`**: PDS datastore impl for package registry
9. **Port CLIs** (lower priority, can iterate): `spindle`, `bidder`, `market-registry`, `ephemeral-bidder`, `qemu`, `did-plc-directory`
10. **SPAs/frontends**: `compute-spa`, `web-client-example` (separate concern from library migration)
