// Identity scrub for the system instruction.
//
// Cloud Code answers an opaque `429 RESOURCE_EXHAUSTED` to some third-party harness markers in
// the system instruction (observed and documented by antigravity-claude-proxy issues #408/#375,
// CLIProxyAPI issues #7560/#7562, and the ACC v2.9.2 release notes). The marker is the *name* of
// the calling harness or vendor, not the request itself. Replacing those names with neutral
// descriptions keeps the instruction's meaning while removing the trigger.
//
// This is a wire concern only: prompts, responses and journals keep the caller's text; the
// replacement happens on the copy that goes upstream.

export const DEFAULT_REPLACEMENTS = Object.freeze([
  ['Nous Research', 'the model provider'],
  ['Hermes Agent', 'the assistant'],
  ['Hermes', 'the assistant'],
  ['Claude Code', 'the coding tool'],
  ['ClaudeCode', 'the coding tool'],
  ['Anthropic', 'the model vendor'],
  ['OpenCode', 'the coding tool'],
  ['OpenClaw', 'the client'],
  ['Cursor', 'the editor'],
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces harness/vendor identity markers in one string.
 *
 * options.enabled === false disables the scrub (the deployment may prefer the raw prompt).
 * options.extra is a list of [from, to] pairs appended to the defaults; the longest term wins,
 * so `Hermes Agent` is replaced before `Hermes`.
 */
export function scrubIdentity(text, options = {}) {
  if (options?.enabled === false) return text;
  if (typeof text !== 'string' || text === '') return text;
  const extra = Array.isArray(options?.extra) ? options.extra : [];
  const pairs = [...DEFAULT_REPLACEMENTS, ...extra]
    .filter((pair) => Array.isArray(pair)
      && typeof pair[0] === 'string' && pair[0] !== ''
      && typeof pair[1] === 'string')
    .sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of pairs) {
    // Word-ish boundaries: a marker inside an identifier or path is left alone.
    const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(from)}(?![\\w-])`, 'gi');
    out = out.replace(pattern, to);
  }
  return out;
}
