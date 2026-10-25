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

const server = createServer({ config, credentialStore, upstream, pool, logger });

server.listen(config.listen.port, config.listen.host, () => {
  logger.info('server.started', {
    listen: `${config.listen.host}:${config.listen.port}`,
    upstream: config.upstream.baseUrl,
  });
  try {
    const accounts = credentialStore.readAll();
    // payload-free: the journal gets the account labels (acct-<hash>), never emails or token file
    // paths. Which credential a label belongs to is an operator question, answered on the host.
    logger.info('credentials.loaded', {
      count: accounts.length,
      accounts: accounts.map((a) => accountLabel(a)),
      projects: accounts.map((a) => (a.projectId ? 'set' : 'missing')),
      // exit per account, protocol and host:port only (a proxy url may carry credentials)
      egress: accounts.map((a) => {
        const url = upstream.egressFor(a);
        if (!url) return 'direct';
        try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return 'invalid'; }
      }),
    });
  } catch (error) {
    logger.warn('credentials.missing', { reason: errorCategory(error) });
  }
});
