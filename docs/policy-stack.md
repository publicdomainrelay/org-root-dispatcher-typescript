# Policy stack

Two independent policy layers in `atproto-market/`. Each has its own ABC
interface, impls, factory, and CLI. Neither ABC imports the other.

## Package inventory

| Layer | Package | Dir |
|-------|---------|-----|
| common | `policy-common` | `lib/common/policy-common/` |
| common | `market-policy-common` | `lib/common/market-policy-common/` |
| abc | `policy-abc` | `lib/abc/policy/` |
| abc | `market-policy-abc` | `lib/abc/market-policy/` |
| impl | `policy-builtin` | `lib/policy-builtin/` |
| impl | `market-policy-only-me` | `lib/market-policy-only-me/` |
| impl | `market-policy-direct-network-tangled-vouch` | `lib/market-policy-direct-network-tangled-vouch/` |
| impl | `market-policy-direct-network-bsky-mutual` | `lib/market-policy-direct-network-bsky-mutual/` |
| impl | `market-policy-registry` | `lib/market-policy-registry/` |
| impl | `market-policy-engine-worker` | `lib/market-policy-engine-worker/` |
| impl | `market-policy-engine-service` | `lib/market-policy-engine-service/` |
| impl | `market-policy` | `lib/market-policy/` |
| factory | `hono-factory-policy-builtin` | `lib/hono-factory-policy-builtin/` |
| CLI | `hono-policy` | `hono-policy/` |

## A policy is data, not a mode

There is no `PolicyMode` enum. A policy is a **name plus arguments**, carried as
an ATProto record and looked up in a registry at evaluation time. The registry
holds two kinds:

- **Trust policies** gate engagement — "may I transact with this counterparty".
  `only-me`, `tangled-vouch`, `mutuals`. They declare a sync `decide()` over the
  trust cache for the hot path, and a full `evaluate()` for the sandbox/remote.
- **Work policies** gate the workload — "do I want to run this". `under-4-cpus`
  (bidder), `bid-payload` (requester). They declare `perspectives`, so a
  wrong-side `--policy` fails loud at the CLI instead of silently no-oping.

A policy record is a **set**: `{ policies: [{name, args}], requesterDid, createdAt }`.
Evaluation iterates the set; the first deny short-circuits.

## `$type` is the engine kind

`market.rfp.policy` is a strongRef, exactly like `market.rfp.payload`. The
record it points at declares *how* it is evaluated through its own `$type` —
the same dispatch shape consumers already use for RFP payloads.

| NSID | Executed by | Trust |
|---|---|---|
| `...market.policies.builtin` | in-process Deno worker sandbox, first-party registry bundle | trusted |
| `...market.policies.service` | remote XRPC policy engine | remote |
| `...market.policies.denoWorker` | in-process Deno worker sandbox, caller-supplied bundle | untrusted, gated |

Shared record fields:

```
$type        engine kind — the dispatch key
name         registry name, e.g. "only-me"
description  human-readable
args         open object: { bidWindowSec, firstFree, ... }
requesterDid
createdAt
signatures
```

`.service` adds `policyEngine` (a `did:web`). `.denoWorker` adds `manifest`
(strongRef to a `compute.deno.workerManifest`) and `permissions`.

## Execution: sandboxed by default

Policies run inside `deno-worker-sandbox`, reusing
`createPersistentDenoWorker` from `sandbox-deno`.

Both engine kinds execute **one mechanism**: a standalone JS bundle that assigns
`globalThis.policy`, concatenated with a host-RPC shim, loaded as a `data:` URL
worker. Only the bundle's provenance differs.

- **First-party**: `scripts/build-policy-bundle.ts` runs `deno bundle` over
  `lib/market-policy-engine-worker/policy-entry.ts` (which imports the registry)
  and emits `builtin-bundle.ts` exporting the bundled JS as a string constant.
  Regenerate with `deno task build-policy-bundle`. Committing the generated
  bundle keeps `deno compile` binaries self-contained.
- **Caller-supplied**: the bundle string comes from the worker manifest the
  `policies.denoWorker` record references.

**Zero permissions, host-brokered I/O.** The first-party worker is created with
`permissions: {}`. `PolicyEvalCtx`'s `resolve`, `resolveOperatorDid`,
`getVouchedDids`, and `log` are RPC calls back to the host over postMessage; the
host performs every network read. This is what makes the sandbox meaningful —
policy code cannot reach the network, and no per-policy permission set has to be
computed. A test asserts a bundle's `fetch` is blocked.

Because of this, the policies themselves are pure functions of their context.
They take no injected resolvers. That purity is the precondition for sandboxing.

Untrusted bundles get only the `SandboxPermissions` their record declares, and
only when explicitly allowed. Worker execution is capped at 30s.

### Two gates

| Flag | Effect |
|---|---|
| `--only-remote-policy-exec` | Any record that is not `policies.service` is a hard deny. No local worker starts. |
| `--allow-untrusted-policy-exec` | Required before a `policies.denoWorker` bundle will run at all. Without it, deny. |

## Trust cache

The bidder keeps operators, associations, and vouch sets in one `TrustSet`
(`market-policy-trust-abc`, pure state; `market-policy-trust-cache` does the
I/O). Warmed at boot from its own `bidder_associate` records and the vouch
graph; refreshed from the firehose (Jetstream delivers custom collections;
relay/subscriberepos falls back to a TTL re-poll). Negatives are never cached —
an association may land right after the first RFP. This replaces the old
`vouchedDids` set, `associationCache`, and the operator-discovery cache.

## Policy XRPC — both directions

Call-in on the engine: `evaluatePolicy`, `checkScope` (fast trust-only
decision), `describe` (registry introspection: names, kinds, perspectives —
UIs stop hardcoding lists).

Call-out: a served host exposes `resolveOperator`, `getVouchedDids`,
`getTrustSet`, `getRecord` (`hono-factory-market-policy-host`), and an engine
calls back through `createPolicyHostXrpc`. The in-process host (worker
postMessage shim) already provides the same three reads. This is what lets a
delegated engine ask the requester/bidder for the trust data it needs.

Auth is the existing service-auth JWT pattern. Note: the policy engine's
`verifyServiceAuthToken` is decode-and-claims only (no signature verification);
the compute host in `deno-worker-sandbox` has a verifying verifier. Hardening
the policy engine's to match is tracked as a follow-up.

## ABC interfaces

### `policy-abc` — gate/sandbox level

```ts
interface PolicyHandler<T = Record<string, unknown>> {
  readonly name: string;
  evaluate(ctx: T): Promise<PolicyResult>;
}
```

Used by the standalone policy engine for worker manifest permissions.

### `market-policy-abc` — RFP/market level

```ts
interface PolicyArgs { bidWindowSec?: number; firstFree?: boolean; [k: string]: unknown }
interface PolicySpec { name: string; description?: string; args: PolicyArgs }

interface NamedPolicy {
  readonly name: string;
  readonly description: string;
  readonly needsVouchSet?: boolean;
  preFilter?(input: PreFilterInput): boolean | undefined;
  evaluate(ctx: PolicyEvalCtx): Promise<PolicyResult>;
}

interface PolicyRegistry { get(name: string): NamedPolicy | undefined; names(): string[] }

class PolicyScopeFilter { preFilter(did); filter(issuerDid); toAcceptScopeFilter(); }
```

`PolicyEvalCtx` carries `policyName`, `args`, `perspective` (who is evaluating),
`selfDid`/`counterpartyDid`, the host-brokered I/O callbacks, and `demand`/`offer`
(the workload refs, so work policies can see what is on the table). `PolicyScopeFilter`
is pure state — all I/O injected.

Trust policies are evaluated from the **perspective** that asks: the default set
is symmetric relations (`sameOperator`, vouch, mutual) with the roles swapped.
The bidder's fast path answers `sameOperator(counterparty, self)` from the trust
cache — no raw DID-equality shortcut.

## Policy arguments replace CLI flags

`bidWindowSec` and `firstFree` are policy arguments, not separate flags. They
travel with the policy record, so the thing that decides *who may bid* also
decides *how long to wait for bids*.

```
--policy only-me --policy-args '{"bidWindowSec":10,"firstFree":true}'
```

**first-free**: `market.bids.free` is already a first-class bid payload type
(`BIDS_FREE_NSID`, sibling of `BIDS_X402_NSID`), so freeness is read off the bid
payload's collection with no extra fetch. With `firstFree`, the requester races
the bid window against the first policy-allowed free bid:

```
bid arrives
  firstFree && payload is bids.free && policy allows bid.did -> WIN now
  otherwise                                                  -> accumulate
window elapses -> lowest cost among allowed
```

A free bid from a policy-rejected bidder is discarded rather than winning.
`BidCollector` and `selectWinner` live in `lib/abc/requester` — pure, no timers.

## Enforcement points

```
Requester creates RFP
  │
  ├─ buildPolicyRecord(spec) → policies.builtin | .service | .denoWorker
  │  → write to ATProto repo → stamp strongRef on RFP
  ▼
RFP broadcast via firehose
  │
  ├─ [Bidder] PolicyScopeFilter.preFilter(did) — sync hot-path gate
  ▼
Bidder receives RFP
  │
  ├─ [Bidder] evaluateRfpPolicy() in onRfp — dispatch on $type
  ▼
Bidder places bid (if policy allows)
  │
  ▼
Requester collects bids (firstFree may end the window early)
  │
  ├─ [Requester] evaluateRfpPolicy() pre-accept — only for policies.service
  │   records, and skipped when the winner already cleared policy on the
  │   firstFree path
  ▼
market.accept → provision VM (policy-agnostic cloud-init)
```

## Policy engine server

`hono-policy` serves two XRPC endpoints. `evaluatePolicy` resolves `body.name`
against the **same registry** used for local execution, so a policy name means
the same thing on either side of the wire; a nameless body falls through to the
configured `PolicyHandler` chain.

```
GET  /.well-known/did.json
POST /xrpc/com.publicdomainrelay.temp.market.evaluatePolicy
POST /xrpc/com.publicdomainrelay.temp.compute.deno.gateRegistryWorkerManifestPermissions
```

## Where a policy is enforced

The **bidder** is the enforcement point for locally-evaluated policies
(`policies.builtin`, `policies.denoWorker`). It holds the trust data the policy
needs — operator associations via `bidderAssociation`, the vouch graph from its
own authenticated repo reads — and refuses to bid when the policy denies.

The **requester** re-checks before accepting only when it delegated evaluation
to an engine (`policies.service`). That is the one case where a second opinion
is both meaningful and answerable from the requester's side; a requester
generally cannot read the counterparty trust data a local policy depends on.

Consequence worth stating plainly: for `policies.builtin`, a bidder that ignores
the attached policy and bids anyway is not caught by the requester. Closing that
gap needs the requester to resolve operator associations and vouch sets for
arbitrary bidder DIDs, which `resolveOperatorDid` does not yet do everywhere
(see STATUS_REPORT). Use `--policy-engine` when you need the decision enforced
by a party that holds the data.

## Cloud-init: zero policy coupling

`buildDefaultUserData()` takes no policy field. Guests are provisioned
identically regardless of policy. Policy gates who may bid and accept, not what
runs inside the guest.

## Test coverage

| Test | What it covers |
|------|---------------|
| `test/policy_registry_test.ts` | registry lookup, all three policies, `PolicyScopeFilter`, arg parsing |
| `test/policy_engine_worker_test.ts` | `$type` dispatch, sandbox execution, host RPC, both gates, untrusted bundles, timeout, network denial |
| `test/bid_collector_test.ts` | dedupe, winner selection, firstFree early exit and fallback |
| `test/policy_server_named_test.ts` | engine name dispatch against the shared registry |
| `test/policy_server_test.ts` | worker manifest permission handlers |
| `test/bidder_policy_only_me_integration_test.ts` | only-me e2e via `runComputeContract` |
| `test/bidder_policy_remote_integration_test.ts` | service-policy e2e |
