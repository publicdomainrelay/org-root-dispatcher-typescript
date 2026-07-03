// Minimal OpenAI-compatible /v1/embeddings server for local test runs.
// Deterministic hash-based vectors so repeated calls on the same text match.
// Used by scripts/test-all.ts to satisfy codebase-rag-proxy's retrieval tests
// without a real llama.cpp / OpenAI embedding backend.

const DIM = 32;

function hashVector(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    vec[i % DIM] += text.charCodeAt(i);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

const port = parseInt(Deno.args[0] || "18080");

Deno.serve({ port, hostname: "127.0.0.1", onListen: () => console.log(`ready:${port}`) }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "POST" && url.pathname === "/v1/embeddings") {
    const body = await req.json();
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({
      object: "list",
      data: inputs.map((text, index) => ({
        object: "embedding",
        index,
        embedding: hashVector(String(text)),
      })),
      model: body.model || "test-model",
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  }
  return new Response("not found", { status: 404 });
});
