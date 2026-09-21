// Model catalog + wire-config for the antigravity lane. Every entry was
// captured from a live official Antigravity CLI run through a TLS mitm
// (2026-09-21): model name sent upstream, maxOutputTokens, thinkingBudget.
// -1 budget = dynamic thinking; pro-high is a client-side alias that maps to
// the upstream model id "gemini-pro-agent" with a 10001 budget.
export const MODEL_CATALOG = [
  { id: 'gemini-3.8-flash-low', context: 1_048_576, budget: 1000, maxOutputTokens: 65_536 },
  { id: 'gemini-3.8-flash-medium', context: 1_048_576, budget: 4000, maxOutputTokens: 65_536 },
  { id: 'gemini-3.8-flash-high', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },
  { id: 'gemini-3.7-flash-low', context: 1_048_576, budget: 1000, maxOutputTokens: 65_536 },
  { id: 'gemini-3.7-flash-medium', context: 1_048_576, budget: 4000, maxOutputTokens: 65_536 },
  { id: 'gemini-3.7-flash-high', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },
  { id: 'gemini-3.6-flash-low', context: 1_048_576, budget: 1000, maxOutputTokens: 65_536 },
  { id: 'gemini-3.6-flash-medium', context: 1_048_576, budget: 4000, maxOutputTokens: 65_536 },
  { id: 'gemini-3.6-flash-high', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },
  { id: 'gemini-3.1-pro-low', context: 1_048_576, budget: 1001, maxOutputTokens: 65_535 },
  {
    id: 'gemini-3.1-pro-high',
    context: 1_048_576,
    budget: 10001,
    maxOutputTokens: 65_535,
    // client alias -> real upstream id
    upstreamModel: 'gemini-pro-agent',
  },
  { id: 'claude-sonnet-4-6', context: 200_000, budget: 1024, maxOutputTokens: 64_000 },
  { id: 'claude-opus-4-6-thinking', context: 200_000, budget: 1024, maxOutputTokens: 64_000 },
  { id: 'gpt-oss-120b-medium', context: 131_072, budget: 8192, maxOutputTokens: 32_768 },
];

export function findModel(id) {
  // bare family names ("gemini-3.8-flash", "gemini-3.1-pro") resolve to the
  // medium effort of that family — CPA-compatible for callers that omit the
  // -low/-medium/-high suffix (Mari vision lane does).
  const bare = /^((?:gemini-\d+(?:\.\d+)?-(?:flash|pro))|claude-(?:sonnet|opus)-\d+-\d+)$/.exec(id);
  if (bare) {
    const family = MODEL_CATALOG.filter((m) => m.id.startsWith(`${bare[1]}-`));
    return family.find((m) => m.id.endsWith('-medium'))
      ?? family.find((m) => m.id.endsWith('-high'))
      ?? family[0] ?? MODEL_CATALOG.find((m) => m.id === id) ?? null;
  }
  return MODEL_CATALOG.find((m) => m.id === id) ?? null;
}

/** /v1/models payload — the model ids the antigravity lane serves. */
export function modelsPayload() {
  return {
    object: 'list',
    data: MODEL_CATALOG.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'antigravity-proxy',
      context_length: m.context,
    })),
  };
}
