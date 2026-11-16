// Model catalog + wire-config for the antigravity lane.
//
// The Gemini 3.8 entries were captured from a live official Antigravity CLI run through a
// TLS mitm (2026-09-21): model name sent upstream, maxOutputTokens, thinkingBudget.
// -1 budget = dynamic thinking; pro-high is a client-side alias that maps to the upstream
// model id "gemini-pro-agent" with a 10001 budget.
//
// The 2026-11-16 refresh follows the official model matrix (antigravity.google/docs/models):
// Claude Sonnet 4.6 / Opus 4.6 / GPT-OSS-120B are removed upstream on 2026-11-18, and Gemini 4
// (Argon/Hydrogen/Carbon), Gemini 3 Flash, 3.1 Flash Image and Claude 5.5 replace them. The
// upstream ids for that generation are taken from CLIProxyAPI's model registry
// (internal/registry/models/models.json, v8.0.73, 2026-11-15).
export const MODEL_CATALOG = [
  // ---- Gemini 3.8 Flash (captured wire shapes) ----
  { id: 'gemini-3.8-flash-low', context: 1_048_576, budget: 1000, maxOutputTokens: 65_536, modelEnum: 'MODEL_PLACEHOLDER_M320' },
  { id: 'gemini-3.8-flash-medium', context: 1_048_576, budget: 4000, maxOutputTokens: 65_536, modelEnum: 'MODEL_PLACEHOLDER_M319' },
  { id: 'gemini-3.8-flash-high', context: 1_048_576, budget: -1, maxOutputTokens: 65_536, modelEnum: 'MODEL_PLACEHOLDER_M318' },
  { id: 'gemini-3.8-flash-tiered', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },

  // ---- Gemini 4 (Pro/Ultra; the effort suffix is carried in the model id) ----
  { id: 'gemini-4-argon-high', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },
  { id: 'gemini-4-hydrogen-xhigh', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },
  { id: 'gemini-4-carbon-high', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },

  // ---- Gemini 3 / lite / image ----
  { id: 'gemini-3-flash', context: 1_048_576, budget: -1, maxOutputTokens: 65_536 },
  { id: 'gemini-3.1-flash-image', context: 32_768, budget: 0, maxOutputTokens: 32_768, kind: 'image' },
  { id: 'gemini-3.1-flash-lite', context: 1_048_576, budget: -1, maxOutputTokens: 65_535 },
  { id: 'gemini-3.5-flash-lite', context: 1_048_576, budget: -1, maxOutputTokens: 65_535 },

  // ---- Claude 5.5 (Pro non-trial / Ultra); replaces the 4.6 pair removed on 2026-11-18 ----
  { id: 'claude-sonnet-5-5-high', context: 1_000_000, budget: 1024, maxOutputTokens: 128_000, modelEnum: 'MODEL_PLACEHOLDER_M35', kind: 'claude' },
  { id: 'claude-opus-5-5-high', context: 1_000_000, budget: 1024, maxOutputTokens: 128_000, modelEnum: 'MODEL_PLACEHOLDER_M35', kind: 'claude' },

  // ---- Gemini 3.x kept for Enterprise accounts (absent on Pro/Ultra) ----
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
];

/** Families whose bare id resolves to one of their suffixed entries. */
const BARE_FAMILY = /^((?:gemini-\d+(?:\.\d+)?-(?:flash|pro|argon|hydrogen|carbon|lite))|claude-(?:sonnet|opus)-\d+-\d+)(?:-(?:low|medium|high|xhigh))?$/;

export function findModel(id) {
  if (typeof id !== 'string' || id === '') return null;
  const exact = MODEL_CATALOG.find((m) => m.id === id);
  if (exact) return exact;
  // bare family names ("gemini-3.8-flash", "gemini-4-argon", "claude-sonnet-5-5") resolve to the
  // highest available effort of that family — CPA-compatible for callers that omit the suffix
  // (Mari's vision lane sends a bare id).
  const bare = BARE_FAMILY.exec(id);
  if (!bare) return null;
  const family = MODEL_CATALOG.filter((m) => m.id.startsWith(`${bare[1]}-`));
  return family.find((m) => m.id.endsWith('-medium'))
    ?? family.find((m) => m.id.endsWith('-high'))
    ?? family.find((m) => m.id.endsWith('-xhigh'))
    ?? family[0]
    ?? null;
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
