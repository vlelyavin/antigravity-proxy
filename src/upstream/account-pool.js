import { createHash } from 'node:crypto';
import { accountLabel } from '../utils/alias.js';
import { EVIDENCE, POLICY_VERSION, REASONS } from './failure.js';

/**
 * Sticky-first account selection with SCOPED, evidence-backed shared state.
 *
 * Two kinds of state are deliberately separate:
 *   - `tried` belongs to one request: it only avoids repeating an account inside that request.
 *   - `restrictions`/`credentialBlocks` are shared, and only a proven scoped decision writes them.
 *
 * A restriction applies to exactly one thing: an account, an account+model, a project resource or
 * an egress identity. Unknown scopes never become account-wide state. A revoked credential is
 * blocked by material generation, not by a timer: an access-token refresh keeps the same
 * generation, a replaced refresh token produces a new one and becomes selectable again.
 *
 * An expired restriction admits ONE real bounded attempt as a recovery probe. The lease is held
 * from selection until the attempt ends (success, failure, cancellation, timeout) and is released
 * unconditionally by the handler. Expiry or release without success is not recovery.
 */
const RESTRICTION_SCOPES = new Set(['account', 'account_model', 'project', 'provider', 'egress']);
const REASON_SET = new Set(REASONS);
const EVIDENCE_SET = new Set(EVIDENCE);

const fixedReason = (value) => (REASON_SET.has(value) ? value : 'unknown');
const fixedEvidence = (value) => (EVIDENCE_SET.has(value) ? value : 'unclassified_error');

const GATE_CODE = {
  account: 'quota_gated',
  account_model: 'quota_gated',
  project: 'resource_gated',
  provider: 'resource_gated',
  egress: 'egress_gated',
};

function restrictionKey(scope, { accountId, model, resourceKey }) {
  switch (scope) {
    case 'account': return `account|${accountId}`;
    case 'account_model': return `account_model|${accountId}|${model}`;
    case 'project': return `project|${resourceKey}`;
    case 'provider': return `provider|${resourceKey}`;
    case 'egress': return `egress|${resourceKey}`;
    default: return null;
  }
}

function projectAlias(projectId) {
  return `project-${createHash('sha256').update(String(projectId)).digest('hex').slice(0, 8)}`;
}

export class AccountPool {
  constructor({ logger, now = () => Date.now() } = {}) {
    this.logger = logger;
    this.now = now;
    this.restrictions = new Map(); // key -> record (trusted internal keys may carry private ids)
    this.credentialBlocks = new Map(); // accountId -> { generation, reason, evidence, alias, revision }
    this.probes = new Map(); // key -> { owner, revision, alias, scope, account }
    this.revision = 0;
    // Inferred availability is process-local in this slice. A start is an explicit reset, not a
    // verified recovery; the operator journal keeps the decisions that led to the old state.
    this.logger?.info?.('pool.reset', {
      policyVersion: POLICY_VERSION,
      persisted: false,
      reason: 'process_start',
    });
  }

  /** Every restriction key that the given attempt context would have to satisfy. */
  #keysFor(account, ctx = {}) {
    const out = [{
      key: restrictionKey('provider', { resourceKey: 'agy' }),
      scope: 'provider',
      resourceAlias: 'agy',
    }, {
      key: restrictionKey('account', { accountId: account.id }),
      scope: 'account',
      resourceAlias: accountLabel(account),
    }];
    if (ctx.model) {
      out.push({
        key: restrictionKey('account_model', { accountId: account.id, model: ctx.model }),
        scope: 'account_model',
        resourceAlias: ctx.model,
      });
    }
    if (ctx.projectId) {
      out.push({
        key: restrictionKey('project', { resourceKey: ctx.projectId }),
        scope: 'project',
        resourceAlias: ctx.projectAlias ?? projectAlias(ctx.projectId),
      });
    }
    if (ctx.egressKey && ctx.egressKey !== 'direct') {
      out.push({
        key: restrictionKey('egress', { resourceKey: ctx.egressKey }),
        scope: 'egress',
        resourceAlias: ctx.egressAlias ?? 'egress-unknown',
      });
    }
    return out;
  }

  #credentialBlocked(account, ctx) {
    const block = this.credentialBlocks.get(account.id);
    if (!block) return null;
    // No known generation cannot prove replacement: stay conservative and keep the block.
    if (ctx.generation == null || block.generation === ctx.generation) return block;
    return null;
  }

  /**
   * Selects the sticky-first eligible account and, when an expired restriction is eligible for
   * recovery, atomically leases that scope as a real probe. The caller MUST eventually call
   * `releaseProbe(selection)` or `recoverProbe(selection)` on every exit path.
   */
  select(accounts, { tried = new Set(), context = null } = {}) {
    const now = this.now();
    const exclusions = [];
    const counts = {
      candidates: accounts.length,
      tried: 0,
      credentialBlocked: 0,
      quotaGated: 0,
      egressGated: 0,
      resourceGated: 0,
      probeBusy: 0,
      eligible: 0,
    };

    for (const account of accounts) {
      const alias = accountLabel(account);
      const ctx = typeof context === 'function' ? (context(account) ?? {}) : {};
      if (tried.has(account.id)) {
        counts.tried += 1;
        exclusions.push({ account: alias, code: 'tried', scope: 'request', until: null, reason: 'already_tried' });
        continue;
      }
      const block = this.#credentialBlocked(account, ctx);
      if (block) {
        counts.credentialBlocked += 1;
        exclusions.push({
          account: alias, code: 'credential_blocked', scope: 'credential', until: null,
          reason: block.reason, evidence: block.evidence,
        });
        continue;
      }

      const probes = [];
      let blocking = null;
      for (const entry of this.#keysFor(account, ctx)) {
        const record = this.restrictions.get(entry.key);
        if (!record) continue;
        if (record.until !== null && record.until <= now) {
          probes.push({ entry, record });
          continue;
        }
        const until = record.until ?? Number.POSITIVE_INFINITY;
        if (!blocking || until > (blocking.record.until ?? Number.POSITIVE_INFINITY)) {
          blocking = { entry, record };
        }
      }
      if (blocking) {
        const code = GATE_CODE[blocking.entry.scope] ?? 'resource_gated';
        counts[code === 'quota_gated' ? 'quotaGated' : code === 'egress_gated' ? 'egressGated' : 'resourceGated'] += 1;
        exclusions.push({
          account: alias,
          code,
          scope: blocking.entry.scope,
          until: blocking.record.until,
          reason: blocking.record.reason,
          evidence: blocking.record.evidence,
        });
        continue;
      }

      let busy = null;
      for (const probe of probes) {
        if (this.probes.has(probe.entry.key)) { busy = probe; break; }
      }
      if (busy) {
        counts.probeBusy += 1;
        exclusions.push({
          account: alias, code: 'probe_busy', scope: busy.entry.scope, until: busy.record.until,
          reason: busy.record.reason, evidence: busy.record.evidence,
        });
        continue;
      }

      const owner = probes.length > 0 ? Symbol('probe') : null;
      const leased = probes.map(({ entry, record }) => {
        this.probes.set(entry.key, {
          owner, revision: record.revision, alias: entry.resourceAlias, scope: entry.scope, account: alias,
        });
        return { key: entry.key, revision: record.revision, scope: entry.scope, resourceAlias: entry.resourceAlias };
      });
      counts.eligible += 1;
      return { account, alias, context: ctx, probes: leased, probeToken: owner, counts, exclusions, now };
    }

    return { account: null, alias: null, context: null, probes: [], probeToken: null, counts, exclusions, now };
  }

  /** Backwards-compatible thin wrapper: selection without the typed exhaustion report. */
  pick(accounts, tried = new Set(), context = null) {
    return this.select(accounts, { tried, context }).account;
  }

  /**
   * Re-check after asynchronous preparation and immediately before dispatch. Expired restrictions
   * require an exclusive probe lease; newer evidence supersedes the selected probe revision.
   * A current-generation credential block also stops dispatch. Resolved project identity is matched
   * against gates that selection could not see yet.
   */
  gateFor(account, ctx = {}, selection = null) {
    for (const entry of this.#keysFor(account, ctx)) {
      const record = this.restrictions.get(entry.key);
      if (!record) continue;
      const owned = selection?.probes?.find((probe) => probe.key === entry.key);
      if (owned?.revision === record.revision
        && this.probes.get(entry.key)?.owner === selection.probeToken) continue;
      if (!owned && selection && !this.probes.has(entry.key)
        && record.until !== null && record.until <= this.now()) {
        // A resource learned during preparation needs the same exclusive lease as selection.
        selection.probeToken ??= Symbol('probe');
        this.probes.set(entry.key, {
          owner: selection.probeToken, revision: record.revision, alias: entry.resourceAlias,
          scope: entry.scope, account: selection.alias,
        });
        selection.probes.push({ key: entry.key, revision: record.revision, scope: entry.scope, resourceAlias: entry.resourceAlias });
        continue;
      }
      return {
        scope: entry.scope,
        resource: entry.resourceAlias,
        until: record.until,
        reason: record.reason,
        evidence: record.evidence,
      };
    }
    const block = this.#credentialBlocked(account, ctx);
    if (block) {
      return {
        scope: 'credential', resource: accountLabel(account), until: null,
        reason: block.reason, evidence: block.evidence,
      };
    }
    return null;
  }

  /** True while every probe lease acquired by this selection is still owned by it. */
  probeAlive(selection) {
    if (!selection?.probeToken) return true;
    return selection.probes.every((probe) => this.probes.get(probe.key)?.owner === selection.probeToken);
  }

  /** Unconditional lease release. A released probe is NOT a recovered scope. */
  releaseProbe(selection) {
    if (!selection?.probeToken) return;
    for (const probe of selection.probes) {
      if (this.probes.get(probe.key)?.owner === selection.probeToken) this.probes.delete(probe.key);
    }
  }

  /**
   * A successful real attempt proves the probed scopes. Clears only restrictions whose revision
   * has not moved since selection: a late success can never erase newer evidence.
   */
  recoverProbe(selection, ctx = {}) {
    if (!selection?.probeToken) return [];
    const recovered = [];
    for (const probe of selection.probes) {
      const active = this.probes.get(probe.key);
      if (active?.owner !== selection.probeToken) continue;
      const record = this.restrictions.get(probe.key);
      if (!record) { this.probes.delete(probe.key); continue; }
      if (record.revision !== probe.revision) continue; // newer evidence wins
      if ((record.scope === 'account' || record.scope === 'account_model')
        && ctx.generation != null && record.generation != null && record.generation !== ctx.generation) continue;
      this.restrictions.delete(probe.key);
      this.probes.delete(probe.key);
      recovered.push({ scope: record.scope, resource: record.resourceAlias });
      this.logger?.info?.('pool.recovered', {
        scope: record.scope,
        account: selection.alias,
        resource: record.resourceAlias,
        policyVersion: POLICY_VERSION,
      });
    }
    // Ownership is always released on success, including scopes whose newer evidence survived.
    this.releaseProbe(selection);
    return recovered;
  }

  /**
   * Applies one proven scoped restriction. `until` is epoch ms or null for "until operator action"
   * (invalid local egress configuration). Existing later evidence is never shortened; a later
   * `until` extends and becomes the new reason/evidence with a new revision.
   */
  restrict({
    account, accountId, scope, model = null, projectId = null, provider = null,
    egressKey = null, egressAlias = null, until = null, reason = 'unknown', evidence = 'unclassified_error',
    generation = null,
  }) {
    if (!RESTRICTION_SCOPES.has(scope)) return { applied: false, effect: 'unsupported_scope' };
    reason = fixedReason(reason);
    evidence = fixedEvidence(evidence);
    const id = accountId ?? account?.id;
    if ((scope === 'account' || scope === 'account_model') && !id) {
      return { applied: false, effect: 'unknown_account' };
    }
    const alias = account ? accountLabel(account) : accountLabel(id);
    let resourceKey = null;
    let resourceAlias = alias;
    if (scope === 'account') {
      resourceKey = id;
    } else if (scope === 'account_model') {
      if (!model) return { applied: false, effect: 'unknown_model' };
      resourceKey = model;
      resourceAlias = model;
    } else if (scope === 'project') {
      if (!projectId) return { applied: false, effect: 'unknown_project' };
      resourceKey = projectId;
      resourceAlias = projectAlias(projectId);
    } else if (scope === 'provider') {
      if (!provider) return { applied: false, effect: 'unknown_provider' };
      resourceKey = provider;
      resourceAlias = provider;
    } else if (scope === 'egress') {
      if (!egressKey) return { applied: false, effect: 'unknown_egress' };
      resourceKey = egressKey;
      resourceAlias = egressAlias ?? 'egress-unknown';
    }
    const key = restrictionKey(scope, { accountId: id, model, resourceKey });
    if (!key) return { applied: false, effect: 'unsupported_scope' };

    const existing = this.restrictions.get(key);
    if (existing) {
      if (existing.until === null) return { applied: false, effect: 'unchanged_permanent' };
      if (until !== null && until < existing.until) {
        // Monotonic: a concurrent report may extend, never shorten, newer evidence.
        return { applied: false, effect: 'not_shortened' };
      }
    }
    const record = {
      scope,
      accountId: id ?? null,
      alias,
      model,
      resourceKey,
      resourceAlias,
      until,
      reason,
      evidence,
      generation,
      policyVersion: POLICY_VERSION,
      revision: ++this.revision,
      updatedAt: this.now(),
    };
    this.restrictions.set(key, record);
    const effect = existing ? 'extended' : 'restricted';
    this.logger?.warn?.('pool.restriction', {
      effect,
      scope,
      account: alias,
      resource: resourceAlias,
      until: until === null ? null : new Date(until).toISOString(),
      reason,
      evidence,
      policyVersion: POLICY_VERSION,
    });
    return {
      applied: true,
      effect,
      scope,
      until,
      revision: record.revision,
      resourceAlias,
    };
  }

  /**
   * Blocks one material credential generation until the refresh token (or operator action)
   * changes. Never timer-based: a revoked generation cannot be proven healthy again by waiting.
   */
  blockGeneration({ account, accountId, generation, reason = 'revoked_credential', evidence = 'oauth_invalid_grant' }) {
    reason = fixedReason(reason);
    evidence = fixedEvidence(evidence);
    const id = accountId ?? account?.id;
    if (!id || typeof generation !== 'string' || generation === '') {
      return { applied: false, effect: 'unknown_generation' };
    }
    const existing = this.credentialBlocks.get(id);
    if (existing?.generation === generation) return { applied: false, effect: 'already_blocked' };
    const alias = account ? accountLabel(account) : accountLabel(id);
    this.credentialBlocks.set(id, {
      generation, reason, evidence, alias, policyVersion: POLICY_VERSION, revision: ++this.revision,
    });
    this.logger?.warn?.('pool.restriction', {
      effect: 'credential_blocked',
      scope: 'credential',
      account: alias,
      resource: alias,
      until: null,
      reason,
      evidence,
      policyVersion: POLICY_VERSION,
    });
    return { applied: true, effect: 'credential_blocked' };
  }

  /** Explicit operator retry: the only non-material way to unblock a generation. */
  clearCredentialBlock(accountId) {
    return this.credentialBlocks.delete(accountId);
  }

  /**
   * Coarse diagnostic only: accounts with no active account/account_model restriction and no
   * current-generation block. It cannot evaluate project/egress scopes because it has no attempt
   * context; selection never uses it.
   */
  healthy(accounts) {
    const now = this.now();
    return accounts.filter((account) => {
      const ctx = { generation: account.generation ?? null };
      if (this.#credentialBlocked(account, ctx)) return false;
      for (const [key, record] of this.restrictions) {
        if (record.until !== null && record.until <= now) continue;
        if (key === `account|${account.id}` || key.startsWith(`account_model|${account.id}|`)) return false;
      }
      return true;
    });
  }

  /** Safe operator snapshot: aliases, scopes and fixed enums only. No path, token or project id. */
  snapshot(accounts = null) {
    const now = this.now();
    const current = accounts
      ? new Map(accounts.map((account) => [account.id, account.generation ?? null]))
      : null;
    const restrictions = [];
    for (const record of this.restrictions.values()) {
      restrictions.push({
        account: record.alias,
        scope: record.scope,
        resource: record.resourceAlias,
        state: record.until !== null && record.until <= now ? 'expired_probe_eligible' : 'active',
        until: record.until === null ? null : new Date(record.until).toISOString(),
        reason: record.reason,
        evidence: record.evidence,
        policyVersion: record.policyVersion,
      });
    }
    const credentialBlocks = [];
    for (const [accountId, block] of this.credentialBlocks) {
      if (current && !current.has(accountId)) continue;
      if (current) {
        const generation = current.get(accountId);
        if (generation != null && generation !== block.generation) continue; // stale block
      }
      credentialBlocks.push({
        account: block.alias,
        scope: 'credential',
        state: 'blocked',
        until: null,
        reason: block.reason,
        evidence: block.evidence,
        policyVersion: block.policyVersion,
      });
    }
    const activeProbes = [...this.probes.values()].map((probe) => ({
      account: probe.account,
      scope: probe.scope,
      resource: probe.alias,
      policyVersion: POLICY_VERSION,
    }));
    return {
      policyVersion: POLICY_VERSION,
      restrictions,
      credentialBlocks,
      activeProbes,
      restricted: restrictions.some((r) => r.state === 'active') || credentialBlocks.length > 0 || activeProbes.length > 0,
    };
  }
}
