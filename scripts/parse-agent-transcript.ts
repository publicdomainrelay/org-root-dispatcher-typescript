#!/usr/bin/env deno run --allow-read

/**
 * Parse a Claude agent JSONL transcript and extract structured information.
 * Usage: deno run --allow-read scripts/parse-agent-transcript.ts <session-id>
 *
 * Outputs: goal, agent name, stats, first/last messages, tool call summary.
 * Only the summary enters context — raw bytes stay in the sandbox via processing.
 */

interface ParsedLine {
  _line: number;
  type: string;
  subtype?: string;
  sessionId?: string;
  agentName?: string;
  aiTitle?: string;
  mode?: string;
  lastPrompt?: string;
  message?: {
    content: string | Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: string;
    }>;
  };
  [key: string]: unknown;
}

interface TranscriptSummary {
  sessionId: string;
  totalLines: number;
  agentName: string;
  goal: string;
  stats: {
    userMessages: number;
    assistantMessages: number;
    systemMessages: number;
    toolCalls: number;
    toolErrors: number;
  };
  lastPrompt: string;
  lastMessages: Array<{
    line: number;
    type: string;
    summary: string;
  }>;
  filesTouched: Set<string>;
}

function parseJsonl(path: string): ParsedLine[] {
  const content = Deno.readTextFileSync(path);
  return content.trim().split('\n')
    .filter(l => l.trim())
    .map((l, i) => {
      try {
        const p = JSON.parse(l) as ParsedLine;
        p._line = i + 1;
        return p;
      } catch {
        return null;
      }
    })
    .filter((p): p is ParsedLine => p !== null);
}

function extractGoal(messages: ParsedLine[]): string {
  const firstUser = messages.find(m => m.type === 'user' && m.message?.content);
  if (!firstUser) return 'unknown';

  const content = firstUser.message!.content;
  if (typeof content === 'string') return content.slice(0, 500);
  if (Array.isArray(content)) {
    const textParts = content
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text!)
      .join('\n');
    return textParts.slice(0, 500);
  }
  return JSON.stringify(content).slice(0, 500);
}

function extractLastPrompt(messages: ParsedLine[]): string {
  const lp = messages.filter(m => m.type === 'last-prompt').pop();
  return lp?.lastPrompt || 'none';
}

function extractAgentName(messages: ParsedLine[]): string {
  const name = messages.filter(m => m.type === 'agent-name').pop();
  return name?.agentName || 'unknown';
}

function extractFilesTouched(messages: ParsedLine[]): Set<string> {
  const files = new Set<string>();
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const part of m.message!.content) {
        if (part.type === 'tool_use' && ['Write', 'Edit', 'Read'].includes(part.name || '')) {
          const fp = part.input?.file_path as string;
          if (fp) files.add(fp);
        }
      }
    }
  }
  return files;
}

function summarizeMessage(m: ParsedLine): string {
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    const parts = m.message!.content.map(p => {
      if (p.type === 'text' && p.text) return p.text.slice(0, 150);
      if (p.type === 'tool_use') return `[tool:${p.name}]`;
      if (p.type === 'thinking') return '[thinking]';
      return `[${p.type}]`;
    });
    return parts.filter(Boolean).join(' | ').slice(0, 300);
  }
  if (m.type === 'user' && Array.isArray(m.message?.content)) {
    const parts = m.message!.content.map(p => {
      if (p.type === 'tool_result') {
        const prefix = p.is_error ? 'ERROR:' : '';
        const content = (p.content || '').slice(0, 80);
        return `[result${p.is_error ? ':err' : ''}: ${content}]`;
      }
      return '';
    });
    return parts.filter(Boolean).join(' | ').slice(0, 300);
  }
  return `[${m.type}]`;
}

function countToolCalls(messages: ParsedLine[]): { calls: number; errors: number } {
  let calls = 0;
  let errors = 0;
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const part of m.message!.content) {
        if (part.type === 'tool_use') calls++;
      }
    }
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const part of m.message!.content) {
        if (part.type === 'tool_result' && part.is_error) errors++;
      }
    }
  }
  return { calls, errors };
}

// Main
function main() {
  const sessionId = Deno.args[0];
  if (!sessionId) {
    console.error('Usage: deno run --allow-read scripts/parse-agent-transcript.ts <session-id>');
    Deno.exit(1);
  }

  const homeDir = Deno.env.get('HOME') || Deno.env.get('USERPROFILE') || '~';
  const jsonlPath = `${homeDir}/.claude/projects/-Users-johnandersen777-src-publicdomainrelay/${sessionId}.jsonl`;

  let messages: ParsedLine[];
  try {
    messages = parseJsonl(jsonlPath);
  } catch (e) {
    console.error(`Failed to read ${jsonlPath}: ${(e as Error).message}`);
    Deno.exit(1);
  }

  const substantive = messages.filter(m =>
    !['last-prompt', 'permission-mode', 'attachment', 'file-history-snapshot',
      'ai-title', 'agent-name', 'mode'].includes(m.type) &&
    !(m.type === 'system' && ['turn_duration', 'stop_hook_summary'].includes(m.subtype || '')) &&
    !m.isMeta
  );

  const { calls, errors } = countToolCalls(messages);

  const summary: TranscriptSummary = {
    sessionId,
    totalLines: messages.length,
    agentName: extractAgentName(messages),
    goal: extractGoal(messages),
    stats: {
      userMessages: messages.filter(m => m.type === 'user').length,
      assistantMessages: messages.filter(m => m.type === 'assistant').length,
      systemMessages: messages.filter(m => m.type === 'system').length,
      toolCalls: calls,
      toolErrors: errors,
    },
    lastPrompt: extractLastPrompt(messages),
    lastMessages: substantive.slice(-10).map(m => ({
      line: m._line,
      type: m.type,
      summary: summarizeMessage(m),
    })),
    filesTouched: extractFilesTouched(messages),
  };

  // Output as JSON with filesTouched as array
  console.log(JSON.stringify({
    ...summary,
    filesTouched: [...summary.filesTouched],
  }, null, 2));
}

main();
