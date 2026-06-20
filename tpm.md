# Plan: ATProto-native Attested Workload Identity for Federated Multi-Org Compute

## Context

We issue workload identity to each sandbox worker instance (ephemeral in-process Deno Workers and persistent VMs). Identity must be:

1. **Cryptographically bound to the exact bundle SHA** loaded at runtime (not an asserted side-claim).
2. **Hardware-attested** end to end — Secure Boot + TPM measured boot of the host, swtpm measured boot of the guest, runner `tpm2_pcrextend(bundleSha)`, verified by **Veraison (one instance per org)**, gating release of runtime secrets to the worker.
3. **ATProto-native** — identity is a DID, proof on the wire is atproto service-auth JWT, and all trust/delegation/reference-value state is badge.blue-signed atproto records, not a bespoke token format.
4. **Federated** — multiple independent org roots; relying parties decide which org roots they accept.

Two trust populations must coexist via one record set: those requiring cryptographic proof (**L1 tpm-attested**) and those who trust the provider's signature (**L0 provider-asserted**). Identity derivation is identical across both; only the evidence layer differs.

### Reality found in repos (drives reuse, not greenfield)

- `deno-worker-sandbox` already atproto-native: `signComputeServiceAuth`/`verifyComputeServiceAuth` (`lib/compute-deno-atproto/service-auth.ts:19,42`, did:web resolution `:126`), badge.blue `createInlineAttestationForRecord` + low-S (`signing.ts:32,128`), `workerManifest`/`workerInstance` NSIDs (`lib/common/compute-deno-common/nsids.ts:2,3`), runner `start/execute/stopAll` (`instance-runner.ts:19,49,94`), CLI flags `pds-url/attestation-key-path/unix-socket/hostname/relay`.
- `hono-compute-provider` already has the **L0 SSH-prove flow** (the "without-TPM" path): `/v1/oidc/prove` validates droplet SSH host-key signature (`lib/oidc-issuer-hono/mod.ts:362-434,599-635`), RS256 OIDC issuer + `.well-known/openid-configuration`+`/jwks` (`:121-178,539-555`) for **cloud WIF** (`config.wif.simple`), RBAC records `com.fedproxy.rbac` (`lib/rbac-atproto/mod.ts:13-66`), `ComputeProvider` ABC `provision/destroy/createBidConfig/injectAcceptBundle` (`lib/abc/compute-provider/mod.ts:35-48`), qemu boot (`lib/qemu-standalone/mod.ts`) — **no swtpm/OVMF/measured-boot**.
- `hono-pds`: `createRecord/getRecord/listRecords` + FirehoseSequencer + **ephemeral test rig** `allocatePort + Deno.serve + MemoryStorage + MockSigner` (`test/integration_test.ts:19`). PLC directory factory lives in `atproto-market`.
- `typescript-helpers` **missing** `did-plc`, `atproto-helpers`, `atproto-attestation-port`, `utils-attestation-key` despite MIGRATION_STATUS claim — present only in reference POC. **Must port.**

### Decisions

| Fork | Decision |
|------|----------|
| Repo layout | **New repo `compute-attestation`** (clean ABC concept) shared by both tiers |
| Token faces | **Dual** — keep RS256 OIDC for cloud WIF, add atproto service-auth for intra-atproto |
| Plan scope | **Flat full-stack** — L0 + L1 + enrollment + federation as one build |
| Namespace | **`com.publicdomainrelay.temp.compute.*`** (match existing) |
| Instance DID | **did:key**, HKDF-derived per bundle load |
| Owner/deployment DID | **did:plc** (rotation/recovery/audit log) |
| Delegation | **In records, not token** |

## Trust model (per-org Veraison, atproto-native)

Identity derivation, mode-independent, runner-side at bundle load:

```
bundleSha   = sha256(rawBundleBytes)
seed        = HKDF(deploymentDerivationSecret, salt="compute-instance-v1", info=bundleSha)
instanceKey = Ed25519(seed)            ->  instanceDid = did:key:z<pub>
(instanceKey, vrfProof) = VRF_Prove(deploymentVrfSecret, bundleSha)   // 3rd-party verifiable; federated requirement
```

Wire auth is **atproto service-auth JWT** verbatim per spec: `iss=instanceDid`, `aud=did:web:<broker>#compute`, `lxm=<nsid>`, `exp/iat/jti`, `kid=#atproto`, ES256K, verified against DID doc. did:key carries its own verificationMethod, so no directory lookup for the leaf.

Trust decision = conjunction over **four roots**, all resolved as atproto records:

```
trust(req) =
   genuineHardware    // AK quote -> AK cert -> EK -> TPM vendor CA        [X.509, vendor root]
 AND hwBoundToProvider  // enrollment record binds AK -> deploymentDid       [enrollment CA]   L1 only
 AND providerAuthorized // trustGrant(deploymentDid) by an org root in policy [trustGrant registry]
 AND bundleMeasured     // L1: EAR.pcr == bundleSha (Veraison) ; L0: deployment signature on instance record
 AND identityBindsCode  // VRF_Verify(deployment.vrfPub, bundleSha, instanceDid, vrfProof)
```

**Per-org Veraison**: each org runs its own `hono-attestation-verifier` wrapping its Veraison. Cross-org trust = a `trustGrant` record naming the peer's enrollment-CA DID and verifier DID. A peer's EAR is wrapped as a badge.blue `attestationResult` record signed by the verifier's did:web `#atproto` key, so any relying party verifies the EAR signature by resolving the peer DID — no shared Veraison, no central trust.

**Assurance levels** over one record set: L0 omits `attestation`, carries deployment signature as sole evidence; L1 adds TPM quote + EAR. Relying party policy declares `minAssurance`.

## Records / lexicons (`com.publicdomainrelay.temp.compute.*`)

New lexicons (badge.blue `signatures` on each; reuse `network.attested.signature` inline + strongRef remote pattern from `signing.ts`):

- `...referenceValue` — `{artifactName, ociDigest, sha256, version, builderDid, sourceCommit, rekorLogEntry?, createdAt}`; signed by CI/RV publisher.
- `...enrollment` — `{deploymentDid, mode:"tpm"|"asserted", akPub?, ekCertChain?, vrfPub, hostLabel, enrollmentCaDid, createdAt}`.
- `...instanceIdentity` — `{instanceDid, deploymentDid, bundleSha, bundleVersion, referenceValue:strongRef, scope:[nsid], assurance, vrfProof, attestation?:{earRef, quoteRef, pcrSlot, nonce}, expiresAt}`. (Extends today's `workerInstance`.)
- `...trustGrant` — `{trustedDid, role:"owner-root"|"rv-publisher"|"enrollment-ca"|"deployment"|"verifier", forCapability?, requireAssurance, expiresAt}`. **Unifies** what would otherwise be three allowlists; supersedes ad-hoc `com.fedproxy.rbac` for this concept.
- `...attestationResult` — EAR wrapper `{deploymentDid, instanceDid, earJwt, verifierDid, pcr, createdAt}`.
- `...revocation` — `{subject:strongRef, reason, createdAt}` (revoke-by-ref).

## New repo: `compute-attestation`

Poly-repo ABC layout (`~/src/publicdomainrelay/compute-attestation`), registered as org submodule. One `mod.ts` per package, dep arrow `common <- abc <- impl <- factory <- CLI`.

```
lib/common/compute-attestation-common      NSIDs above, wire types, bundleSha helper, four-root result type
lib/abc/attestation-verifier                AttestationVerifier{verifyEvidence->EAR}, ReferenceValueStore,
                                            EnrollmentStore, TrustGrantStore interfaces, pure chain-eval
lib/abc/enrollment-ca                       EnrollmentCa{enroll(ek,ak)->enrollment record} interface
lib/workload-identity-derive                HKDF->did:key + VRF prove/verify (impl; crypto). did:key via @atproto/crypto
lib/attestation-evidence-tpm                runner-side: tpm2 pcrextend + quote + gather EK/AK/eventlog (shell to tpm2-tools)
lib/attestation-verifier-veraison           impl: provision CoRIM from referenceValue records, submit evidence, get EAR
lib/enrollment-ca-tpm                       impl: TPM2_ActivateCredential credential-activation, issue enrollment record
lib/hono-factory-attestation-verifier       routes: submit-evidence, get-EAR, secret-unlock gate; writes attestationResult
hono-attestation-verifier                   CLI: --veraison-url --enrollment-key-path --pds-url --org-root-did
```

Reuse: badge.blue signing + low-S from `deno-worker-sandbox/lib/compute-deno-atproto/signing.ts` (promote to `typescript-helpers/lib/atproto-attestation-port` so both repos share); record CRUD via `hono-pds` `createRecord/getRecord/listRecords`; CLI via `@publicdomainrelay/cli-args-env`; logger/error-middleware from `typescript-helpers`.

## Changes to existing repos

**`typescript-helpers`** (port from reference POC, confirmed absent):
- `lib/did-plc` — create genesis (`rotationKeys/verificationMethods/services/prev/sig`, DAG-CBOR + ECDSA-SHA256 low-S), resolve, rotate, audit-log read. Owner/deployment tier.
- `lib/atproto-helpers` — service-auth create/verify, did:web/did:plc resolve. Dedup with sandbox `service-auth.ts`.
- `lib/atproto-attestation-port` — badge.blue sign/verify (moved out of sandbox `signing.ts`; add `attestSubjectDid` to sign a DID, not just a record).
- `lib/utils-attestation-key` — `loadOrCreateAttestationKeyHex`, derivation-secret + vrf-secret load.

**`deno-worker-sandbox`**:
- `instance-runner.ts:19` `start()`: compute `bundleSha`; derive `did:key` via `workload-identity-derive`; L1 -> `tpm2_pcrextend` + quote via `attestation-evidence-tpm` + Veraison call; write `instanceIdentity` record with `assurance`.
- `service-auth.ts:42` `verifyComputeServiceAuth`: after JWT verify, resolve `instanceIdentity` record + run four-root conjunction (`trustGrant` lookup, VRF verify, EAR/PCR check) instead of bare did:web trust.
- Add new lexicons under `lexicons/`; extend `nsids.ts`.
- CLI flags: `--derivation-secret-path --vrf-secret-path --enrollment-record --veraison-url --min-assurance`.

**`hono-compute-provider`** (dual token + L1):
- `oidc-issuer-hono/mod.ts` `/v1/oidc/issue`: gate on attestation verdict (EAR via `compute-attestation`) **and** `trustGrant`, not SSH-prove alone. Keep SSH-prove path as L0. Keep RS256 OIDC + discovery for cloud WIF unchanged.
- Add **sibling** atproto service-auth issuer (ES256K/did/lxm) for atproto consumers — new factory package, not a flag in the OIDC one.
- `ComputeProvider.provision` (`lib/abc/compute-provider/mod.ts:35`): write `enrollment` record (mode `tpm` via enrollment-CA, or `asserted`).
- `qemu-standalone/mod.ts`: add **sibling** boot path with swtpm + OVMF SecureBoot + **bootc** qcow2 (via `bootc-image-builder`); do not branch existing distro configs.
- `rbac-atproto`: migrate role/policy semantics into `trustGrant`, or keep `com.fedproxy.rbac` for OIDC RBAC and add `trustGrant` for chain roots (lower-risk; decide at impl).

**`org-root-dispatcher-typescript`** (CI/CD measure): submodule builds -> `podman build` OCI image -> cosign sign + Rekor -> write `referenceValue` record (ociDigest + sha256 + rekor) to PDS. Image digest is the reference value; only our layers (runner, bundle handling) need RVs.

**bootc**: Containerfile + `bootc-image-builder` pipeline; output qcow2 consumed by qemu sibling boot path. ostree+composefs+fs-verity give continuous block integrity (free substitute for hand-authored IMA). Reuse Fedora/bootc `systemd-cryptenroll` TPM2-PCR-policy pattern, pointed at the secret-unlock broker instead of dm-crypt.

## Open / risky (call out, not hand-wave)

- **Enrollment credential-activation** — `TPM2_ActivateCredential` proving AK+EK same TPM; who runs the per-org enrollment CA. Fiddliest crypto. Lives in `lib/enrollment-ca-tpm`.
- **swtpm state sealing** — must seal guest-TPM state to host PCRs or a tampered host mints fake guest-TPM state. Needs a rollback negative test.
- **Derivation + VRF secrets** — now as sensitive as the signing key (whoever holds them mints identities for any SHA). Same blast radius as `attestation-key-path`.
- **L0 not tamper-evident** — policy must make L0/L1 distinction unmissable so no RP accepts L0 thinking it got hardware proof.
- **version->SHA is a publisher assertion**, not hardware-vouched — name it in the record's signer trust.

## Verification (end to end)

1. **Unit**: `deno test` per new package. `workload-identity-derive` — same `bundleSha` -> same did:key; VRF prove/verify round-trip; different SHA -> different DID.
2. **Ephemeral integration** (reuse `hono-pds/test/integration_test.ts:19` rig + `atproto-market` PLC directory): spin ephemeral PLC directory + local PDS; register `referenceValue` + `enrollment` + `trustGrant`; bring up a worker via `instance-runner`; assert `instanceIdentity` record written, service-auth JWT verifies, four-root conjunction passes at L0.
3. **L1 path**: with software TPM (swtpm) in CI, run measured boot + `tpm2_pcrextend(bundleSha)` + Veraison verify; assert EAR PASS and `pcr==bundleSha`; assert secret released only on PASS, withheld on mismatch/stale nonce.
4. **Federation**: two ephemeral orgs, each own Veraison; org A `trustGrant` names org B verifier/enrollment-CA; assert A accepts a B-rooted chain and rejects one with no grant.
5. **Dual token**: assert RS256 OIDC token still validates via `.well-known/openid-configuration` (cloud WIF unbroken) and atproto service-auth JWT validates via DID doc.

## Critical files

- New: `compute-attestation/**` (layout above).
- `deno-worker-sandbox/lib/compute-deno-atproto/{instance-runner,service-auth,signing}.ts`, `lib/common/compute-deno-common/nsids.ts`, `lexicons/`, `hono-compute-deno/cli-args-env.json`.
- `hono-compute-provider/lib/oidc-issuer-hono/mod.ts`, `lib/abc/compute-provider/mod.ts`, `lib/qemu-standalone/mod.ts`, `lib/rbac-atproto/mod.ts`.
- `typescript-helpers/lib/{did-plc,atproto-helpers,atproto-attestation-port,utils-attestation-key}` (port).
- `org-root-dispatcher-typescript` CI workflows (referenceValue emission).
