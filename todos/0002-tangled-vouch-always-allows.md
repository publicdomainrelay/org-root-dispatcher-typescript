# 0002 — tangled-vouch always allows: gha-lite scope lane never surfaces a deny

Status: investigated (no code changed)
Date: 2026-08-04

## Report

tangled-vouch policy issued a bid (bidder side) and an accept (requester side)
when there was NO vouch record between the two accounts. Root cause is NOT a
tangled-vouch logic bug — it's the gha-lite executor: **every scope-mode
evaluation returns `allow: true`** for any workflow that parses and completes.

## The two accounts (current run, tmux 14.0 / 14.1)

- Bidder `did:plc:ocnuqjlzgohypj3zoznermms` (`bobvmbuilder.bsky.social`,
  `--policy tangled-vouch`): **0 vouch records, 0 badgeBlueKeys** (no operator)
- Requester `did:plc:lpfuqerea3deuoyrn7ojser4` (`aliceoa`): vouches
  `7nebcphrbnjegrniycnbvyrk` + `5svqtrhheairglgiiyvutzik`; operator resolves to
  `eoerph3nm7y4vumekqftldrx` / `qsst37q7xfgmvstpdxgowold`

No vouch path ocnuq ↔ lpfuq exists. Yet bidder logged
`dispatch: scope filter done accepted:true` (20:17:20, RFP `3msbtfpfd4s2b`)
after `workflow completed successfully`, and the requester accepted the bid.

## Root cause

The policy action DOES compute the correct deny. Inside
`policy-bidder-tangled-vouch` (bundled gha-lite action), `scopeDecide` →
`decide3` runs against the trust snapshot (ocnuq vouches nobody, eoerph vouches
nobody) → returns `false` → action writes `allow=false` to GITHUB_OUTPUT.

The executor discards it:

1. **Workflow has no fail-on-deny step.**
   `policy-engine/lib/policies/gha-lite/workflows.ts` — `bidder-tangled-vouch`
   workflow is exactly:
   ```
   - uses: tangy/policy-bidder-tangled-vouch@v1   # writes allow=false, exits 0
     id: policy
   - run: echo "allow=... violations=..."          # always exits 0
   ```

2. **statusToResult reads only the terminal exit status.**
   `policy-engine/lib/policy-engine-executor-gha-lite/mod.ts:322`
   `statusToResult()` maps `StatusComplete + exit_status==success` → `{allow:true}`.
   It NEVER reads the action's `allow` output.

3. **Bundled action's `Deno.exit(1)` calls are only for malformed input**
   (bad JSON, missing counterparty-did, missing self-did) — none fire on
   `allow=false`. (`dist/index.js` lines ~9809/9854/9921.)

Net: every gha-lite scope-mode verdict is `allow: true`. tangled-vouch, only-me,
mutuals — all no-ops.

## This is the same root cause as 0001's "only-me allowed aliceoa"

Not a tangled-vouch bug, not an only-me bug — the shared gha-lite executor
never surfaces a deny. The scope gate is a permanent allow.

## Evidence

- Bidder scope filter accepted with zero vouch path:
  `dispatch: scope filter done accepted:true` for RFP `3msbtfpfd4s2b`
  and `3msbt7sy5js2u` (tmux 14.0 scrollback)
- `statusToResult` reads only exit_status (executor mod.ts:322-332)
- Bundled `Deno.exit(1)` only on input errors (dist/index.js)
- Tests: `policy_engine_integration_test.ts` asserts gha-lite deny ONLY via a
  workflow that literally `run: exit 1` (DENY_WORKFLOW) — no test asserts deny
  via an `allow=false` action output. The scope-lane test uses ALLOW_WORKFLOW
  and asserts `allow:true` only.

## Fix (applied 2026-08-04)

### Gate step added to all 9 workflows

Chose option 2 (workflow gate step). Every workflow in
`policy-engine/lib/policies/gha-lite/workflows.ts` + `workflows/*.yml` now ends:

```yaml
- run: echo "allow=${{ steps.policy.outputs.allow }} violations=${{ steps.policy.outputs.violations }}"
- run: test "${{ steps.policy.outputs.allow }}" = "true"
```

The action writes `allow=false` to GITHUB_OUTPUT but exits 0. The gate step's
`test` exits non-zero on `"false"` → step throws → job fails → workflow terminal
status is failure → `statusToResult` returns deny. So the verdict now reaches
the executor.

### Source of truth: workflows/*.yml, generated workflows.ts

The `workflows.ts` static map is now GENERATED (was hand-maintained duplicate;
the claimed `python3 scripts/gen-workflows.py` never existed). New generator:

- `policy-engine/lib/policies/gha-lite/scripts/gen-workflows.ts` — reads
  `workflows/*.yml`, emits `workflows.ts` (name → YAML map).
- `deno.json` tasks: `gen-workflows`, `build` now runs gen-workflows first,
  `check` includes it.
- Regenerate with `deno task gen-workflows` (or `deno task build`).

### Tests

`policy-engine/test/policy_engine_integration_test.ts` additions:
- gate denies when action writes allow=false
- gate allows when action writes allow=true
- every WORKFLOWS entry has the gate step

All 44 policy-engine tests pass.

### Deployment note

`policies-gha-lite` is a JSR package consumed by atproto-market via workspace
path (`../policy-engine/lib/policies/gha-lite/mod.ts`), so the gate propagates
locally. Prod (fedproxy digitalocean-bidder, socialweb.computer) needs the
re-published JSR package to pick it up.

## Re-opened findings (test harness, NOT the gate)

Fixing the gate exposed two latent issues that the always-allow bug had masked:

1. **tangled-vouch integration test was a zombie.** Both the pre-gate passing
   run and post-gate failing run log `vouch_discovery count:0` and
   `delegated_trust_badgeBlueKeys count:0` — the test's mutual-vouch +
   badgeBlueKeys records never resolved in the subprocess. Root: requester DID
   split. OAuth account DID (`did:plc:vjerj...`) writes market records; the
   delegated-trust scan reads `pds.did` (fresh RequesterPDS genesis DID
   `did:plc:zyqq6...`) which has no records. Pre-existing requester OAuth-path
   inconsistency, surfaced by the gate (`accepted:false` → `submitRfp:
   rejected by scope filter`). Fix needs the requester's delegated-trust scan
   to use the OAuth session DID, not the RequesterPDS genesis DID.

2. **prod only-me integration test failed with `no_bids` at 08:37 — before the
   gate change.** Pre-existing environmental failure (live fedproxy reachability),
   not caused by this fix.

## Evidence files

- tmux 14.0/14.1 scrollbacks
- PDS vouch queries: ocnuq=0, lpfuq=2 (7nebc, 5svqtrh), 5svqtrh=5,
  eoerph/qsst37=0
- PDS badgeBlueKeys: ocnuq=0, lpfuq=2 (bidder_associate to eoerph, qsst37)
- `policy-engine/lib/policy-engine-executor-gha-lite/mod.ts` statusToResult
- `policy-engine/lib/policies/gha-lite/workflows.ts` bidder-tangled-vouch YAML
- `policy-engine/lib/policies/gha-lite/bundled-actions/tangy/policy-bidder-tangled-vouch/dist/index.js`
