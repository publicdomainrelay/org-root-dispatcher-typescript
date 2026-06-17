---
name: statusReport
description: >-
  Report git status of all repos in poly-repo org root.
  Trigger: /statusReport, "repo status", "status of all repos",
  "which repos have unpushed commits", "poly repo status".
---

# poly-repo-status-report

Run `deno run -A scripts/poly-repo-status-report.ts` from org root.
Script finds all git repos under org root (maxdepth 3), checks each:
branch name, ahead/behind remote, staged/unstaged/untracked files,
unpushed commits.

## Workflow

1. Run the script with `--json` for structured output:

```
deno run -A scripts/poly-repo-status-report.ts --json
```

2. If JSON output shows repos with unpushed commits: report them with
   commit hash + message.

3. If JSON output shows repos with dirty working trees (staged,
   unstaged, untracked): report the count. If the user asks for
   details, run `git status --short` or `git diff --stat` in that
   specific repo — do NOT read the script output raw, use targeted
   commands.

4. If any repo has `hasUpstream: false`: flag it — push will fail
   without `git push -u origin <branch>`.

5. Present findings as a summary table. Only dig into details when
   the user asks, or when a repo has a complex state (both staged
   and unstaged changes to same files, merge conflicts, rebase in
   progress).

## Script flags

- `--json` — output JSON array of RepoStatus objects
- `--org-root <path>` — override org root (default: cwd)

## RepoStatus shape (JSON)

```ts
interface RepoStatus {
  path: string;           // relative path from org root
  name: string;           // display name
  branch: string;         // branch name or "DETACHED@<hash>"
  ahead: number;          // commits ahead of upstream
  behind: number;         // commits behind upstream
  hasUpstream: boolean;   // false if no remote tracking branch
  staged: string[];       // "M file.ts", "A file.ts", etc.
  unstaged: string[];     // working-tree modifications
  untracked: string[];    // untracked files
  unpushedCommits: { hash: string; message: string }[];
}
```
