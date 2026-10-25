import { randomUUID } from 'node:crypto';
import { POLICY_VERSION, journalModel } from '../upstream/failure.js';

// One correlation ID per physical incoming call. Only a strict UUID supplied by the caller is
// accepted; arbitrary header text is never copied into a journal or a response.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createCallContext(req, { model = null, route = 'agy' } = {}) {
  const supplied = req?.headers?.['x-request-id'];
  const requestId = typeof supplied === 'string' && UUID_RE.test(supplied)
    ? supplied.toLowerCase()
    : randomUUID();
  return {
    requestId,
    route,
    modelRequested: journalModel(model) ?? 'unknown',
    modelOutbound: 'unknown',
    modelReported: null, // the AGY wire response does not identify the served model
    attempts: 0,
    reason: null,
    stopReason: null,
    setModel(value) {
      this.modelRequested = journalModel(value) ?? 'unknown';
    },
    setOutboundModel(value) {
      this.modelOutbound = journalModel(value) ?? 'unknown';
    },
    syncFromBudget(budget) {
      this.attempts = budget?.counts?.().accountAttempts ?? 0;
    },
    headers() {
      const headers = {
        'x-agy-request-id': this.requestId,
        'x-agy-route': this.route,
        'x-agy-attempts': String(this.attempts),
        'x-agy-policy': POLICY_VERSION,
      };
      if (this.reason) headers['x-agy-reason'] = this.reason;
      return headers;
    },
    finish({ route = null, reason = null, stopReason = null } = {}) {
      if (route) this.route = route;
      this.reason = reason ?? null;
      this.stopReason = stopReason ?? null;
    },
  };
}
