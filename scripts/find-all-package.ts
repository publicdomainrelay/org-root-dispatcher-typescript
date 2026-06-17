#!/usr/bin/env -S deno run --allow-read
/**
 * Discover all deno.json packages within repos under the org root.
 * Outputs JSON array of { name, path } — path relative to org root.
 * Skips deno.json files without a "name" field (workspace roots, CLI entrypoints).
 */

const ORG_ROOT = new URL("..", import.meta.url).pathname;

interface PackageEntry {
  name: string;
  path: string;
}

function isExcluded(entry: Deno.DirEntry): boolean {
  return entry.name === ".git" ||
    entry.name === "node_modules" ||
    entry.name === ".reference";
}

async function walkForDenoJson(
  dir: string,
  packages: PackageEntry[],
  repoRoot: string,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    if (isExcluded(entry)) continue;

    const fullPath = `${dir}/${entry.name}`;

    if (entry.isDirectory) {
      await walkForDenoJson(fullPath, packages, repoRoot);
    } else if (entry.name === "deno.json") {
      try {
        const raw = await Deno.readTextFile(fullPath);
        const json = JSON.parse(raw);
        if (typeof json?.name === "string" && json.name.length > 0) {
          packages.push({
            name: json.name,
            path: fullPath.slice(ORG_ROOT.length).replace(/\/deno\.json$/, ""),
          });
        }
      } catch {
        // Skip unreadable or malformed deno.json
      }
    }
  }
}

async function main(): Promise<void> {
  const packages: PackageEntry[] = [];

  for (const entry of Deno.readDirSync(ORG_ROOT)) {
    if (!entry.isDirectory || isExcluded(entry)) continue;

    const repoPath = `${ORG_ROOT}${entry.name}`;
    // Check if repo has a deno.json at its root (it's a Deno workspace)
    try {
      const rootDenoJson = `${repoPath}/deno.json`;
      await Deno.stat(rootDenoJson);
      await walkForDenoJson(repoPath, packages, repoPath);
    } catch {
      // No deno.json at repo root, skip
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  console.log(JSON.stringify(packages, null, 2));
}

if (import.meta.main) {
  main();
}
