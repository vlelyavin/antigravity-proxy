import { loadConfig } from './config/load-config.js';
import { createLogger } from './utils/logger.js';
import { CredentialStore } from './credentials/credential-store.js';
import { UpstreamClient } from './upstream/upstream-client.js';
import { AccountPool } from './upstream/account-pool.js';
import { createServer } from './server/create-server.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const credentialStore = new CredentialStore({
  searchPaths: config.credentials.searchPaths,
  logger,
});

const upstream = new UpstreamClient({ config, logger });
const pool = new AccountPool({ logger });

const server = createServer({ config, credentialStore, upstream, pool, logger });

server.listen(config.listen.port, config.listen.host, () => {
  logger.info('server.started', {
    listen: `${config.listen.host}:${config.listen.port}`,
    upstream: config.upstream.baseUrl,
  });
  try {
    const accounts = credentialStore.readAll();
    logger.info('credentials.loaded', {
      count: accounts.length,
      accounts: accounts.map((a) => a.email || a.id),
    });
  } catch (error) {
    logger.warn('credentials.missing', { error: error.message });
  }
});
