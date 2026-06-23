import { walk } from "jsr:@std/fs@^1/walk";
import { relative, resolve } from "jsr:@std/path@^1";

const ORG_ROOT = resolve(Deno.args[0] ?? ".");

interface WorkspaceTests {
  workspace: string;
  testFiles: string[];
}

interface TestResult {
  workspace: string;
  passed: number;
  failed: number;
  duration: string;
  ok: boolean;
}

async function findWorkspacesWithTests(): Promise<WorkspaceTests[]> {
  const workspaces = new Map<string, string[]>();

  for await (const entry of walk(ORG_ROOT, {
    maxDepth: 5,
    includeDirs: false,
    exts: ["ts"],
    match: [/[._]test\.ts$/],
    skip: [/node_modules/, /\.git/, /\.codegraph/],
  })) {
    let dir = resolve(entry.path, "..");
    let denoJsonFound = false;

    while (dir.startsWith(ORG_ROOT)) {
      try {
        const stat = await Deno.stat(resolve(dir, "deno.json"));
        if (stat.isFile) {
          denoJsonFound = true;
          break;
        }
      } catch { /* keep walking up */ }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }

    if (!denoJsonFound) continue;

    const relWorkspace = relative(ORG_ROOT, dir) || ".";
    const relTest = relative(ORG_ROOT, entry.path);

    if (!workspaces.has(relWorkspace)) {
      workspaces.set(relWorkspace, []);
    }
    workspaces.get(relWorkspace)!.push(relTest);
  }

  return Array.from(workspaces.entries()).map(([workspace, testFiles]) => ({
    workspace,
    testFiles,
  }));
}

async function runTests(ws: WorkspaceTests): Promise<TestResult> {
  const cwd = resolve(ORG_ROOT, ws.workspace);
  const cmd = new Deno.Command("deno", {
    args: [
      "test",
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-sys",
      "--unstable-kv",
      "--unstable-worker-options",
      "--no-check",
      ...ws.testFiles.map((f) => relative(cwd, resolve(ORG_ROOT, f))),
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), NO_COLOR: "1" },
  });

  const start = Date.now();
  const { code, stdout } = await cmd.output();
  const duration = `${Math.round((Date.now() - start) / 1000)}s`;

  const output = new TextDecoder().decode(stdout);
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = stripped.match(/ok\s+\|\s+(\d+)\s+passed\s+\|\s+(\d+)\s+failed/);
  const passed = match ? parseInt(match[1]) : 0;
  const failed = match ? parseInt(match[2]) : 0;

  return { workspace: ws.workspace, passed, failed, duration, ok: code === 0 };
}

const workspaces = await findWorkspacesWithTests();

if (workspaces.length === 0) {
  console.log("No test files found under", ORG_ROOT);
  Deno.exit(0);
}

const results = await Promise.all(workspaces.map(runTests));
results.sort((a, b) => a.workspace.localeCompare(b.workspace));

const colWs = Math.max(...results.map((r) => r.workspace.length), 9);
const colPass = 8;
const colFail = 8;
const colDur = 6;

const sep = `| ${"-".repeat(colWs)} | ${"-".repeat(colPass)} | ${"-".repeat(colFail)} | ${"-".repeat(colDur)} |`;

console.log(`| ${"workspace".padEnd(colWs)} | ${"passed".padStart(colPass)} | ${"failed".padStart(colFail)} | ${"duration".padStart(colDur)} |`);
console.log(sep);

let totalPassed = 0;
let totalFailed = 0;

for (const r of results) {
  console.log(
    `| ${r.workspace.padEnd(colWs)} | ${String(r.passed).padStart(colPass)} | ${String(r.failed).padStart(colFail)} | ${r.duration.padStart(colDur)} |`,
  );
  totalPassed += r.passed;
  totalFailed += r.failed;
}

console.log(sep);
console.log(
  `| ${"total".padEnd(colWs)} | ${String(totalPassed).padStart(colPass)} | ${String(totalFailed).padStart(colFail)} | ${"".padStart(colDur)} |`,
);

Deno.exit(totalFailed > 0 ? 1 : 0);
