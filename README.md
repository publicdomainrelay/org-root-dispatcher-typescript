# Public Domain Relay

**Build Alice** — an AI software maintainer that provisions compute through a
trust-verified marketplace on AT Protocol. Make compute a public utility: anyone
can request it, anyone can provide it, governed by verifiable trust (SCITT
receipts, vouches, attestation chains) not cloud provider lock-in. Alice
automates the trust decisions so humans don't have to.

## Three layers

### 1. RFP Compute Marketplace (the spine)

Requester posts `compute.vm` record + signed `market.rfp` → bidders bid →
winner provisions VM/container via cloud-init `user_data` → requester reaches
guest **only through the relay** (SSH over WebSocket tunnel).

```
requester → RFP → bid → accept → cloud-init → guest → relay tunnel → SSH
```

### 2. AT Protocol Communication

Everything is signed records on a PDS. Records flow through the firehose
(`subscribeRepos` / Jetstream). AT Protocol is the federation transport —
identities are DIDs, records are content-addressed, the firehose carries
everything. Service auth, DID resolution, record CRUD, firehose watchers:
all production.

### 3. Alice — the AI Maintainer

Alice is both the architecture blueprint AND the target AI agent. She watches
the firehose, evaluates trust (who vouched for whom? is the attestation chain
intact?), runs supply chain scans, provisions compute, files fixes. She is a
context-aware CI system that learns with you.

**The nervous system works. The brain is still docs-as-code stubs.**

| Subsystem | Status |
|-----------|--------|
| Communication (PDS, firehose, DIDs, records) | 100% |
| Compute Contract lifecycle (RFP→bid→accept→provision) | 100% |
| Fulfillment policies (only_me, direct_network) | 80% (lexicons+plumbing built; evaluate() not wired) |
| SCITT transparency service | 100% (external repo) |
| Record attestation (badge.blue) | 100% |
| OIDC workload identity | 100% |
| Supply chain scanning (shouldi) | 100% (external repo: dffml) |
| Trust crypto (signatures exist, web-of-trust doesn't) | 60% |
| Stream of consciousness (prioritizer, knowledge graph) | 20% |
| KERI duplicity, living threat model, conformity | 10% |

Architecture as code: `open-architecture/lib/abc/alice/mod.ts` — `whatAliceIs()`
→ `puttingItTogether()`. The call graph IS the blueprint. Walk it:

```
codegraph explore "whatAliceIs theInfiniteLoop puttingItTogether"
```

See `open-architecture/STATUS_REPORT.md` for the full stub→implementation map.

## Quick Start

### 1. Run a bidder (provides compute)

```bash
# Desktop tray app (macOS) — easiest
cd deno-macos-runner-desktop && ./rebuild.sh
# → Tray icon → Connect ATProto identity → Bidder starts with "Only Me" scope
```
Then link your ATProto identity.

```bash
# Headless (cross-platform)
cd atproto-market
deno run -A hono-bidder/mod.ts \
  --relay-dispatcher-host xrpc.fedproxy.com \
  --plc-directory-url https://plc.directory \
  --compute-provider-local \
  --compute-provider-local-container-mode container \
  --serve-port 0
```

### 2. Request a VM

```bash
cd atproto-market
deno run -A request-vm-ssh/mod.ts \
  --dispatcher-host xrpc.fedproxy.com \
  --extra-bidder-dids did:plc:YOUR_BIDDER_DID \
  --policy-mode only_me \
  --exec "echo hello && uname -a"
```

This posts a `compute.vm` record + signed `market.rfp`, collects bids,
picks the winner, provisions the guest via cloud-init, and SSHs in through
the websocket relay tunnel.

### 3. SSH directly (no re-provision)

```
ssh -o ProxyCommand='websocat --binary wss://<vmName>--<flat-did>.fedproxy.com' root@<vmName>--<flat-did>.fedproxy.com
```

## Repos

| Repo | Purpose |
|------|---------|
| `atproto-market/` | Market engine: RFP, bid, accept, requester, bidder, policies |
| `hono-compute-provider/` | Compute provisioning: local containers, DigitalOcean droplets, OIDC/RBAC |
| `did-key-relay/` | XRPC relay: WebSocket tunnel, subscriber, dispatcher |
| `deno-macos-runner-desktop/` | macOS desktop tray app: bidder UI, OAuth, device keys |
| `hono-pds/` | AT Protocol Personal Data Server (PDS) |
| `open-architecture/` | Docs-as-code architecture blueprint |
| `codebase-rag-proxy/` | Codebase RAG proxy for LLM integration |
| `typescript-helpers/` | Cross-repo shared utilities |

## Architecture

Every capability split 4 ways (ABC layering):
- `lib/common/` — shared types, constants, pure helpers
- `lib/abc/` — interfaces + pure state, zero I/O
- `lib/<concept>-<transport>/` — implementation (timers, crypto, fetch, sockets)
- `lib/hono-factory-*/` — Hono integration (routes, middleware)
- `hono-*/` — thin CLI entrypoint

Deps flow one way: common → abc → impl → factory → CLI. No cycles.

See `CLAUDE.md` for the full layering rules and patterns.
