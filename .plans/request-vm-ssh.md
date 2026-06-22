# request-vm-ssh fixes

## bug

`createRequesterPDS` calls `Deno.serve`. CLI calls `Deno.serve`. Two servers, same port. AddrInUse.

## root cause

impl layer should NOT call `Deno.serve`. CLI's job. Pattern from `hono-bidder/mod.ts`:
factory returns `{ app }`, CLI serves.

Also: relay subscriber works over WebSocket. No local port needed. Default should be relay-only.
Only bind port if explicitly given.

## fix

### 1. `lib/requester-xrpc/mod.ts`

Remove from `createRequesterPDS`:
- `const serverController = new AbortController()`
- `Deno.serve({ port, signal: serverController.signal }, app.fetch)`
- `serverController.abort()` from `stop()`
- `port` param — not needed

### 2. `request-vm-ssh/cli-args-env.json`

port: drop `"default": 8080`. No default → undefined. Relay-only.

### 3. `request-vm-ssh/mod.ts`

Rewrite as thin CLI. Match `hono-bidder/mod.ts` pattern:
- static imports, no dynamic `await import()`
- no `import.meta.main` guard
- no library re-exports
- `function log(severity, message, extra?)` not `createStructuredLogger`
- section separators `// ── name ──`
- `Deno.serve` only if `port !== undefined`

### 4. `request-vm-ssh/deno.json`

Drop `name`, `exports`, `imports`. CLI-only. Add `compile.include`.

### 5. `~/.claude/CLAUDE.md`

Add to ANTI-PATTERNS:
- `Deno.serve` in impl/factory. Only CLI.
- port default in cli-args-env.json for relay-subscriber CLIs. No default.

## verify

1. `--help` → exit 0, no bind
2. no args → relay-only, no AddrInUse
3. `--port 9999` → binds 9999
4. `deno test -A request-vm-ssh/cli_smoke_test.ts` → pass
