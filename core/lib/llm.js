// Pluggable LLM backends for the extraction runner. Each backend is a function
//   async ({ system, user, model, maxTokens, effort, schema }) -> { text, usage }
// where `usage` is normalized to { input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens }.
//
// The zero-dep core never imports an SDK at module load; the Anthropic backend
// lazy-imports the optional @anthropic-ai/sdk only when selected (like mcp/).

// Input/output $ per 1M tokens. Used for honest cost logging only.
const PRICING = {
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export function estimateCostUSD(model, usage) {
  const p = PRICING[model];
  if (!p || !usage) return null;
  const inT = usage.input_tokens || 0;
  const outT = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  // cache read ≈ 0.1x input, cache write ≈ 1.25x input.
  return (inT * p.in + outT * p.out + cr * p.in * 0.1 + cw * p.in * 1.25) / 1e6;
}

export function getBackend(name) {
  if (name === 'mock') return mockBackend;
  if (name === 'anthropic') return anthropicBackend;
  if (name === 'openai' || name === 'vllm') return openaiBackend;
  throw new Error(`unknown backend '${name}' (expected anthropic | openai | mock)`);
}

// Returns nothing — a placeholder for CLI dry runs without a key.
async function mockBackend() {
  return { text: JSON.stringify({ triples: [] }), usage: { input_tokens: 0, output_tokens: 0 } };
}

let _client = null;
async function anthropicClient() {
  if (_client) return _client;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new Error('extraction needs the Anthropic SDK: npm install @anthropic-ai/sdk');
  }
  // The SDK auto-retries 429/529/5xx with exponential backoff; bump the ceiling.
  _client = new Anthropic({ maxRetries: 5 });
  return _client;
}

async function anthropicBackend({ system, user, model, maxTokens, effort, schema }) {
  const client = await anthropicClient();
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    // Structured outputs force a valid {triples:[...]} shape; effort tunes cost.
    output_config: { effort, format: { type: 'json_schema', schema } },
    // The system block (prompt + closed-world catalog) is identical across every
    // source in a run, so cache it — later sources read it at ~0.1x.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  const text = (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage: res.usage || {} };
}

// OpenAI-compatible Chat Completions (vLLM, llama.cpp, etc.) via fetch — zero dep.
async function openaiBackend({ system, user, model, maxTokens }) {
  const base = process.env.CG_LLM_BASE_URL || 'http://localhost:8000/v1';
  const key = process.env.CG_LLM_API_KEY || 'not-needed';
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM backend HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const u = data.usage || {};
  return { text, usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } };
}
