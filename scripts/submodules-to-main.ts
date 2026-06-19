#!/usr/bin/env -S deno run --allow-run --allow-read
/**
 * Update all git submodules to the latest commit on their default branch
 * (main or master), then commit and push the pointer updates.
 */

const ORG_ROOT = new URL("..", import.meta.url).pathname;

interface Submodule {
  sha: string;
  path: string;
  branch: string;
  initialized: boolean;
}

interface UpdateResult {
  path: string;
  oldSha: string;
  newSha: string;
  branch: string;
  ok: boolean;
  error?: string;
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
  };
}

/** Parse "git submodule status" output into structured records */
function parseSubmoduleStatus(raw: string): Submodule[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const m = line.match(/^([ +-])([a-f0-9]{40}) (\S+)(?: \((.*)\))?/);
      if (!m) throw new Error(`Failed to parse submodule line: ${line}`);
      return { sha: m[2], path: m[3], branch: m[4] ?? "", initialized: m[1] !== "-" };
    });
}

/** Detect default remote branch for a repo: main or master */
async function detectDefaultBranch(
  submodulePath: string,
): Promise<string> {
  const cwd = `${ORG_ROOT}${submodulePath}`;

  // Try symbolic-ref first
  const ref = await git(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    cwd,
  );
  if (ref.code === 0) {
    const match = ref.stdout.match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }

  // Fallback: check if origin/main or origin/master exists
  for (const branch of ["main", "master"]) {
    const r = await git(["rev-parse", "--verify", `origin/${branch}`], cwd);
    if (r.code === 0) return branch;
  }

  throw new Error(`Cannot detect default branch for ${submodulePath}`);
}

async function updateSubmodule(sub: Submodule): Promise<UpdateResult> {
  const cwd = `${ORG_ROOT}${sub.path}`;

  try {
    // Fetch latest from origin
    const fetch = await git(["fetch", "origin"], cwd);
    if (fetch.code !== 0) {
      return {
        path: sub.path,
        oldSha: sub.sha,
        newSha: sub.sha,
        branch: "",
        ok: false,
        error: `fetch: ${fetch.stderr}`,
      };
    }

    const branch = await detectDefaultBranch(sub.path);

    // Get latest SHA on default branch
    const latest = await git(
      ["rev-parse", `origin/${branch}`],
      cwd,
    );
    if (latest.code !== 0) {
      return {
        path: sub.path,
        oldSha: sub.sha,
        newSha: sub.sha,
        branch,
        ok: false,
        error: `rev-parse origin/${branch}: ${latest.stderr}`,
      };
    }

    const newSha = latest.stdout;

    if (sub.sha === newSha) {
      return { path: sub.path, oldSha: sub.sha, newSha, branch, ok: true };
    }

    // Checkout and reset to latest
    const checkout = await git(["checkout", branch], cwd);
    if (checkout.code !== 0) {
      return {
        path: sub.path,
        oldSha: sub.sha,
        newSha,
        branch,
        ok: false,
        error: `checkout ${branch}: ${checkout.stderr}`,
      };
    }

    const pull = await git(["pull", "origin", branch], cwd);
    if (pull.code !== 0) {
      return {
        path: sub.path,
        oldSha: sub.sha,
        newSha,
        branch,
        ok: false,
        error: `pull: ${pull.stderr}`,
      };
    }

    return { path: sub.path, oldSha: sub.sha, newSha, branch, ok: true };
  } catch (err) {
    return {
      path: sub.path,
      oldSha: sub.sha,
      newSha: sub.sha,
      branch: "",
      ok: false,
      error: String(err),
    };
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

async function main(): Promise<void> {
  console.log("Fetching submodule list...\n");

  const status = await git(["submodule", "status"], ORG_ROOT);
  if (status.code !== 0) {
    console.error("Failed to get submodule status:", status.stderr);
    Deno.exit(1);
  }

  let subs = parseSubmoduleStatus(status.stdout);

  // Try init uninitialized submodules so git commands work inside them
  for (const s of subs) {
    if (!s.initialized) {
      const init = await git(["submodule", "init", s.path], ORG_ROOT);
      if (init.code !== 0) {
        console.error(`Failed to init submodule ${s.path}: ${init.stderr}`);
      } else {
        const update = await git(["submodule", "update", s.path], ORG_ROOT);
        if (update.code !== 0) {
          console.error(`Failed to update submodule ${s.path}: ${update.stderr}`);
        }
      }
    }
  }

  if (subs.length === 0) {
    console.log("No submodules to update.");
    Deno.exit(0);
  }

  console.log(`Updating ${subs.length} submodule(s) to latest default branch...\n`);

  const results = await Promise.all(subs.map(updateSubmodule));

  // Print results table
  const colPath = Math.max(...results.map((r) => r.path.length), 4);
  const colSha = 10;
  const colBranch = 8;
  const sep =
    `| ${"-".repeat(colPath)} | ${"-".repeat(colSha)} | ${"-".repeat(colSha)} | ${"-".repeat(colBranch)} |`;

  console.log(
    `| ${"path".padEnd(colPath)} | ${"old".padEnd(colSha)} | ${"new".padEnd(colSha)} | ${"branch".padEnd(colBranch)} |`,
  );
  console.log(sep);

  let hasError = false;
  let updated = 0;

  for (const r of results) {
    const mark = r.ok ? " " : "!";
    const changed = r.oldSha !== r.newSha;
    if (changed && r.ok) updated++;

    const indicator = changed ? "→" : "=";
    console.log(
      `| ${(mark + r.path).padEnd(colPath)} | ${shortSha(r.oldSha).padEnd(colSha)} | ${(indicator + " " + shortSha(r.newSha)).padEnd(colSha)} | ${r.branch.padEnd(colBranch)} |`,
    );
    if (!r.ok) {
      console.error(`  ERROR [${r.path}]: ${r.error}`);
      hasError = true;
    }
  }

  console.log(sep);

  if (updated === 0) {
    console.log("\nAll submodules already at latest. Nothing to commit.");
    Deno.exit(hasError ? 1 : 0);
  }

  console.log(`\n${updated} submodule(s) updated. Committing in parent repo...\n`);

  // Stage submodule pointer updates
  const add = await git(["add", ...subs.map((s) => s.path)], ORG_ROOT);
  if (add.code !== 0) {
    console.error("git add failed:", add.stderr);
    Deno.exit(1);
  }

  const commit = await git(
    ["commit", "-m", "chore: update submodule pointers"],
    ORG_ROOT,
  );
  if (commit.code !== 0) {
    const alreadyClean = commit.stderr.includes("nothing to commit") ||
      commit.stdout.includes("nothing to commit");
    if (alreadyClean) {
      console.log("Nothing to commit (submodule pointers unchanged).");
      Deno.exit(hasError ? 1 : 0);
    }
    console.error("git commit failed:", commit.stderr);
    Deno.exit(1);
  }

  const commitHash = await git(["rev-parse", "--short", "HEAD"], ORG_ROOT);
  console.log(`Committed: ${commitHash.stdout}`);

  const push = await git(["push"], ORG_ROOT);
  if (push.code !== 0) {
    console.error("git push failed:", push.stderr);
    Deno.exit(1);
  }

  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], ORG_ROOT);
  console.log(`Pushed to ${branch.stdout}.\n`);

  console.log("Done. All submodules updated to latest main/master.");
  Deno.exit(hasError ? 1 : 0);
}

if (import.meta.main) {
  main();
}
