# change manifest — 2026-06-19

All non-reference repo changes. 2 areas: org-root (poly-repo) + deno-macos-runner.

## org-root

### staged (ready to commit)

3 files:

**`deno-worker-instance.md`** (new, 39 lines)
Plan for new ATProto lexicons:
- `com.publicdomainrelay.temp.compute.deno.workerManifest` — register worker code
- `com.publicdomainrelay.temp.compute.deno.workerInstance` — running instance of manifest
- Both carry badge.blue `signatures` property for cryptographic identity
- Proposed XRPC routes: `registerWorkerManifest`, `runPersistantWorkerInstance`, `executeWorkerInstance`
- CLI hosting modes: XRPC relay, bare port, unix socket

**`tpm.md`** (new, 138 lines)
ATProto-native Attested Workload Identity for federated multi-org compute:
- TPM-based hardware attestation (L1) + provider-asserted (L0) trust
- Proposed `compute-attestation` repo with full ABC layering
- Four-root trust conjunction model
- New lexicons: `referenceValue`, `enrollment`, `instanceIdentity`, `trustGrant`, `attestationResult`, `revocation`
- Veraison per-org attestation verification
- Touches: `typescript-helpers`, `deno-worker-sandbox`, `hono-compute-provider`, `org-root-dispatcher-typescript`

**`tproto-market`** — submodule pointer update (unstaged, not staged despite initial status showing M)

### unstaged (working tree)

6 submodule pointer updates. All same commit theme: `fix: align with CLAUDE.md` — coordinated cleanup across repos. Changes per submodule:

| Submodule | Old hash | New hash | Delta | What changed |
|-----------|----------|----------|-------|-------------|
| `deno-worker-sandbox` | `07c0b72` | `c3e79b9`-dirty | 2 commits | Common naming, cross-concept decoupling. **-dirty**: local uncommitted changes inside submodule |
| `did-key-relay` | `b2fd1c6` | `f62e823` | 1 commit | ABC purity, bare specifiers, config defaults |
| `hono-compute-provider` | `d3c1992` | `2752178` | 1 commit | ABC purity, naming, cross-concept decoupling |
| `hono-jsr` | `f7aac36` | `1fcd096` | 1 commit | Rename packages, fix imports |
| `hono-pds` | `46068af` | `b8ebd93` | 1 commit | Delete duplicate EventBus, fix CLI config |
| `typescript-helpers` | `9ff86a2` | `999c2bb` | 2 commits | Remove Deno.env.get, migrate 4 packages |

Coordinated batch: all repos aligned to CLAUDE.md ABC-layering rules. `deno-worker-sandbox` has uncommitted local work on top — need separate commit before pointer update.

### untracked

| File | What |
|------|------|
| `bidder.log` | Compute bidder output log (ANSI escapes, long lines) |
| `deno-macos-runner/` | Standalone Xcode Swift project — see below |
| `logs.txt` | Mixed log output |
| `rbac.logs` | RBAC-related logs (CRLF) |
| `shim.txt` | Deno shim or test fixture |

All dev artifacts. Should gitignore or delete.

## deno-macos-runner/macOSRunner

Standalone Xcode Swift project (not submodule, has own .git). Single commit `86bea2d` — Initial Commit.

### staged

**`macOSRunner/MacAppAttestManager.swift`** (new, 30 lines)
Swift class wrapping Apple `DCAppAttestService`:
- `generateKey()` → key id string
- `attestKey(_:challenge:)` → attestation data (SHA256-hashes challenge)
- `generateAssertion(_:clientDataHash:)` → assertion data
- `hashChallenge(_:)` → SHA256 digest (helper)
- `isSupported` — pass-through to service

**`macOSRunner/macOSRunner.entitlements`** (new, empty dict)

### unstaged

**`macOSRunner.xcodeproj/project.pbxproj`** (+22 lines)
- Wires `CODE_SIGN_ENTITLEMENTS` → `macOSRunner.entitlements`
- App Sandbox: outgoing network YES, all other capabilities NO

**`macOSRunner/macOSRunner.entitlements`** (+5/-1)
- Populated: `com.apple.developer.devicecheck.app-attest-opt-in` with `CDhash` key
- Enables DeviceCheck App Attest in sandboxed app

### purpose

macOS attestation client. Attests hardware identity via Apple Secure Enclave → feeds attestation into ATProto compute identity system (tpm.md plan). Bridges Apple platform attestation to federated compute trust model.

## action items

1. Commit staged files: `deno-worker-instance.md` + `tpm.md`
2. Commit submodule pointer updates (6 repos). First commit local changes inside `deno-worker-sandbox`
3. Add `bidder.log`, `logs.txt`, `rbac.logs`, `shim.txt` to `.gitignore` or delete
4. Decide: include `deno-macos-runner/` as submodule or keep untracked
5. Inside `deno-macos-runner/macOSRunner`: commit entitlements + pbxproj changes
