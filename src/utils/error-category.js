// Journal categories are a fixed vocabulary. Error metadata can come from a transport/plugin just
// as messages can, so neither arbitrary .code nor .name is safe to copy into the journal.
const CODES = new Set([
  'first_frame_timeout', 'idle_timeout', 'attempt_timeout', 'request_deadline',
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED', 'EADDRINUSE', 'EACCES', 'ENOENT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const NAMES = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError',
  'EgressError', 'CredentialStoreError',
]);

export function errorCategory(error) {
  if (CODES.has(error?.code)) return error.code;
  return NAMES.has(error?.name) ? error.name : 'error';
}
