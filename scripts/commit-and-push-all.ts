#!/usr/bin/env -S deno run --allow-run --allow-read
/**
 * Commit and push changes across multiple git repos in parallel.
 * Reads JSON from a file or stdin. Reports results as a table.
 *
 * Usage:
 *   deno run -A scripts/commit-and-push-all.ts commits.json
 *   echo '{"repos":[...]}' | deno run -A scripts/commit-and-push-all.ts --stdin
 */

const ORG_ROOT = new URL("..", import.meta.url).pathname;

interface RepoCommit {
  path: string;
  message: string;
  files?: string[];
}

interface CommitInput {
  repos: RepoCommit[];
}

interface CommitResult {
  repo: string;
  commit: string;
  pushed: string;
  ok: boolean;
  error?: string;
}

async function readInput(): Promise<CommitInput> {
  const stdinFlag = Deno.args.includes("--stdin");
  if (stdinFlag) {
    const buf = new Uint8Array(1024 * 1024);
    const n = await Deno.stdin.read(buf);
    if (n === null) throw new Error("No input on stdin");
    return JSON.parse(new TextDecoder().decode(buf.slice(0, n)));
  }
  const filePath = Deno.args[0];
  if (!filePath) throw new Error("Usage: commit-and-push-all.ts <commits.json> or --stdin");
  return JSON.parse(await Deno.readTextFile(filePath));
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

async function commitAndPush(repo: RepoCommit): Promise<CommitResult> {
  const cwd = `${ORG_ROOT}${repo.path}`;
  const name = repo.path;

  try {
    if (repo.files && repo.files.length > 0) {
      for (const f of repo.files) {
        const result = await git(["add", f], cwd);
        if (result.code !== 0) {
          return { repo: name, commit: "-", pushed: "-", ok: false, error: `git add ${f}: ${result.stderr}` };
        }
      }
    } else {
      await git(["add", "-A"], cwd);
    }

    const commit = await git(["commit", "-m", repo.message], cwd);
    if (commit.code !== 0) {
      const alreadyClean = commit.stderr.includes("nothing to commit") ||
        commit.stdout.includes("nothing to commit");
      if (alreadyClean) {
        return { repo: name, commit: "(clean)", pushed: "(skipped)", ok: true };
      }
      return { repo: name, commit: "-", pushed: "-", ok: false, error: commit.stderr };
    }

    const commitHash = await git(["rev-parse", "--short", "HEAD"], cwd);

    const push = await git(["push"], cwd);
    if (push.code !== 0) {
      return { repo: name, commit: commitHash.stdout, pushed: "FAIL", ok: false, error: push.stderr };
    }

    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return { repo: name, commit: commitHash.stdout, pushed: branch.stdout, ok: true };
  } catch (err) {
    return { repo: name, commit: "-", pushed: "-", ok: false, error: String(err) };
  }
}

async function main(): Promise<void> {
  const input = await readInput();

  if (!input.repos || input.repos.length === 0) {
    console.log("No repos to commit.");
    Deno.exit(0);
  }

  const results = await Promise.all(input.repos.map(commitAndPush));

  const colRepo = Math.max(...results.map((r) => r.repo.length), 4);
  const colCommit = 8;
  const colPushed = 8;
  const sep = `| ${"-".repeat(colRepo)} | ${"-".repeat(colCommit)} | ${"-".repeat(colPushed)} |`;

  console.log(`| ${"repo".padEnd(colRepo)} | ${"commit".padEnd(colCommit)} | ${"pushed".padEnd(colPushed)} |`);
  console.log(sep);

  let ok = true;
  for (const r of results) {
    const mark = r.ok ? " " : "!";
    console.log(`| ${(mark + r.repo).padEnd(colRepo)} | ${r.commit.padEnd(colCommit)} | ${r.pushed.padEnd(colPushed)} |`);
    if (!r.ok) {
      console.error(`  ERROR [${r.repo}]: ${r.error}`);
      ok = false;
    }
  }

  console.log(sep);
  Deno.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main();
}
