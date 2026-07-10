#!/usr/bin/env -S deno run --allow-read --allow-env

// Merge timestamped JSON-line logs from requester and bidder into a single
// chronological timeline. Feed in log files or pipe from tmux capture-pane.
//
// Usage:
//   deno run scripts/merge-logs.ts requester.log bidder.log
//   tmux capture-pane -t 14.0 -p -S -200 | deno run scripts/merge-logs.ts -r - bidder.log
//   deno run scripts/merge-logs.ts --json requester.log bidder.log  # raw JSON output

interface LogLine {
  ts: string;
  timestamp: number; // epoch ms
  source: string;
  level: string;
  message: string;
  prefix?: string;
  raw: string;
}

function parseLine(line: string, source: string): LogLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Handle non-JSON lines (shell prompts, command echo, etc.)
  if (!trimmed.startsWith("{")) {
    // Shell prompt line — still include for context
    return {
      ts: "",
      timestamp: 0,
      source,
      level: "shell",
      message: trimmed.replace(/^\$\s*/, ""),
      raw: trimmed,
    };
  }
  try {
    const obj = JSON.parse(trimmed);
    const ts = obj.ts as string;
    const timestamp = ts ? new Date(ts).getTime() : 0;
    return {
      ts,
      timestamp,
      source,
      level: (obj.level as string) ?? "unknown",
      message: (obj.message as string) ?? trimmed,
      prefix: obj.prefix as string | undefined,
      raw: trimmed,
    };
  } catch {
    // Non-JSON line — include as context
    return {
      ts: "",
      timestamp: 0,
      source,
      level: "text",
      message: trimmed.slice(0, 200),
      raw: trimmed,
    };
  }
}

function formatTime(ts: string): string {
  if (!ts) return "----------";
  // Show only time portion for readability
  try {
    const d = new Date(ts);
    return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
  } catch {
    return ts.slice(0, 23);
  }
}

function formatPrefix(p: string | undefined): string {
  if (!p) return "";
  const parts: Record<string, string> = {
    "request-vm-ssh": "REQ",
    bidder: "BID",
    subscriber: "SUB",
    relay: "RLY",
    it: "TEST",
  };
  for (const [key, abbr] of Object.entries(parts)) {
    if (p.includes(key)) return abbr;
  }
  return p.slice(0, 3).toUpperCase();
}

async function main() {
  const args = Deno.args;
  let jsonOutput = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "-r" || args[i] === "--requester") {
      // Next arg is requester file (explicit label)
      i++;
      if (args[i]) files.push(`requester:${args[i]}`);
    } else if (args[i] === "-b" || args[i] === "--bidder") {
      i++;
      if (args[i]) files.push(`bidder:${args[i]}`);
    } else {
      // Auto-label: if path contains "requester" or "bidder", use that
      const path = args[i];
      if (path.includes("requester") || path.includes("14.0")) {
        files.push(`requester:${path}`);
      } else if (path.includes("bidder") || path.includes("14.2")) {
        files.push(`bidder:${path}`);
      } else {
        files.push(`?:${path}`);
      }
    }
  }

  if (files.length === 0) {
    // Read from stdin as "unknown" source
    const text = await new TextDecoder().decode(Deno.readFileSync("/dev/stdin"));
    files.push(`stdin:${text}`);
  }

  // Read all files
  const allLines: LogLine[] = [];

  for (const fileSpec of files) {
    const [source, path] = fileSpec.split(":", 2);
    let content: string;
    if (path === "-") {
      content = await new TextDecoder().decode(Deno.readFileSync("/dev/stdin"));
    } else {
      content = await Deno.readTextFile(path);
    }
    const lines = content.split("\n");
    for (const line of lines) {
      const parsed = parseLine(line, source);
      if (parsed) allLines.push(parsed);
    }
  }

  // Sort: JSON lines by timestamp, non-JSON lines stay at their original position
  // Strategy: stable sort by timestamp, non-timestamped lines keep relative order
  const withTs = allLines.filter((l) => l.timestamp > 0);
  const withoutTs = allLines.filter((l) => l.timestamp === 0);

  withTs.sort((a, b) => a.timestamp - b.timestamp);

  if (jsonOutput) {
    console.log(JSON.stringify(withTs, null, 2));
    return;
  }

  // Human-readable output with color via ANSI escapes
  const COLORS: Record<string, string> = {
    requester: "\x1b[36m", // cyan
    bidder: "\x1b[33m", // yellow
    stdin: "\x1b[35m", // magenta
  };
  const RESET = "\x1b[0m";
  const DIM = "\x1b[2m";

  for (const l of withTs) {
    const color = COLORS[l.source] ?? "";
    const tag = l.source.slice(0, 3).toUpperCase();
    const prefix = formatPrefix(l.prefix);
    const levelMark = l.level === "error" ? "❌" : l.level === "warn" ? "⚠️" : l.level === "info" ? " " : "·";
    const msg = l.message.length > 120 ? l.message.slice(0, 117) + "..." : l.message;

    console.log(
      `${DIM}${formatTime(l.ts)}${RESET} ${color}${tag}${RESET} ${levelMark} ${prefix ? `[${prefix}] ` : ""}${msg}`,
    );
  }

  // Footer
  const tsRange = withTs.length > 1
    ? `${formatTime(withTs[0].ts)} → ${formatTime(withTs[withTs.length - 1].ts)}`
    : "no timestamped lines";
  console.log(`\n${DIM}── ${withTs.length} events, ${tsRange}${RESET}`);
}

main().catch((err) => {
  console.error("merge-logs error:", err.message);
  Deno.exit(1);
});
