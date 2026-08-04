# POLICY ENGINE RIP-OUT PLAN — all policy logic into `policy-engine`, hot path via scope-mode workflows

Companion to `N_PLUS_ONE_REFACTOR_OF_POLICY_MODES.md` and `PRE_REFACTOR_POLICY_MODES.md`.
Discovery state: 2026-08-03. atproto-market has an uncommitted agent refactor (RFP `policies[]` array, record-as-set, TrustPolicy/WorkPolicy, TrustSet/TrustCache) that this plan replaces wholesale.

**Constraint (settled):** the hot path MUST run gha-lite workflows. No host-side `PolicyScopeFilter` class. The scope decision is produced by the policy workflow itself in a `mode: scope` lane, selected via `workflow_dispatch` inputs. A host-side **scope verdict cache** converts per-firehose-event cost into per-novel-party cost.

---

## 1. Design summary — the settled model

- **Policies are records; policy logic lives in the workflow/bundle.** Two executor kinds dispatch by record `$type`:
  | Kind | `$type` | Policy = | Executes via |
  |---|---|---|---|
  | `gha-lite` | `computer.socialweb.temp.policy.gha-lite` | inline GitHub Actions workflow YAML | gha-lite engine (subprocess actions) |
  | `typescript` | `computer.socialweb.temp.policy.typescript` | workerManifest bundle (strongRef) | deno-worker-sandbox worker |

  No legacy `policies.builtin` / `.service` / `.denoWorker` record kinds — they die with atproto-market. Remote evaluation is a transport choice, not a record kind: a caller sends a gha-lite/typescript record to `hono-policy-engine`'s `evaluatePolicy`. The bidder's own `--policy` scope gate and the requester-minted RFP policy are both **seeded gha-lite/typescript records** referenced by strongRef.

- **One workflow, two lanes** selected by a `workflow_dispatch` input:
  - `mode: full` (default) — full evaluate: records + workload + work policies. Runs in `onRfp`, accept re-check, explicit `evaluatePolicy`.
  - `mode: scope` — trust-only gate: the action runs the policy's **`decide`** over a trust snapshot it prepares; no workload records. Runs for the hot path and `checkScope`.

- **Host never decides.** Host keeps ONE scope verdict cache:
  ```
  scopeCache: key = hash(policyIdentity, counterpartyDid, args) → { allow, at, ttl }
  ```
  - Firehose RFP from X → cache hit? serve. Miss? run scope-mode workflow once → cache.
  - Firehose trust events (`badgeBlueKeys`, `vouch`) → `applyEvent` → drop entries whose counterparty DID ∈ {event repo DID, event rkey}.
  - Negatives TTL 30s (association may appear between submit and re-check), positives TTL longer (minutes).

- **`checkScope` = the same lane.** Same scope cache + scope-mode workflow. No separate implementation.

- **Two caches, two lanes:**
  1. **Scope verdict cache** (host, policy-engine module) — sync hot path / checkScope. Firehose-invalidated.
  2. **`runPolicy` verdict cache** (already in `deno-typescript-shared`, gha-lite; to extend to all executors) — async full-evaluate memoization, keyed on record strongRefs + args hash, TTL. Makes repeated full evaluation cheap.

- **`decide` lives inside the policy, invoked by the workflow action in scope mode** — not by any host class. `TrustQuery` stays in `deno-typescript-shared`.

- **`TrustSet`/`TrustCache` (host-side graph) are NOT part of the hot path.** The workflow action resolves operator/vouch itself (`createPolicyCtx`, network + its own cache). Optional opt-in perf knob: pass a serialized trust snapshot as a `trust` workflow_dispatch input so the scope-mode action skips network (reintroduces host trust state — default off).

---

## 2. Target policy-engine package layout

### New packages

| Path | Package | Role |
|---|---|---|
| `policy-engine/lib/policy-engine-scope-cache/` | `@publicdomainrelay/policy-engine-scope-cache` | host scope verdict cache: `createScopeCache({ positiveTtlMs, negativeTtlMs })` → `{ get, set, applyEvent(e), stats }`; key = `scopeCacheKey(policyIdentity, counterpartyDid, args)` |
| `policy-engine/lib/policy-engine-evaluator/` | `@publicdomainrelay/policy-engine-evaluator` | the ONE import callers use: `createPolicyEvaluator({ registry, resolve, resolveOperatorDid, getVouchedDids, scopeCache?, policies?, log })` → `{ evaluatePolicies(refs, ctx), scope(ref, ...), buildPolicyRecord(opts), resolvePolicyName(name, perspective) }` |
| `policy-engine/lib/policy-engine-cli-options/` | `@publicdomainrelay/policy-engine-cli-options` | `POLICY_CLI_OPTION`, `POLICY_ARGS_CLI_OPTION`, `parsePolicyArgs`, `bidWindowSecOf`, `firstFreeOf`, `DEFAULT_POLICY_NAME`, `ONLY_REMOTE_POLICY_EXEC_CLI_OPTION`, `ALLOW_UNTRUSTED_POLICY_EXEC_CLI_OPTION` (moved from `market-policy-abc`; 3 CLIs re-point) |
| `policy-engine/lib/policies/deno-typescript/bundle/` | (script, not package) | workerManifest bundle builder — port atproto-market `scripts/build-policy-bundle.ts` → bundles registry into one `builtin-bundle.ts` for typescript/seeder records |

### Modified packages

| Path | Change |
|---|---|
| `policy-engine/lib/abc/policy-engine/mod.ts` | add `scope?(input)` to `PolicyEngineExecutor`; add `ScopeInput` type |
| `policy-engine/lib/common/policy-common/mod.ts` | add `PolicyScopeInput`, `scopeCacheKey`, `PolicySpec` builder types; re-export CLI-option types |
| `policy-engine/lib/policies/gha-lite/action-common.ts` | scope-mode branch (read `mode`, `counterparty-did`; prepare trust snapshot; call `decide`; fall back to full evaluate on abstain) |
| `policy-engine/lib/policies/gha-lite/workflows/*.yml` | add `mode` + `counterparty-did` `workflow_dispatch` inputs (9 files) |
| `policy-engine/lib/policies/gha-lite/bundled-actions/tangy/*/action.yml` | add `mode` + `counterparty-did` inputs (9 files) |
| `policy-engine/lib/policy-engine-executor-gha-lite/mod.ts` | add `scope()` — run workflow with `mode: scope` inputs |
| `policy-engine/lib/policy-engine-executor-typescript/mod.ts` | add `scope()` — resolve `policies:[{name}]`, run registry `decide` over a snapshot built from ctx resolvers (no worker spawn) |
| `policy-engine/lib/hono-factory-policy-engine/mod.ts` | real `checkScope` (scope lane via registry + scopeCache); per-policy `describe` (names, kinds, perspectives, args schema); drop `workerManifestPermissions` route (lives in deno-worker-sandbox) |
| `policy-engine/hono-policy-engine/mod.ts` | registry = 2 executors (gha-lite, typescript); wire seeder; cli-args-env option surface |
| `policy-engine/lib/policy-seeder-atproto/mod.ts` | definitions for typescript (bundle-backed) + gha-lite records (canonical names); `ensure()` returns refs callers put in `RFP.policies[]` |
| `policy-engine/test/policy_engine_integration_test.ts` | add scope-mode + checkScope + scope-cache invalidation tests |

---

## 3. Rip-out inventory (atproto-market)

### Delete (replaced by policy-engine)

| Path | Replaced by |
|---|---|
| `atproto-market/lib/market-policy/` (`buildPolicyRecord` + `evaluateRfpPolicy` + builtin/service/denoWorker dispatch) | `policy-engine-evaluator` + executor family |
| `atproto-market/lib/market-policy-registry/` | `policy-engine/lib/policies/deno-typescript/registry.ts` |
| `atproto-market/lib/market-policy-engine-worker/` | `TypescriptExecutor` |
| `atproto-market/lib/market-policy-engine-service/` | `ServiceExecutor` |
| `atproto-market/lib/market-policy-{only-me,tangled-vouch,bsky-mutual}/` | `policy-engine/lib/policies/deno-typescript/*` (perspective-split) |
| `atproto-market/lib/market-policy-work/` | `policy-engine/lib/policies/deno-typescript/{under-4-cpus,bid-payload}.ts` |
| `atproto-market/lib/abc/market-policy/` (`PolicyEvalCtx`, `TrustPolicy`, `WorkPolicy`, `PolicyScopeFilter`, `PreFilterInput`, `assertPolicyPerspective`) | `policy-engine` abc + `deno-typescript-shared` |
| `atproto-market/lib/abc/market-policy-trust/` + `atproto-market/lib/market-policy-trust-cache/` | scope verdict cache (policy-engine-scope-cache); `TrustQuery`/`decide` stay in `deno-typescript-shared` |
| `atproto-market/lib/hono-factory-policy-builtin/` | `policy-engine/lib/hono-factory-policy-engine/` |
| `atproto-market/hono-policy/` | `policy-engine/hono-policy-engine/` |
| `atproto-market/lib/hono-factory-market-policy-host/` + `atproto-market/lib/market-policy-host-xrpc/` | retire unless a remote engine needs host call-out (open decision §6.3) |
| `atproto-market/test/create_policy_test.ts`, `evaluate_rfp_policy_test.ts`, `policy_mode_filter_test.ts`, `policy_mutuals_integration_test.ts`, `policy_remote_test.ts`, `policy_tangled_vouch_integration_test.ts` | superseded |

### Keep (re-point, not delete)

| Path | Action |
|---|---|
| `atproto-market/lib/market-bidder/mod.ts` | hot path: remove `trustSet`/`trustCache`/`vouchedDids`/`PolicyScopeFilter`; use `evaluator.scope` + `scopeCache`; firehose trust events → `scopeCache.applyEvent`; `onRfp` → `evaluator.evaluatePolicies` (full-mode) |
| `atproto-market/lib/market-bidder-compute/mod.ts`, `lib/market-bidder-worker/mod.ts` | `evaluateRfpPolicy` → `evaluator.evaluatePolicies` |
| `atproto-market/lib/requester-xrpc/mod.ts` | `buildPolicyRecord` → policy-engine builder; re-check → `evaluator.evaluatePolicies` (re-enable local eval for builtin/denoWorker/gha-lite; keep service via `ServiceExecutor`) |
| `atproto-market/lib/abc/requester/mod.ts`, `lib/abc/market-bidder/mod.ts` | keep `PolicySpec`/`policyEngine`/exec options (types re-exported from policy-engine) |
| `atproto-market/hono-bidder/mod.ts` + `cli-args-env.ts`, `atproto-market/request-vm-ssh/mod.ts` + `cli-args-env.ts` | re-point option imports to `policy-engine-cli-options`; pass `policy`/`policyEngine` into `createMarketBidder`/`runComputeContract` unchanged |
| `atproto-market/lib/compute-contract-gateway-xrpc/mod.ts`, `lib/common/compute-contract-gateway-common/types.ts` | `toPolicySpec`/`parsePolicyArgs` → policy-engine; `GatewayPolicySpec` unchanged |
| `atproto-market/lexicons/.../policies/{builtin,denoWorker,service}.json` + defs | keep; add gha-lite + typescript lexicons from policy-engine (or alias) |
| `atproto-market/lib/common/policy-common/nsids.ts` | keep as compat re-export of policy-engine NSIDs |
| `atproto-market/lib/policy-builtin/` | **untouched** — worker-permission subsystem (deno-worker-sandbox) |

### deno.json workspace (atproto-market)
Remove deleted package entries; add `jsr:@publicdomainrelay/policy-engine-*`, `policy-common`, `policy-deno-typescript*` imports. Same for `digitalocean-bidder/deno.json` (it imports `market-policy-abc`, `market-policy-registry`, `market-bidder` cross-repo).

---

## 4. Phases — concrete steps

Each phase ends green: `deno check` clean in both repos, tests passing.

### Phase 0 — scope-mode core in policy-engine (self-contained, no callers yet)

1. `abc/policy-engine/mod.ts`: add `ScopeInput` + `scope?(input)` on `PolicyEngineExecutor`.
2. `action-common.ts`: scope branch —
   ```ts
   const mode = input("mode") || "full";
   if (mode === "scope") {
     const did = input("counterparty-did");
     const store = createCacheStore();
     const ctx = await createPolicyCtx({ policyName: policy.name, args, perspective, selfDid, rfp: inputJson("rfp"), bid: inputJson("bid"), accept: inputJson("accept"), store });
     const verdict = policy.kind === "trust" ? policy.decide({ did, selfDid, args, query: trustSnapshot(ctx) }) : undefined;
     if (verdict !== undefined) { write allow = verdict; return; }
     // abstain → full evaluate fallback inside this run
   }
   // mode === "full": existing path
   ```
   Add `trustSnapshot(ctx)` — build a sync `TrustQuery` (operatorOf/vouchedBy/trustedOperators/associatedWith/sameOperator/isVouched) by pre-resolving the two DIDs + vouch sets through `ctx` (async, cached in the store). This is the concrete snapshot the `decide` consumes.
3. `workflows/*.yml` + `bundled-actions/*/action.yml`: add `mode` (choice full|scope, default full) + `counterparty-did` inputs. Rebuild bundles: `cd lib/policies/gha-lite && deno task build`.
4. `GhaLiteExecutor.scope`: build the gha-lite request with `mode: scope` + `counterparty-did` in `inputs`, run workflow, map status → `PolicyResult` (reuse `statusToResult`). Return `undefined` only if the workflow cannot express a scope verdict (should not happen for first-party policies).
5. `TypescriptExecutor.scope`: no worker spawn — resolve `policies:[{name}]` → `registry.get(name)` → if trust, run `decide` over a snapshot built from `ScopeInput.resolveOperatorDid/getVouchedDids`; if any policy is a work policy or decides `undefined` → return `undefined` (caller escalates to full evaluate).
6. `policy-engine-scope-cache`: `createScopeCache` + `scopeCacheKey` + `applyEvent` (delete by DID). Unit tests.
7. `policy-engine-evaluator`: `createPolicyEvaluator` with `evaluatePolicies(refs, ctx)` (iterate refs → resolve record → `$type` → executor.execute; all-must-allow) and `scope({ policyIdentity, counterpartyDid, args, perspective, selfDid })` (cache → executor.scope → cache on miss). Unit tests.
8. `hono-factory-policy-engine`: replace deny-checkScope with the scope lane (registry + scopeCache); replace per-$type describe with per-policy (registry names + kind + perspectives + args). Update `hono-policy-engine` CLI registry to 4 kinds. Extend integration test (scope-mode allow/deny, checkScope over HTTP, cache invalidation).

### Phase 1 — bidder hot path (atproto-market `lib/market-bidder/mod.ts`)

9. Remove `trustSet`/`trustCache`/`vouchedDids` construction (lines ~160-188) and `PolicyScopeFilter` construction (400, 469, 486). Remove `resolveOperatorDid`/`isRequesterAssociated` closures (195-223) if only used by the filter.
10. Add `const scopeCache = createScopeCache({...})`. Add `const evaluator = createPolicyEvaluator({ registry: buildRegistry(), resolve, resolveOperatorDid, getVouchedDids, scopeCache, log })`.
11. Bidder scope gate: `config.policy` → the bidder's own policy. Two options (§6.1):
    - minimal: `scopeIdentity = { name: config.policy }` → `evaluator.scope({ policyIdentity, counterpartyDid: rfpAuthor, args: policyArgs, perspective: "bidder", selfDid })`.
    - full: seeder mints the bidder's own policy record; `scopeIdentity = { ref }`.
    RFP firehose watch + accept watch now call `evaluator.scope` (cache-backed) instead of `filter`.
12. Trust firehose watch (`[BADGE_BLUE_KEYS_NSID, VOUCH_NSID, BIDDER_ASSOCIATION_NSID]`): keep `wantedCollections`, replace `trustSet.applyEvent` with `scopeCache.applyEvent`.
13. `onRfp` (`market-bidder-compute/mod.ts`, `market-bidder-worker/mod.ts`): `evaluateRfpPolicy` → `evaluator.evaluatePolicies(rfp.policies, { perspective: "requester", selfDid: rfp author? ... })` — the RFP's policies are requester-minted; the bidder evaluates them to ask "will the requester accept me" (§1 of N+1 doc). Wire `resolve`/`resolveOperatorDid`/`getVouchedDids` from the bidder's atproto client.
14. `createMarketBidder` config: drop `policyMode` remnants; keep `policy` (PolicySpec) + `policyArgs`.

### Phase 2 — executor family + rip-out

15. Wire `buildRegistry` in `hono-policy-engine`: `POLICY_GHA_LITE_NSID → GhaLiteExecutor`, `POLICY_TYPESCRIPT_NSID → TypescriptExecutor`. Remote evaluation = send a gha-lite/typescript record to `hono-policy-engine`'s `evaluatePolicy` (no service record kind).
16. Move CLI-option constants → `policy-engine-cli-options`; re-export from `policy-common` for compat.
17. `buildPolicyRecord` → `policy-engine-evaluator` (mints gha-lite workflow or typescript bundle records; canonicalizes names via `resolvePolicyName`).
18. Delete the atproto-market packages in §3 inventory. Update `atproto-market/deno.json` workspace + imports.
19. Delete the 6 obsolete tests (§3).

### Phase 3 — requester + gateway

22. `requester-xrpc/mod.ts`: `buildPolicyRecord` → evaluator builder; `rfpRecord.policies = [ref]` unchanged; re-check at `:1287` → `evaluator.evaluatePolicies` (drop the service-only narrow; `onlyRemotePolicyExec`/`allowUntrustedPolicyExec` still honored by the evaluator/executors).
23. `request-vm-ssh`: re-point imports; `--policy-engine`/`--only-remote-policy-exec`/`--allow-untrusted-policy-exec` unchanged semantics.
24. `gateway-xrpc`: `toPolicySpec` + `parsePolicyArgs` re-point; `ComputeRequestVMInput.policy`/`policyEngine` unchanged.

### Phase 4 — SPA + digitalocean-bidder + desktop

25. `compute-spa/lib/constants.js`: drop hardcoded `POLICY_NAMES`; fetch `describe` from the engine (needs per-policy describe from Phase 0.8).
26. `social-web-computer/components/swc-request-compute.js`: mint policy records with the set shape + policy-engine NSIDs (`POLICIES_SERVICE_NSID`/`POLICIES_BUILTIN_NSID` → policy-engine lexicons; or gha-lite/typescript via seeder refs).
27. `digitalocean-bidder`: re-point `mod.ts` (`policyNames`), `bidder-manager` (`parsePolicyArgs` → policy-engine), db columns unchanged. `static/js/api.js` `patchPolicy` unchanged.
28. `deno-macos-runner-desktop`: `permissionPolicyHandler` untouched (worker-permission subsystem).

### Phase 5 — seeder + server surface

29. `AtprotoPolicySeeder`: definitions = builtin records (registry names), typescript records (bundle-backed via Phase 0 bundle builder), gha-lite records (workflows). `ensure()` on bidder + requester boot (after OAuth), refs → `RFP.policies[]` and bidder's own scope record.
30. `hono-policy-engine`: seed + serve; cli-args-env option surface (Phase 0.8).

### Phase 6 — tests + workspace hygiene

31. Update surviving atproto-market tests (`bidder_policy_only_me_integration_test`, `bidder_policy_remote_integration_test`, `bidder_cross_platform_integration_test`, `policy_engine_worker_test`, `policy_host_test`, `policy_registry_test`, `policy_server_named_test`, `policy_work_test`, `trust_cache_test`, `oauth_session_transfer_test`) to policy-engine imports.
32. policy-engine tests: scope mode, checkScope, scope-cache invalidation, executor dispatch (4 kinds), seeder upsert, describe shape.
33. `deno check` both repos; run `./scripts/find-all-package.ts | yq -P` to confirm no orphaned packages.

---

## 5. The scope-mode contract (normative)

```ts
// abc/policy-engine/mod.ts
export interface ScopeInput {
  perspective: "bidder" | "requester";
  selfDid: string;
  counterpartyDid: string;
  args: PolicyArgs;
  /** Host resolvers — used by in-process scope (builtin/typescript) to build a
   *  trust snapshot for decide(). gha-lite scope resolves its own (network +
   *  cache inside the action). */
  resolveOperatorDid?: (did: string) => Promise<string | null>;
  getVouchedDids?: (did: string) => Promise<Set<string>>;
}

export interface PolicyEngineExecutor {
  readonly kind: string;
  execute(input: { policyRecord: PolicyRecord; ctx: PolicyEvalCtx; permissions?: Record<string, unknown> }): Promise<PolicyResult>;
  /** Trust-only scope verdict for the hot path / checkScope. undefined = cannot
   *  decide from the scope lane alone; caller escalates to execute(). */
  scope?(input: { policyRecord: PolicyRecord; scope: ScopeInput }): Promise<PolicyResult | undefined>;
}

// policy-engine-scope-cache
export function createScopeCache(opts: { positiveTtlMs?: number; negativeTtlMs?: number; log? }): ScopeCache;
export interface ScopeCache {
  get(identity: PolicyIdentity, counterpartyDid: string, args: PolicyArgs): PolicyResult | undefined;
  set(identity: PolicyIdentity, counterpartyDid: string, args: PolicyArgs, result: PolicyResult): void;
  /** Firehose trust event → drop cached scope verdicts for both DIDs. */
  applyEvent(e: { did: string; rkey: string }): void;
}
```

Every policy workflow must accept `mode` + `counterparty-did`. The scope-mode action MUST NOT touch workload records; it prepares a trust snapshot and calls `decide`. Any first-party policy whose `decide` abstains falls back to a full evaluate within the scope run (still cached).

### 5.1 Legacy name aliasing (settled)

Legacy single-name policies (`only-me`, `tangled-vouch`, `mutuals`) resolve to the perspective-split variant **inferred from the caller's role** — never the other side's. A bidder passing `only-me` gets `bidder-only-me`; a requester gets `requester-only-me`. Wrong-side names fail loud (throw), not silently run.

```ts
// policy-engine-evaluator (re-exported by policy-deno-typescript for registry use)
export function resolvePolicyName(
  registry: PolicyRegistry,
  name: string,
  perspective: PolicyPerspective,   // the CALLER's role: "bidder" | "requester"
): string {
  const direct = registry.get(name);
  if (direct) {
    assertPolicyPerspective(direct, perspective);  // work: declared perspectives[]
    assertTrustSide(name, perspective);            // trust: name prefix bidder-*/requester-*
    return name;
  }
  if (name === "only-me" || name === "tangled-vouch" || name === "mutuals") {
    const canonical = `${perspective}-${name}`;
    if (registry.get(canonical)) return canonical;  // bidder → bidder-only-me; requester → requester-only-me
  }
  throw new Error(`unknown policy "${name}" for ${perspective} side`);
}

function assertTrustSide(name: string, perspective: PolicyPerspective): void {
  if (name.startsWith("bidder-") && perspective !== "bidder") throw new Error(`policy "${name}" is not usable from the ${perspective} side`);
  if (name.startsWith("requester-") && perspective !== "requester") throw new Error(`policy "${name}" is not usable from the ${perspective} side`);
}
```

Perspective sources (who sets it): bidder scope gate → `bidder`; bidder `onRfp` evaluating the requester-minted RFP record → `requester` (the record's policies are the requester's admission criteria); requester minting (`runComputeContract` `policy`) → `requester`, and **`buildPolicyRecord` canonicalizes the name at mint time** so records carry `requester-only-me` etc.; requester re-check → `requester`; `open` → symmetric; work policies (`under-4-cpus`, `bid-payload`) → side-declared via `perspectives[]`, wrong side fails loud. `resolvePolicyName` defends against legacy/pre-refactor single-name records at eval time.

---

## 6. Open decisions

1. **Bidder's own scope policy identity** — registry name (`{name: "bidder-only-me"}`) vs seeded record (`{ref}`). Recommend: start with name (matches current `--policy`), move to seeded record once seeder lands (Phase 5). Bidder policy becomes a published record → requesters can prune fan-out (N+1 §6 open Q1).
2. **`trust` snapshot input** — default off (scope-mode action self-resolves, cached). Opt-in for subprocess-light scope runs; reintroduces host-maintained trust state.
3. **Host call-out (`host.*` NSIDs, `market-policy-host-xrpc`, `hono-factory-market-policy-host`)** — retire if executors receive host ctx directly (this plan assumes yes). If a remote engine must read trust graph, keep the host factory as an optional service.
5. **`checkScope` fail mode for unmappable/custom workflows** — fail-open (admit to full evaluate) vs fail-closed. Recommend fail-open, gated by the existing `--allow-untrusted-policy-exec`.
6. **`workerManifestPermissions` route** — lives in `hono-factory-compute-deno-atproto` (deno-worker-sandbox) already; drop the duplicate from the policy server.
7. **gha-lite subprocess cost** — accept per-novel-party scope run; tighten later via net-only in-process worker (`--net-only` already runs the policy action per README) or the `trust` input.
