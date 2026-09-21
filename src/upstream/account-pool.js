/**
 * Account rotation: round-robin over healthy accounts; an account that got a
 * 429 RESOURCE_EXHAUSTED (or 401 invalid_grant after refresh) sits out for
 * cooldownMs. Rotation state lives in memory and resets on restart.
 */
export class AccountPool {
  constructor({ logger }) {
    this.logger = logger;
    this.coolUntil = new Map(); // accountId -> epoch ms
    this.cursor = 0;
  }

  healthy(accounts) {
    const now = Date.now();
    return accounts.filter((a) => (this.coolUntil.get(a.id) ?? 0) <= now);
  }

  /**
   * M9: when every account is cooling down, return null so the caller fails
   * fast with 429 instead of hammering the account that just got exhausted.
   */
  pick(accounts) {
    const pool = this.healthy(accounts);
    if (pool.length === 0) return null;
    const account = pool[this.cursor % pool.length];
    this.cursor = (this.cursor + 1) % pool.length;
    return account;
  }

  cooldown(accountId, ms) {
    this.coolUntil.set(accountId, Date.now() + ms);
    this.logger.warn('account.cooldown', { accountId, ms });
  }
}
