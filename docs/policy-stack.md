# Policy stack

Two independent policy layers in `atproto-market/`. Each has its own ABC
interface, impls, factory, and CLI. Neither ABC imports the other.

## Package inventory

| Layer | Package | Dir |
|-------|---------|-----|
| common | `policy-common` | `lib/common/policy-common/` |
| abc | `policy-abc` | `lib/abc/policy/` |
| abc | `market-policy-abc` | `lib/abc/market-policy/` |
| impl | `policy-builtin` | `lib/policy-builtin/` |
| impl | `market-policy-only-me` | `lib/market-policy-only-me/` |
| impl | `market-policy-direct-network-tangled-vouch` | `lib/market-policy-direct-network-tangled-vouch/` |
| impl | `market-policy-direct-network-bsky-mutual` | `lib/market-policy-direct-network-bsky-mutual/` |
| impl | `market-policy-remote` | `lib/market-policy-remote/` |
| impl | `market-policy-workflow-gha` | `lib/market-policy-workflow-gha/` |
| impl | `market-policy` | `lib/market-policy/` |
| factory | `hono-factory-policy-builtin` | `lib/hono-factory-policy-builtin/` |
| CLI | `hono-policy` | `hono-policy/` |

## Two ABC interfaces

### `policy-abc` — gate/sandbox level

```ts
// lib/abc/policy/mod.ts — zero imports
interface PolicyViolation { msg: string; policyId: string }
interface PolicyResult { allow: boolean; violations: PolicyViolation[] }
interface PolicyHandler<T = Record<string, unknown>> {
  readonly name: string;
  evaluate(ctx: T): Promise<PolicyResult>;
}
interface PolicyRegistry {
  get(name: string): PolicyHandler | undefined;
  names(): string[];
}
```

Used by the standalone policy engine (`hono-policy`). Generic handler over any
context type. Policy ID is a plain string.

### `market-policy-abc` — RFP/market level

```ts
// lib/abc/market-policy/mod.ts — imports StrongRef from market-common only
type PolicyMode = "only-me" | "tangled-vouch" | "mutuals" | "dynamic";
const POLICY_MODES: readonly PolicyMode[] = ["only-me", "tangled-vouch", "mutuals", "dynamic"];
const POLICY_MODE_CLI_OPTION = { type: "string", env: "POLICY_MODE", default: "only-me" };
function isValidPolicyMode(raw: unknown): raw is PolicyMode;

interface PolicyViolation { msg: string; policyId: string | StrongRef }
interface PolicyEvalCtx {
  subjectDid: string;
  rootRequesterDid: string;
  counterpartyDid: string;
  resolve: (ref: StrongRef) => Promise<Record<string, unknown>>;
  resolveOperatorDid: (bidderDid: string) => Promise<string | null>;
  log: (level: string, msg: string, meta?: Record<string, unknown>) => void;
  policyRef?: StrongRef;
}
interface FulfillmentPolicy {
  readonly policyNsid: string;
  buildPolicyRecord(requesterDid: string, policyEngineEndpoint?: string): Record<string, unknown>;
  evaluate(ctx: PolicyEvalCtx): Promise<{ allow: boolean; violations: PolicyViolation[] }>;
}
interface RequesterAssociationChecker {
  isRequesterAssociated(requesterDid: string): Promise<boolean>;
}
class PolicyModeFilter {
  constructor(mode, selfDid, vouchedDids?, checker?);
  preFilter(did: string): boolean;              // sync, O(1)
  filter(issuerDid: string): Promise<boolean>;   // async, delegates to checker
  toAcceptScopeFilter(): (input: { issuerDid: string }) => Promise<boolean>;
}
```

Used by the RFP lifecycle (requester + bidder). Two lifecycle methods
(`buildPolicyRecord` + `evaluate`). Policy ID is `string | StrongRef` (AT
Protocol record reference). `PolicyModeFilter` is a pure state class — no I/O in
its methods, all I/O injected via `RequesterAssociationChecker`.

### Why two interfaces

| | `policy-abc` | `market-policy-abc` |
|---|---|---|
| Context | Generic `T` | Fixed `PolicyEvalCtx` (7 fields) |
| Policy ID | `string` | `string \| StrongRef` |
| Methods | `evaluate` only | `buildPolicyRecord` + `evaluate` |
| State | None | `PolicyModeFilter` |
| CLI support | None | `POLICY_MODE_CLI_OPTION` built-in |
| Consumers | Policy engine server | RFP requester + bidder |

## Common layer (`policy-common`)

5 exports, zero imports. Fully compliant.

```
GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID   — string constant
GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_LXM    — same value
MARKET_EVALUATE_POLICY_NSID                      — string constant
MARKET_EVALUATE_POLICY_LXM                       — same value
PolicyError                                      — Error + status + errorName + toJSON()
```

**NSID duplication:** `MARKET_EVALUATE_POLICY_NSID` and `MARKET_EVALUATE_POLICY_LXM`
are defined in both `policy-common/nsids.ts` and `market-lexicons/nsids.ts` with
identical values. Generated lexicon code vs hand-maintained constants.

## Implementations

### Gate-level handlers (`policy-builtin`)

3 handlers, pure logic, no transport binding:

| Handler | Logic |
|---------|-------|
| `deny-all` | Always `{ allow: false }` |
| `allow-all` | Always `{ allow: true }` |
| `allow-net` | Rejects any permission key not `"net"` |

Exported as `BUILTIN_POLICIES: Record<string, () => PolicyHandler>`.
`resolvePolicies(names: string[]): PolicyHandler[]` looks up by name.

### FulfillmentPolicy modes

| Mode | Package | Status | I/O |
|------|---------|--------|-----|
| `only-me` | `market-policy-only-me` | Done | `ctx.resolveOperatorDid` callback |
| `tangled-vouch` | `market-policy-direct-network-tangled-vouch` | Done | `ctx.resolve` → `listRecords` (ATProto repo) |
| `mutuals` | `market-policy-direct-network-bsky-mutual` | Done (needs injected `vouchResolver`) | `vouchResolver.getVouchedDids` |
| `dynamic` | `market-policy-remote` | Done | `fetch` (HTTP POST to policy engine), JWT signing |
| `workflow-gha` | `market-policy-workflow-gha` | **Stub** — always denies | None |

### Orchestrator (`market-policy`)

```ts
// lib/market-policy/mod.ts
function createPolicy(mode: PolicyMode, opts?): FulfillmentPolicy {
  // switch(mode): only-me → createOnlyMePolicy()
  //              tangled-vouch → createDirectNetworkPolicy()
  //              mutuals → createBskyMutualPolicy()
  //              dynamic → createRemotePolicy(opts)
}
function evaluateRfpPolicy(opts): Promise<{ allow: boolean; violations }> {
  // Resolves policy strongRef from RFP → reads policyEngine field →
  // if set: createRemotePolicy().evaluate()
  // if unset: allow (trivially)
}
```

`evaluateRfpPolicy` always uses `createRemotePolicy` regardless of original
mode — it consults the `policyEngine` endpoint recorded in the policy record.
The original `FulfillmentPolicy.evaluate()` from the mode-specific factory is
only called directly in tests.

## Hono factory (`hono-factory-policy-builtin`)

Single factory. Wraps `PolicyHandler[]` into an XRPC server.

```
GET  /.well-known/did.json
POST /xrpc/{MARKET_EVALUATE_POLICY_NSID}        — auth: requireAuth
POST /xrpc/{GATE_REGISTRY_WORKER_MANIFEST_PERMISSIONS_NSID} — auth: requireAuth
```

Evaluation logic: iterate handlers, first deny → return 403. All pass → allow.

### Pattern deviations

| Deviation | Detail |
|-----------|--------|
| Raw `new Hono()` | Not `createFactory()` from `@hono/hono/factory` |
| Handlers injected | CLI calls `resolvePolicies()`, passes array in. Factory does not own construction. |
| No ABC state object | No `PolicyRegistry` instance. Handlers iterated linearly. |
| `signingKey` dead option | Declared in `PolicyEngineFactoryOptions`, never read in body. |

## CLI entrypoints

### `hono-policy` — policy engine server

```
--policy "allow-net,deny-all"   (comma-separated handler names)
```

- `policyRaw` → `split(",")` → `resolvePolicies()` → `PolicyHandler[]`
- Injected into `createPolicyEngineFactory({ handlers })`
- Serves the remote policy eval endpoint

### `hono-bidder` — bidder

```
--policy-mode "tangled-vouch"   (single PolicyMode)
```

- `isValidPolicyMode(raw)` guard, else `undefined`
- Passed to `createMarketBidder({ policyMode })`
- Constructs `PolicyModeFilter` for scope filtering + firehose pre-filtering

### `request-vm-ssh` — requester

```
--policy-mode "dynamic" --policy-engine-endpoint "https://..."
```

- Same `isValidPolicyMode()` guard
- Passed to `runComputeContract({ policyMode, policyEngineEndpoint })`
- `createPolicy(mode)` → `buildPolicyRecord()` → stamped on RFP
- `evaluateRfpPolicy()` called pre-accept (only for `"dynamic"` mode)

## Enforcement points

```
Requester creates RFP
  │
  ├─ createPolicy(mode) → buildPolicyRecord() → write to ATProto repo → stamp strongRef on RFP
  │
  ▼
RFP broadcast via firehose
  │
  ├─ [Bidder] PolicyModeFilter.preFilter(did) — sync hot-path gate
  │   only-me:        did === selfDid
  │   tangled-vouch:  did === selfDid || vouchedDids.has(did)
  │   mutuals:        same as tangled-vouch
  │   dynamic:        allow all (defer to remote)
  │
  ▼
Bidder receives RFP
  │
  ├─ [Bidder] evaluateRfpPolicy() in onRfp callback (market-bidder-compute, market-bidder-worker)
  │   Resolves policy strongRef → if policyEngine set → POST to engine
  │
  ▼
Bidder places bid (if policy allows)
  │
  ▼
Requester selects winner
  │
  ├─ [Requester] evaluateRfpPolicy() pre-accept (only when mode === "dynamic")
  │
  ▼
market.accept → provision VM (policy-agnostic cloud-init)
```

## PolicyModeFilter — sync vs async

| Mode | `preFilter(did)` sync | `filter(issuerDid)` async | Remote eval |
|------|----------------------|--------------------------|-------------|
| `only-me` | `did === selfDid` | same | Never |
| `tangled-vouch` | `did === selfDid \|\| vouchedDids.has(did)` | falls back to `checker.isRequesterAssociated` | Never |
| `mutuals` | same as tangled-vouch | same | Never |
| `dynamic` | allows all | allows all | Yes — POST to `policyEngine` URL |

## Cloud-init: zero policy coupling

`buildDefaultUserData()` in `cloud-init-common` takes `CloudInitContext` —
no policy field. Guest VMs are provisioned identically regardless of policy
mode. Policy gates who can bid and accept, not what runs inside the guest.

## Dependency graph

```
market-lexicons (generated ATProto schema types)
market-common (StrongRef)
       │
       ├── policy-common (NSIDs, PolicyError) ── zero imports
       │       │
       │       ├── policy-abc (PolicyHandler<T>) ── zero imports
       │       │       │
       │       │       ├── policy-builtin (deny-all, allow-all, allow-net)
       │       │       │       │
       │       │       │       └── hono-factory-policy-builtin
       │       │       │               │
       │       │       │               └── hono-policy (CLI)
       │       │       │
       │       │       └── (end of PolicyHandler tree)
       │       │
       │       └── (end of policy-common tree)
       │
       ├── market-policy-abc (FulfillmentPolicy, PolicyMode, PolicyModeFilter)
       │       │
       │       ├── market-policy-only-me
       │       ├── market-policy-direct-network-tangled-vouch ── trust-graph-tangled-graph
       │       ├── market-policy-direct-network-bsky-mutual ── trust-graph-bsky-mutuals
       │       ├── market-policy-remote (fetch + JWT)
       │       ├── market-policy-workflow-gha (STUB)
       │       │
       │       └── market-policy (orchestrator: createPolicy + evaluateRfpPolicy)
       │               │
       │               ├── requester-xrpc (createPolicy for RFP; evaluateRfpPolicy for accept)
       │               ├── market-bidder (PolicyModeFilter scope + preFilter)
       │               ├── market-bidder-compute (evaluateRfpPolicy pre-bid)
       │               └── market-bidder-worker (evaluateRfpPolicy pre-bid)
       │
       └── (end of market-policy tree)
```

No cycles. No cross-repo imports for any policy package (all consumers within
`atproto-market/`). `deno-worker-sandbox` has its own parallel
`PermissionPolicyHandler` in `compute-deno-abc` — same concept, different
interface, zero shared code.

## Cross-repo isolation

Zero consumers outside `atproto-market/` for market-policy interfaces.
Consumers within `atproto-market/`:

| Consumer | Imports |
|----------|---------|
| `hono-bidder/cli-args-env.ts` | `POLICY_MODE_CLI_OPTION` |
| `hono-bidder/mod.ts` | `isValidPolicyMode`, `PolicyMode` |
| `request-vm-ssh/cli-args-env.ts` | `POLICY_MODE_CLI_OPTION` |
| `request-vm-ssh/mod.ts` | `isValidPolicyMode`, `PolicyMode` |
| `lib/market-bidder/mod.ts` | `PolicyModeFilter`, `PolicyMode` |
| `lib/market-bidder-compute/mod.ts` | `evaluateRfpPolicy` (dynamic import) |
| `lib/market-bidder-worker/mod.ts` | `evaluateRfpPolicy` (dynamic import) |
| `lib/requester-xrpc/mod.ts` | `createPolicy`, `evaluateRfpPolicy` (dynamic import) |
| `lib/compute-contract-gateway-xrpc/mod.ts` | `isValidPolicyMode` |
| `lib/abc/requester/mod.ts` | `PolicyMode` (type-level import) |
| `hono-policy/mod.ts` | `resolvePolicies`, `createPolicyEngineFactory` |

## Test coverage

| Test | What it covers |
|------|---------------|
| `test/policy_server_test.ts` | Engine XRPC routes (evaluatePolicy, gateRegistryWorkerManifestPermissions) |
| `test/policy_remote_test.ts` | `createRemotePolicy`, `createOnlyMePolicy`, `createDirectNetworkPolicy` |
| `test/bidder_policy_only_me_integration_test.ts` | only-me e2e via `runComputeContract` |
| `test/bidder_policy_remote_integration_test.ts` | Remote policy e2e via `runComputeContract` |

No integration tests for `tangled-vouch`, `mutuals`, or `workflow-gha` modes.

## Known issues

1. **NSID duplication.** `MARKET_EVALUATE_POLICY_NSID` / `LXM` defined in both
   `policy-common/nsids.ts` and `market-lexicons/nsids.ts`. Lexicon code
   generation should be the single source of truth.

2. **`PolicyViolation` defined twice.** `policy-abc` uses `policyId: string`;
   `market-policy-abc` uses `policyId: string | StrongRef`. Same name, different
   types. Intentional (different domains) but confusing.

3. **Factory pattern deviation.** `hono-factory-policy-builtin` uses raw
   `new Hono()` instead of `createFactory()`. Handlers are injected pre-built
   from CLI rather than constructed internally. No ABC state object
   (`PolicyRegistry`) is instantiated.

4. **`signingKey` dead option.** Declared in `PolicyEngineFactoryOptions`,
   never read in factory body.

5. **`workflow-gha` is a stub.** Always returns `{ allow: false,
   violations: ["not yet implemented"] }`.

6. **`mutuals` needs injected `vouchResolver`.** No default — logs warning and
   denies if resolver is not provided.
