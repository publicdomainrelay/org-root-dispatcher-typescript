# CI/CD

## Workflows

| Workflow | File | Trigger | What it does |
|----------|------|---------|-------------|
| **Test** | `.github/workflows/test.yml` | push/PR to main | 7 smoke tests + 5 `deno check` type-checks |
| **Build** | `.github/workflows/build.yml` | push to main | `deno compile` 13 binaries for linux-x64 + macos-arm64, upload artifacts |
| **Release** | `.github/workflows/release.yml` | Build completes on main | Downloads build artifacts, creates GitHub Release tagged `latest` |
| **Deploy** | `.github/workflows/deploy.yml` | push to main | opkssh → SSH deploy to 6 `*.fedproxy.com` hosts |
| **Desktop** | `.github/workflows/desktop.yml` | push to main | macOS `.app` bundle + cross-platform `hono-desktop` binary, releases as `desktop-latest` |

## Test Workflow

Runs on every push to `main` and every pull request.

**Smoke tests (7):**
- `request-vm-ssh` CLI smoke test
- `hono-pds` CLI smoke test
- `hono-compute-provider` CLI smoke test
- `typescript-helpers` CLI smoke test
- `deno-worker-sandbox` CLI smoke test
- `did-key-relay` tunnel test
- `hono-jsr` CLI smoke test

**Type checks (5):**
- `request-vm-ssh/mod.ts`
- `hono-bidder/mod.ts`
- `hono-pds/main.ts`
- `hono-compute-contract-gateway/mod.ts`
- `hono-policy/mod.ts`

## Build Workflow

Compiles 13 binaries on every push to `main`. Matrix build across:
- `ubuntu-latest` → `x86_64-unknown-linux-gnu`
- `macos-latest` → `aarch64-apple-darwin`

**Binaries produced:**
- `request-vm-ssh` — Requester CLI
- `hono-bidder` — Bidder CLI
- `compute-contract-gateway` — Gateway CLI
- `hono-policy` — Policy engine CLI
- `hono-pds` — PDS server
- `hono-did-key-relay-relayer` — Relay dispatcher
- `hono-did-key-relay-subscriber` — Relay subscriber client
- `tunnel-subscriber` — In-VM tunnel agent
- `tunnel` — SSH ProxyCommand client
- `hono-compute-provider` — Compute provider
- `hono-compute-deno` — Deno worker XRPC server
- `hono-sandbox` — Ephemeral sandbox server
- `hono-http-static` — Static file server

Artifacts uploaded as `deno-binaries-linux-x64` and `deno-binaries-macos-arm64`.

## Release Workflow

Triggers when Build workflow completes successfully on `main`. Downloads all build artifacts, moves `latest` tag, creates GitHub Release with all binaries attached. Uses `softprops/action-gh-release@v2`.

## Deploy Workflow

Uses opkssh (OpenPubkey SSH) for keyless SSH to production hosts. Each deploy step has `continue-on-error: true` so one failure doesn't block others.

**Deploy targets:**
| Service | Host | Command |
|---------|------|---------|
| Fedproxy (Go reverse proxy) | `deploy@fedproxy.com` | `bash scripts/deploy.sh` |
| Compute SPA | `deploy@compute.fedfork.com` | `bash scripts/deploy.sh` |
| QR associator | `deploy@qr.fedfork.com` | `bash scripts/deploy.sh` |
| Tray app | `deploy@tray.fedfork.com` | `bash scripts/deploy.sh` |
| Market relay | `deploy@reg.market.fedfork.com` | `deno run -A hono-atproto-relay/mod.ts` |
| JSR registry | `deploy@jsr.fedfork.com` | `deno run -A hono-package-registry/main.ts` |

## Desktop Build Workflow

Runs on `macos-14` (Apple Silicon). Produces:
- **macOS `.app` bundle** — `deno desktop --no-check --allow-all` → zipped
- **Cross-platform `hono-desktop` binary** — `deno compile` for macOS + Linux

Releases as GitHub Release tagged `desktop-latest`. Requires Deno Desktop runtime for the `.app` bundle.

## Local Dev Stack (ephemeral)

For local testing, all infrastructure can be run in ephemeral mode:

```bash
# Single process (everything in one):
cd atproto-market
deno run --allow-all compute-contract-full-flow/run_full_flow.ts

# Or 6 terminals (full stack):
# T1: deno run -A did-key-relay/hono-did-key-relay-relayer/mod.ts --hostname localhost --port 5555
# T2: deno run -A atproto-relay/hono-atproto-relay/mod.ts --port 2584 --local-dev-relay-port 5555
# T3: deno run -A hono-pds/main.ts --port 2583
# T4: deno run -A hono-jsr/hono-package-registry/main.ts --base-dir .. --port 5556 --no-passthrough
# T5: deno run -A atproto-market/hono-bidder/mod.ts --compute-provider-local --relay-dispatcher-host localhost:5555
# T6: deno run -A atproto-market/request-vm-ssh/mod.ts --dispatcher-host localhost:5555 --bid-window-sec 3
```

## Required Secrets

| Secret | Used by | Purpose |
|--------|---------|---------|
| `GITHUB_TOKEN` | Release, Desktop | `gh release` + artifact download |
| `CF_API_TOKEN` | Deploy (fedproxy) | Cloudflare API (fedproxy deploys reference this) |

Deploy workflow uses opkssh (no static SSH keys — ephemeral OpenPubkey certificates).

## Reference

- `atproto-reverse-proxy/.github/workflows/` — reference deploy + release patterns (Go/GoReleaser)
- `hono-compute-provider/.github/workflows/ci.yml` — existing per-repo CI
- `hono-jsr/.github/workflows/ci.yml` — existing per-repo CI

## TODO

- [ ] Add integration test job (bidder + requester container test)
- [ ] Add `deno lint` step
- [ ] Add cross-platform Windows build target for release
- [ ] Per-repo CI workflows (hono-pds, did-key-relay, deno-worker-sandbox)
- [ ] PR preview deploy for SPA
- [ ] E2E test against staging environment
