---
name: testAll
description: >-
  Run all tests across entire poly-repo org root in parallel.
  Trigger: /testAll, "run all tests", "test everything",
  "test all repos", "run tests everywhere".
---

# testAll

Run `deno run -A scripts/test-all.ts` from org root. Script finds all
workspaces with `*_test.ts` / `*.test.ts` files, runs `deno test` in each
in parallel, reports results as table.

## Workflow

1. Run the script:

```
deno run -A scripts/test-all.ts
```

2. Script outputs a table:

```
| workspace            |  passed |  failed | duration |
| -------------------- | ------- | ------- | -------- |
| hono-pds             |     100 |       0 |      11s |
| deno-worker-sandbox  |      24 |       0 |       5s |
| hono-jsr             |       5 |       0 |       2s |
| -------------------- | ------- | ------- | -------- |
| total                |     129 |       0 |          |
```

3. If any workspace has failures: show the workspace name + count. Offer
   to re-run that workspace individually for details.

4. If a workspace has zero test files: skip it (not listed in table).

## How it works

- Walks org root (maxdepth 5) finding `*_test.ts` / `*.test.ts` files
- Groups files by nearest parent containing `deno.json` (workspace root)
- Runs `deno test --no-check` with full permissions in each workspace
- All workspaces run in parallel via `Promise.all`
- Parses `deno test` stdout for a `ok | N passed | N failed` or
  `FAILED | N passed | N failed` summary line

## Environment setup done automatically

- **codebase-rag-proxy embeddings**: `retrieval-skalex` and
  `hono-codebase-rag-proxy` tests need a real OpenAI-compatible
  `/v1/embeddings` endpoint. The script spawns
  `scripts/fake-embeddings-server.ts` on `localhost:18080` (deterministic
  hash-based vectors, no real model) before running those two workspaces,
  and injects `EMBEDDING_URL=http://localhost:18080/v1` for
  `hono-codebase-rag-proxy` (its default points at a LAN-only address).
  Server is killed after the run.
- **hono-compute-provider container tests**: needs the macOS `container`
  backend running (`container system start`). The script checks
  `container system status` and prints a warning (not a failure) if it's
  down — those tests will show connection-timeout failures, not code bugs,
  when the backend is unavailable. It does NOT auto-start the backend or
  clean up leftover test containers — if `container list` shows a pile of
  leaked `pdr-*` VMs from previous runs, stop+rm them by hand
  (`container stop <id> && container rm <id>`) before rerunning, since a
  large pile can cause IP/resource exhaustion that looks like test flakiness.

## Script flags

- `<org-root>` — override org root as first positional arg (default: cwd)
