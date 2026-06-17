# Self-hosted compute marketplace

Run compute provider + bidder on single machine. Bidder manages atproto
identity, subscribes to RFPs, forwards provisioning to compute provider over
DO-compatible REST API. Compute provider runs Docker containers (or QEMU VMs)
on demand.

## Architecture

```
requester (atproto) --RFP--> bidder --POST /v2/droplets--> compute-provider
                                         (DO-compatible API)
                                                             Docker container
```

Two-process model:

1. **Compute provider** -- HTTP server with DO-compatible `/v2/*` endpoints.
   Provisions Docker containers/VMs. Serves OIDC issuer routes.
   Stateless -- no atproto identity.

2. **Bidder** -- atproto agent. Registers `did:plc`, connects to XRPC relay,
   subscribes to RFPs, auto-responds with bids. On accept, forwards VM spec
   to compute provider.

Bidder injects accept provenance bundle into cloud-init. Compute provider
injects OIDC provisioning exchange. Both land as `write_files` entries in
container cloud-init -- they compose.

## Prerequisites

- [Deno](https://deno.com) 2.x+
- Docker (for local container mode)
- Network access to `xrpc.fedproxy.com` (XRPC relay) and `plc.directory`

## Quick start

### Terminal 1 -- Compute provider

```bash
cd /home/johnandersen777/src/publicdomainrelay
deno run -A hono-compute-provider/hono-compute-provider/mod.ts \
  --provider local \
  --port 8080
```

Starts on `http://localhost:8080`. Serves:

| Route | Method | Description |
|-------|--------|-------------|
| `/v2/account` | GET | Returns team UUID (actx from bearer token) |
| `/v2/droplets` | POST | Provision container/VM |
| `/v2/droplets` | GET | List droplets for caller |
| `/v2/droplets/:id` | GET | Get one droplet |
| `/v2/droplets/:id` | DELETE | Destroy droplet |
| `/.well-known/openid-configuration` | GET | OIDC discovery |
| `/v1/oidc/issue` | POST | Issue OIDC token |
| `/v1/oidc/prove` | POST | Prove container identity |

Any bearer token accepted as `actx` (team UUID). Local mode: no JWT
validation -- token string becomes tenant key.

### Terminal 2 -- Bidder

```bash
cd /home/johnandersen777/src/publicdomainrelay
deno run -A atproto-market/hono-bidder/mod.ts \
  --port 0 \
  --compute-provider digitalocean \
  --compute-provider-token "test" \
  --compute-provider-base-url "http://localhost:8080" \
  --label "my-bidder"
```

At startup:

1. Generates or imports Secp256k1 keypair
2. Registers `did:plc` with service entries for market + compute events
3. Connects to XRPC relay (`xrpc.fedproxy.com`) via WebSocket
4. Creates offering record (so requesters can discover this bidder)
5. Registers with market registry
6. Starts heartbeat (updates discovery record every 60s)

Bidder now ready. Listens for RFPs through relay -- no public port needed.

### Verify running

Bidder logs JSON to stdout. Look for:

```json
{"event":"bidder_did_plc_registered","did":"did:plc:..."}
{"event":"bidder_relay_registered","subdomain":"...","proxyRef":"did:web:..."}
{"event":"registered_with_registry","endpoint":"..."}
```

Compute provider logs structured JSON from `@publicdomainrelay/logger`:

```json
{"level":"info","message":"listening","port":8080}
```

## Persistent identity

By default new `did:plc` registered every run. To reuse identity across
restarts, export private key from first run and pass it back:

```bash
# First run -- note private key hex from startup logs
deno run -A atproto-market/hono-bidder/mod.ts \
  --compute-provider digitalocean \
  --compute-provider-token "test" \
  --compute-provider-base-url "http://localhost:8080"
# Look for: {"event":"bidder_did_plc_registered","did":"did:plc:..."}
# Private key hex derivable from keypair -- save it.

# Subsequent runs
REPO_PRIVATE_KEY_HEX="<64-char-hex>" \
  deno run -A atproto-market/hono-bidder/mod.ts \
    --compute-provider digitalocean \
    --compute-provider-token "test" \
    --compute-provider-base-url "http://localhost:8080"
```

## Options reference

### Compute provider (`hono-compute-provider`)

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--port` | `PORT` | `8080` | Listen port |
| `--provider` | `COMPUTE_PROVIDER` | `local` | `local` or `digitalocean` |
| `--container-mode` | `CONTAINER_MODE` | `true` | Container mode (false = QEMU VM) |
| `--vm-image` | `VM_IMAGE` | `atcr.io/.../ccripoc-qemu-runner` | Image for QEMU mode |
| `--container-image` | `CONTAINER_IMAGE` | `container-runner-ubuntu:latest` | Image for container mode |
| `--cache-dir` | `CACHE_DIR` | -- | Temp file cache |
| `--issuer-url` | `ISSUER_URL` | -- | OIDC issuer base URL (defaults to `http://localhost:<port>`) |
| `--hostname` | `HOSTNAME` | `0.0.0.0` | Bind address |
| `--log-level` | `LOG_LEVEL` | `info` | Min log level |
| `--operator-handle` | `OPERATOR_HANDLE` | `did:plc:localhost` | Operator DID handle |
| `--self-did` | `SELF_DID` | `did:plc:localhost` | This host's own DID |
| `--digitalocean-base-url` | `DIGITALOCEAN_BASE_URL` | `https://droplet-oidc.its1337.com` | DO-compatible API base URL |
| `--do-token` | `DO_TOKEN` | -- | DigitalOcean API token |

### Bidder (`hono-bidder`)

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--port` | `PORT` | `0` | Listen port (0 = random) |
| `--private-key-hex` | `REPO_PRIVATE_KEY_HEX` | -- | Fixed identity key |
| `--plc-directory-url` | `PLC_DIRECTORY_URL` | `https://plc.directory` | PLC directory |
| `--dispatcher-host` | `DISPATCHER_HOST` | `xrpc.fedproxy.com` | XRPC relay host |
| `--label` | `BIDDER_LABEL` | `bidder` | Log/relay label |
| `--compute-provider` | `COMPUTE_PROVIDER` | -- | `local` or `digitalocean` |
| `--compute-provider-token` | `COMPUTE_PROVIDER_TOKEN` | -- | Auth token for provider API |
| `--compute-provider-base-url` | `COMPUTE_PROVIDER_BASE_URL` | -- | Provider API base URL |
| `--registry-endpoint` | `REGISTRY_ENDPOINT` | -- | Market registry endpoint |
| `--heartbeat-interval-ms` | `HEARTBEAT_INTERVAL_MS` | `60000` | Discovery heartbeat |

## Using real DigitalOcean backend

Replace local compute provider with real DO proxy:

```bash
# Terminal 1 -- DO proxy compute provider
deno run -A hono-compute-provider/hono-compute-provider/mod.ts \
  --provider digitalocean \
  --do-token "dop_v1_..." \
  --port 8080

# Terminal 2 -- Bidder pointing at it
deno run -A atproto-market/hono-bidder/mod.ts \
  --compute-provider digitalocean \
  --compute-provider-token "dop_v1_..." \
  --compute-provider-base-url "http://localhost:8080"
```

## Tear down

Ctrl+C in both terminals. Bidder signal handler stops relay connection and
discovery heartbeat. Local compute provider signal handler runs
`docker rm -f` on all active containers.

## How bid config + accept bundle compose

When bidder receives accept, two cloud-init injection layers happen before
container boots:

1. **Bidder** (`injectAcceptBundle`) -- wraps accept provenance (accept URI,
   RFP refs, bid config refs) into `write_files` at
   `/root/secrets/publicdomainrelay.com/market/accept.json`. Container reads
   this to know which contract it fulfills.

2. **Compute provider** (`ProvisioningData.create`) -- wraps OIDC token
   exchange payload into `write_files`. Container authenticates with relay
   after boot (fedproxy-client + websocat).

Both injections append to `write_files` array in cloud-init `user_data`.
Container sees both files on boot. Separation of concerns: bidder owns market
provenance, compute provider owns workload identity.
