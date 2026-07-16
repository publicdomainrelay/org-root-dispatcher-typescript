#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run

/**
 * Parse Claude Code session logs, extract user messages for directories
 * under given paths. Output JSON to stdout.
 *
 * Usage:
 *   deno run --allow-read --allow-env parse-claude-sessions.ts ~/src/publicdomainrelay ~/.tmp/tmp.zeTVc7rG10/org-root-dispatcher-typescript
 *
 * Output:
 *   { "messages": [{ "cwd": "...", "message": "...", "timestamp": "..." }] }
 */

// ── Helpers ──────────────────────────────────────────────────────────

/** Resolve ~ and relative paths to absolute. */
function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/";
    p = home + p.slice(1);
  }
  // resolve relative to CWD
  if (!p.startsWith("/")) {
    p = `${Deno.cwd()}/${p}`;
  }
  // normalize: drop trailing slash, resolve .. and .
  const parts = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return "/" + resolved.join("/");
}

/** Encode a filesystem path to the Claude Code project-dir name.
 *  Both '/' and '.' → '-' so the name is a flat string. */
function encodeProjectDir(absPath: string): string {
  // Drop leading slash — first char becomes '-'
  return absPath.replace(/[\/.]/g, "-");
}

/**
 * Find all project directories under ~/.claude/projects/ whose name
 * starts with the encoded prefix.
 */
function findProjectDirs(projectsRoot: string, prefix: string): string[] {
  const dirs: string[] = [];
  try {
    for (const entry of Deno.readDirSync(projectsRoot)) {
      if (entry.isDirectory && entry.name.startsWith(prefix)) {
        dirs.push(`${projectsRoot}/${entry.name}`);
      }
    }
  } catch {
    // projects dir may not exist
  }
  return dirs;
}

interface UserMessage {
  cwd: string;
  message: string;
  timestamp: string;
}

/**
 * Parse one session JSONL file, extracting user messages whose cwd
 * starts with any of the given target prefixes.
 */
function parseSessionFile(
  filePath: string,
  targetPaths: string[],
): UserMessage[] {
  const results: UserMessage[] = [];
  let text: string;
  try {
    text = Deno.readTextFileSync(filePath);
  } catch {
    return results;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Filter: user-sent message (not tool result, not assistant)
    if (obj.userType !== "external") continue;
    if (obj.type !== "user") continue;

    const message = obj.message as Record<string, unknown> | undefined;
    if (!message) continue;
    if (message.role !== "user") continue;
    // Tool results have content as array; real user messages have string content
    if (typeof message.content !== "string") continue;

    // Skip system-injected messages (not sent by user)
    const content = message.content.trim();
    if (content.startsWith("<local-command-stdout>")) continue;
    if (content.startsWith("<task-notification>")) continue;
    if (content.startsWith("<system-reminder>")) continue;
    if (content.startsWith("<hook-call>")) continue;
    if (content.startsWith("Stop hook feedback:")) continue;
    if (content.startsWith("This session is being continued")) continue;
    if (content.startsWith("A session-scoped Stop hook")) continue;

    // Skip oversized messages (pasted logs, crash reports, plans)
    if (content.length > 1500) continue;

    const cwd = obj.cwd as string | undefined;
    if (!cwd) continue;

    // Check if cwd is under any target path
    const matches = targetPaths.some((tp) =>
      cwd === tp || cwd.startsWith(tp + "/")
    );
    if (!matches) continue;

    results.push({
      cwd,
      message: content,
      timestamp: (obj.timestamp as string) ?? "",
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────

const args = Deno.args;
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.error("Usage: parse-claude-sessions.ts <path> [path...]");
  console.error("  Extract user messages from Claude Code session logs");
  console.error("  for directories under the given paths.");
  Deno.exit(args.length === 0 ? 1 : 0);
}

const targetPaths = args.map(resolvePath);

// Encode each target path → project-dir name prefix
const encodedPrefixes = targetPaths.map(encodeProjectDir);

const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/";
const projectsRoot = `${home}/.claude/projects`;

// Find all matching project dirs
const projectDirs = encodedPrefixes.flatMap((prefix) =>
  findProjectDirs(projectsRoot, prefix)
);
// Dedup
const uniqueDirs = [...new Set(projectDirs)];

if (uniqueDirs.length === 0) {
  console.error("No matching session directories found.");
  Deno.exit(1);
}

// Collect all .jsonl files
const jsonlFiles: string[] = [];
for (const dir of uniqueDirs) {
  try {
    for (const entry of Deno.readDirSync(dir)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        jsonlFiles.push(`${dir}/${entry.name}`);
      }
    }
  } catch {
    // skip unreadable dirs
  }
}

// Parse and collect
const allMessages: UserMessage[] = [];
for (const file of jsonlFiles) {
  const msgs = parseSessionFile(file, targetPaths);
  allMessages.push(...msgs);
}

// Sort by timestamp
allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

// Output
console.log(JSON.stringify({ messages: allMessages }, null, 2));
