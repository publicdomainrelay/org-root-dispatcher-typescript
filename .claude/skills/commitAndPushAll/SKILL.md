---
name: commitAndPushAll
description: >-
  Stage, commit, and push changes across multiple git repos under the poly-repo
  org root in parallel. Takes a JSON payload defining repos, commit messages,
  and optional file paths. Trigger: /commitAndPushAll, "commit and push all",
  "commit all repos", "push all changes".
---

# commitAndPushAll

Stage, commit, and push changes across multiple git repos under the org root
in parallel. Each repo runs `git add`, `git commit`, `git push` independently.
Results reported as a table.

## HARD RULES

- **NEVER include reference repos** — any repo under `.reference/` is a
  read-only archive. Do NOT put them in the JSON payload. The script also
  skips them automatically as defense-in-depth, but the agent MUST NOT
  include them in the first place.

## Workflow

1. Build a JSON payload describing what to commit. NEVER include any repo
   whose path starts with `.reference/`:

```json
{
  "repos": [
    {
      "path": "hono-compute-provider",
      "message": "refactor: make ABC layering clean\n\nCo-Authored-By: Claude <noreply@anthropic.com>"
    },
    {
      "path": "deno-worker-sandbox",
      "message": "fix: ...",
      "files": ["lib/common/config.ts", "hono-sandbox/mod.ts"]
    }
  ]
}
```

- `path` — repo directory relative to org root (required)
- `message` — full git commit message (required)
- `files` — paths to `git add` (optional, omit to `git add -A`)

2. Write the JSON to a temp file, then run the script:

```
deno run -A scripts/commit-and-push-all.ts /tmp/commits.json
```

Or pipe it via stdin:

```
echo '{"repos":[...]}' | deno run -A scripts/commit-and-push-all.ts --stdin
```

3. Script outputs a table:

```
| repo                    | commit   | pushed   |
| ----------------------- | -------- | -------- |
| hono-compute-provider   | 9811d64  | main     |
| deno-worker-sandbox     | e45f720  | master   |
| hono-jsr                | ef5dbe0  | master   |
| typescript-helpers      | 0dd0bd0  | main     |
| ----------------------- | -------- | -------- |
```

4. If any repo fails: the row is marked with `!` and the error is printed.
   Offer to re-run that repo individually for details.

## How it works

- Each repo entry spawns `git -C <org-root>/<path>` commands
- All repos run in parallel via `Promise.all`
- `git add -A` when no `files` list; `git add <file>` for each when specified
- Skips push if nothing to commit (clean working tree)
- Non-zero exit if any repo fails

## Script flags

- `<path>` — path to JSON file (first positional arg)
- `--stdin` — read JSON from stdin instead of file
- `--org-root <path>` — not yet supported; org root is script-adjacent
