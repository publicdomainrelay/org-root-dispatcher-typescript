# State Report — publicdomainrelay monorepo

2026-06-17. 32 packages. Stateful = exports class/factory holding mutable Maps/Sets/arrays surviving across requests. Stateless = pure functions, interfaces, constants, CLI entrypoints, Hono middleware.

## Stateful (16)

| # | Package | State holder | What it stores |
|---|---------|-------------|----------------|
| 1 | `@publicdomainrelay/atproto-repo-abc` | `Mst` class | `Map<string, Cid>` all entries, tree root, node cache |
| 2 | `@publicdomainrelay/atproto-repo-common` | `EventBus<T>` class | `Set<(msg: T) => void>` subscribers |
| 3 | `@publicdomainrelay/atproto-repo-deno` | `MemoryStorage` class | 2× `Map` — blocks by CID, heads by DID |
| 4 | `@publicdomainrelay/atproto-repo-deno` | `DenoKvStorage` class | `Deno.Kv` handle (external state) |
| 5 | `@publicdomainrelay/atproto-repo-deno` | `Repo` class | Mst + Storage refs |
| 6 | `@publicdomainrelay/cli-args-env` | `Command` class | `options: Record` + 4 private config fields (init-time) |
| 7 | `@publicdomainrelay/event-bus` | `EventBus<T>` class | `Set<(msg: T) => void>` subscribers |
| 8 | `@publicdomainrelay/compute-provider-digitalocean` | `createDigitalOceanComputeProvider` factory | `Map<string\|number, StrongRef>` rbacByProvider |
| 9 | `@publicdomainrelay/compute-provider-local` | `createLocalComputeProvider` factory | `Map<string\|number, StrongRef>` rbacByProvider |
| 10 | `@publicdomainrelay/hono-factory-atproto-repo-deno` | `FirehoseSequencer` class | `SequencedFrame[]` backlog, `number` seq, `EventBus` |
| 11 | `@publicdomainrelay/hono-factory-compute-provider-digitalocean` | `createComputeProviderDigitalOceanFactory` factory | `Map<string, Map<number, Droplet>>` dropletsByActx |
| 12 | `@publicdomainrelay/hono-factory-compute-provider-local` | `createComputeProviderLocalFactory` factory | `Map<string, Map<string, Droplet>>` dropletsByActx |
| 13 | `@publicdomainrelay/oidc-issuer` | `createMemoryNonceStore()` + module-level `jwksCache` | `Map<string, string>` nonces; `Map` JWKS cache |
| 14 | `@publicdomainrelay/hono-jsr-package-store-local-fs` | `createLocalFsStore` factory | `Map<string, …>` denoJsonIndex (module-scoped cache) |
| 15 | `@publicdomainrelay/hono-jsr-package-store-remote-git` | `createRemoteGitStore` factory | `Map` discoveryCache (module-scoped) |
| 16 | `@publicdomainrelay/sandbox-common` | `Command` class | Config/args parsing state (init-time only) |

## Stateless (16)

| # | Package | What it does |
|---|---------|-------------|
| 1 | `@publicdomainrelay/compute-provider-abc` | Interface `ComputeProvider` + env helpers |
| 2 | `@publicdomainrelay/compute-provider-common` | Constants only |
| 3 | `@publicdomainrelay/hono-compute-provider` | CLI entrypoint — build factory, serve |
| 4 | `@publicdomainrelay/hono-error-middleware` | Hono middleware — pure per-request |
| 5 | `@publicdomainrelay/hono-factory-sandbox-deno` | Hono factory — wires routes |
| 6 | `@publicdomainrelay/hono-factory-static-files-fs` | Hono factory — serves files from disk |
| 7 | `@publicdomainrelay/hono-http-static` | CLI entrypoint |
| 8 | `@publicdomainrelay/hono-jsr-factory-package-registry` | Hono factory — delegates to store |
| 9 | `@publicdomainrelay/hono-jsr-package-registry` | CLI entrypoint |
| 10 | `@publicdomainrelay/hono-jsr-package-store-abc` | Interface `PackageStore` — types only |
| 11 | `@publicdomainrelay/hono-jsr-package-store-composite` | `createCompositeStore` — temp Maps in `list()` but no retained state |
| 12 | `@publicdomainrelay/hono-sandbox` | CLI entrypoint |
| 13 | `@publicdomainrelay/http-error` | `HTTPError` extends `Error` — value object |
| 14 | `@publicdomainrelay/logger` | Pure logging functions |
| 15 | `@publicdomainrelay/sandbox-abc` | Interface `Sandbox` — types only |
| 16 | `@publicdomainrelay/sandbox-deno` | `createDenoSandbox` — new Worker per `execute()`, no pool |
| 17 | `@publicdomainrelay/rbac-atproto` | Pure functions — `buildRbacRecord`, `configureRbac`, `deleteRbac` |
| 18 | `@publicdomainrelay/rbac-git` | Pure async functions — `configureRbac` (file I/O, no retained state) |

## Findings

State clusters in three areas:
- **Storage** (`atproto-repo-*`) — MST tree, block/head Maps, EventBus
- **Compute provider** (`compute-provider-*`, `hono-factory-compute-provider-*`) — droplet tracking Maps, RBAC ref Maps
- **Shared infra** (`event-bus`, `cli-args-env`, `oidc-issuer`) — subscriber Sets, nonce Maps, JWKS cache
- **Package stores** (`package-store-local-fs`, `package-store-remote-git`) — module-scoped index/discovery caches

Duplicate `EventBus` in both `typescript-helpers/lib/event-bus/` and `hono-pds/lib/common/event-bus.ts`. Should deduplicate into typescript-helpers per CLAUDE.md cross-repo rule.
