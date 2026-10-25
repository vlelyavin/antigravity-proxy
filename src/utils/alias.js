import { createHash } from 'node:crypto';

/**
 * Stable anonymised handle for one account/credential: `acct-` plus the first 8 hex of the sha256
 * of the account id (the token file path). The journal is payload-free - no email, no token file
 * path, no project id - but the same account keeps the same label in every line and across
 * restarts, so journal lines still correlate with each other.
 */
export function accountLabel(account) {
  const id = typeof account === 'string' ? account : account?.id;
  if (!id) return 'acct-unknown';
  return `acct-${createHash('sha256').update(String(id)).digest('hex').slice(0, 8)}`;
}
