#!/usr/bin/env -S deno run -A

const ORG_ROOT_DEFAULT = Deno.cwd();
const MAX_DEPTH = 3;

interface RepoStatus {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  unpushedCommits: { hash: string; message: string }[];
}

function usage(): never {
  console.error("Usage: deno run -A scripts/poly-repo-status-report.ts [--json] [--org-root <path>]");
  Deno.exit(1);
}

function parseArgs(): { json: boolean; orgRoot: string } {
  let json = false;
  let orgRoot = ORG_ROOT_DEFAULT;
  const args = [...Deno.args];
  while (args.length > 0) {
    const arg = args.shift()!;
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--org-root":
        orgRoot = args.shift() || usage();
        break;
      case "--help":
        usage();
        break;
      default:
        console.error(`Unknown flag: ${arg}`);
        usage();
    }
  }
  return { json, orgRoot };
}

async function run(cmd: string, cwd: string): Promise<string> {
  const proc = new Deno.Command("bash", {
    args: ["-c", cmd],
    cwd,
    stdout: "piped",
    stderr: "null",
  });
  const { stdout } = await proc.output();
  return new TextDecoder().decode(stdout).trim();
}

async function findRepos(orgRoot: string): Promise<string[]> {
  const output = await run(
    `find . -maxdepth ${MAX_DEPTH} -name .git \\( -type d -o -type f \\) -not -path '*/.claude/*' | sed 's|/.git||' | sort`,
    orgRoot,
  );
  return output.split("\n").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
}

async function getGitStatus(repoRelPath: string, orgRoot: string): Promise<RepoStatus> {
  const fullPath = `${orgRoot}/${repoRelPath}`;
  const name = repoRelPath === "." ? "org-root" : repoRelPath;

  let branch: string;
  try {
    branch = await run("git branch --show-current", fullPath);
    if (!branch) {
      const head = await run("git rev-parse --short HEAD", fullPath);
      branch = `DETACHED@${head}`;
    }
  } catch {
    branch = "UNKNOWN";
  }

  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  try {
    const aheadStr = await run(
      "git rev-list --count @{u}..HEAD 2>/dev/null",
      fullPath,
    );
    const behindStr = await run(
      "git rev-list --count HEAD..@{u} 2>/dev/null",
      fullPath,
    );
    if (aheadStr !== "") {
      ahead = parseInt(aheadStr, 10);
      behind = parseInt(behindStr, 10);
      hasUpstream = true;
    }
  } catch {
    /* no upstream */
  }

  const statusOut = await run("git status --short", fullPath);
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const line of statusOut.split("\n").filter(Boolean)) {
    const idx = line.substring(0, 2);
    const file = line.substring(3);
    if (idx === "??") {
      untracked.push(file);
    } else {
      if (idx[0] !== " ") staged.push(`${idx[0]} ${file}`);
      if (idx[1] !== " ") unstaged.push(`${idx[1]} ${file}`);
    }
  }

  let unpushedCommits: { hash: string; message: string }[] = [];
  if (hasUpstream && ahead > 0) {
    const logOut = await run("git log --oneline @{u}..HEAD", fullPath);
    unpushedCommits = logOut.split("\n").filter(Boolean).map((line) => {
      const spaceIdx = line.indexOf(" ");
      return {
        hash: line.substring(0, spaceIdx),
        message: line.substring(spaceIdx + 1),
      };
    });
  }

  return {
    path: repoRelPath,
    name,
    branch,
    ahead,
    behind,
    hasUpstream,
    staged,
    unstaged,
    untracked,
    unpushedCommits,
  };
}

function countDirty(s: RepoStatus): number {
  return s.staged.length + s.unstaged.length + s.untracked.length;
}

function printTextReport(statuses: RepoStatus[], orgRoot: string): void {
  console.log(`Status across org root (${orgRoot}):`);
  console.log();

  const namePad = Math.max(...statuses.map((s) => s.name.length), 4);

  console.log(
    `${
      "Repo".padEnd(namePad)
    } | Branch           | Ahead | Behind | Dirty | Unpushed`,
  );
  console.log(
    `${"-".repeat(namePad)}-|------------------|-------|--------|-------|----------`,
  );

  for (const s of statuses) {
    const upstream = s.hasUpstream ? "" : " (no-upstream)";
    const dirty = countDirty(s) > 0 ? `${countDirty(s)} files` : "clean";
    const unpushed = s.unpushedCommits.length > 0
      ? `${s.unpushedCommits.length} commit(s)`
      : "-";

    console.log(
      `${
        s.name.padEnd(namePad)
      } | ${(s.branch + upstream).padEnd(16)} | ${String(s.ahead).padStart(5)} | ${
        String(s.behind).padStart(6)
      } | ${dirty.padEnd(5)} | ${unpushed}`,
    );
  }

  const unpushedRepos = statuses.filter((s) => s.unpushedCommits.length > 0);
  if (unpushedRepos.length > 0) {
    console.log();
    console.log("--- UNPUSHED COMMITS ---");
    for (const s of unpushedRepos) {
      console.log(
        `${s.name}  +${s.ahead} ahead of origin/${s.branch}:`,
      );
      for (const c of s.unpushedCommits) {
        console.log(`  ${c.hash} ${c.message}`);
      }
    }
  }

  const dirtyRepos = statuses.filter((s) => countDirty(s) > 0);
  if (dirtyRepos.length > 0) {
    console.log();
    console.log("--- UNCOMMITTED WORK ---");
    for (const s of dirtyRepos) {
      if (s.staged.length > 0) {
        console.log(`${s.name} staged:`);
        for (const f of s.staged) console.log(`  ${f}`);
      }
      if (s.unstaged.length > 0) {
        console.log(`${s.name} unstaged:`);
        for (const f of s.unstaged) console.log(`  ${f}`);
      }
      if (s.untracked.length > 0) {
        console.log(`${s.name} untracked:`);
        for (const f of s.untracked) console.log(`  ${f}`);
      }
    }
  }

  const noUpstream = statuses.filter((s) => !s.hasUpstream);
  if (noUpstream.length > 0) {
    console.log();
    console.log("--- NO UPSTREAM ---");
    for (const s of noUpstream) {
      console.log(
        `${s.name}: push needs 'git push -u origin ${s.branch}' first`,
      );
    }
  }
}

async function main(): Promise<void> {
  const { json, orgRoot } = parseArgs();

  const repoPaths = await findRepos(orgRoot);

  if (repoPaths.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log(`No git repos found under ${orgRoot}`);
    }
    return;
  }

  const statuses: RepoStatus[] = [];
  for (const rp of repoPaths) {
    statuses.push(await getGitStatus(rp, orgRoot));
  }

  if (json) {
    console.log(JSON.stringify(statuses, null, 2));
  } else {
    printTextReport(statuses, orgRoot);
  }
}

main();
