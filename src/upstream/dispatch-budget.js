// Per-request physical dispatch budget.
//
// For N credentials loaded at request entry:
//   - at most 2N generation POSTs (a connection retry and a forced-auth retry share the same
//     two-POST allowance of one credential),
//   - at most 2N OAuth token POSTs (initial/eager plus at most one forced refresh per credential),
//   - at most N project-resolution POSTs (one probe per credential).
// Callers joining an in-flight shared refresh record a join, never a physical POST.
export function createDispatchBudget({ credentials = 0 } = {}) {
  const n = Number.isInteger(credentials) && credentials > 0 ? credentials : 0;
  const limits = { generation: 2 * n, oauth: 2 * n, project: n, perCredentialGeneration: 2, perCredentialOAuth: 2, perCredentialProject: 1 };
  const used = { generation: 0, oauth: 0, project: 0, refreshJoins: 0, accountAttempts: 0 };
  const per = new Map();

  const slot = (accountId) => {
    if (!per.has(accountId)) per.set(accountId, { generation: 0, oauth: 0, project: 0 });
    return per.get(accountId);
  };

  const take = (kind, accountId) => {
    if (used[kind] >= limits[kind]) return false;
    const mine = slot(accountId);
    if (mine[kind] >= limits[`perCredential${kind === 'generation' ? 'Generation' : kind === 'oauth' ? 'OAuth' : 'Project'}`]) return false;
    used[kind] += 1;
    mine[kind] += 1;
    return true;
  };

  return {
    limits,
    takeGeneration(accountId) { return take('generation', accountId); },
    takeOAuth(accountId) { return take('oauth', accountId); },
    takeProject(accountId) { return take('project', accountId); },
    canTakeGeneration(accountId) {
      return used.generation < limits.generation && slot(accountId).generation < limits.perCredentialGeneration;
    },
    canTakeOAuth(accountId) {
      return used.oauth < limits.oauth && slot(accountId).oauth < limits.perCredentialOAuth;
    },
    recordJoin() { used.refreshJoins += 1; },
    recordAttempt() { used.accountAttempts += 1; },
    displacementFor(accountId) {
      const mine = slot(accountId);
      return { generation: mine.generation, oauth: mine.oauth, project: mine.project };
    },
    counts() {
      return {
        generation: used.generation,
        oauth: used.oauth,
        project: used.project,
        refreshJoins: used.refreshJoins,
        accountAttempts: used.accountAttempts,
        maxGeneration: limits.generation,
        maxOAuth: limits.oauth,
        maxProject: limits.project,
      };
    },
  };
}
