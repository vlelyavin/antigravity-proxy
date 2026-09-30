/**
 * Sticky account selection: every request goes to the first healthy account in credential order;
 * the next one takes over only when it is cooling down after a 429 RESOURCE_EXHAUSTED (or 401
 * invalid_grant after refresh), or was already tried by this request. One account serving a run of
 * requests keeps Gemini's implicit prompt cache warm — the cache is per account, and round-robin
 * split it in half. Cooldown state lives in memory and resets on restart.
 */
export class AccountPool {
  constructor({ logger }) {
    this.logger = logger;
    this.coolUntil = new Map(); // accountId -> epoch ms
  }

  healthy(accounts) {
    const now = Date.now();
    return accounts.filter((a) => (this.coolUntil.get(a.id) ?? 0) <= now);
  }

  /**
   * M9: when every account is cooling down, return null so the caller fails
   * fast with 429 instead of hammering the account that just got exhausted.
   * `tried` holds the ids this request already attempted: a timed-out or failed
   * attempt moves on to the next account instead of retrying the same one.
   */
  pick(accounts, tried = new Set()) {
    return this.healthy(accounts).find((a) => !tried.has(a.id)) ?? null;
  }

  cooldown(accountId, ms) {
    this.coolUntil.set(accountId, Date.now() + ms);
    this.logger.warn('account.cooldown', { accountId, ms });
  }
}
