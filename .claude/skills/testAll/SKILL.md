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
- Parses `deno test` stderr for `ok | N passed | N failed` summary

## Script flags

- `--org-root <path>` — override org root (default: cwd, passed as first positional arg)
