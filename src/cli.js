import { errorCategory } from './utils/error-category.js';
import { loadConfig } from './config/load-config.js';
import { createLogger } from './utils/logger.js';
import { CredentialStore } from './credentials/credential-store.js';
import { UpstreamClient } from './upstream/upstream-client.js';
import { AccountPool } from './upstream/account-pool.js';
import { createServer } from './server/create-server.js';
import { accountLabel } from './utils/alias.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const credentialStore = new CredentialStore({
  searchPaths: config.credentials.searchPaths,
  logger,
});

const upstream = new UpstreamClient({
  config, logger,
  currentGeneration: (account) => credentialStore.readAll().find((current) => current.id === account.id)?.generation,
});
const pool = new AccountPool({ logger });

/**
 * Start-up egress resolution: every account's exit is decided from the loaded credential set, so a
 * lane shared by two accounts is refused before any request is served. A failure to read the
 * credentials is not fatal here - `/health` reports it and the handler loads them again per request.
 */
let startup = null;
try {
  const accounts = credentialStore.readAll();
  startup = { accounts, report: upstream.syncEgress(accounts) };
} catch (error) {
  logger.warn('credentials.missing', { reason: errorCategory(error) });
}

const server = createServer({ config, credentialStore, upstream, pool, logger });

server.listen(config.listen.port, config.listen.host, () => {
  logger.info('server.started', {
    listen: `${config.listen.host}:${config.listen.port}`,
    upstream: config.upstream.baseUrl,
  });
  if (!startup) return;
  const { accounts } = startup;
  // payload-free: the journal gets the account labels (acct-<hash>), never emails or token file
  // paths. Which credential a label belongs to is an operator question, answered on the host.
  logger.info('credentials.loaded', {
    count: accounts.length,
    accounts: accounts.map((a) => accountLabel(a)),
    projects: accounts.map((a) => (a.projectId ? 'set' : 'missing')),
    // exit per account, protocol and host:port only (a proxy url may carry credentials); 'none'
    // is an unmapped account in a deployment that declares exits, 'refused' one that lost its lane
    // to an earlier account. Both fail closed; syncEgress already journaled the detail.
    egress: accounts.map((a) => {
      if (upstream.egressRefused?.has(a.id)) return 'refused';
      const url = upstream.egressFor(a);
      if (!url) return 'none';
      try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return 'invalid'; }
    }),
  });
});
