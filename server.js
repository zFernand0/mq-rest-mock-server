/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const http = require('node:http');
const { createApp } = require('./src/app');
const { createConfig } = require('./src/config');
const app = createApp();
module.exports = app;
module.exports.createApp = createApp;
module.exports.startServer = startServer;
function startServer({ env = process.env, logger = console, ...options } = {}) {
  const config = createConfig(options.config, env);
  const serverApp = createApp({ ...options, config, logger });
  const server = http.createServer(serverApp);
  server.requestTimeout = 65000; server.headersTimeout = 10000;
  const shutdown = () => { server.close(); server.closeIdleConnections(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  server.once('close', () => { process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown); });
  server.on('error', error => { logger.error(`Cannot start MQ mock server: ${error.message}`); process.exitCode = 1; });
  server.listen(config.port, config.host, () => logger.log(`IBM MQ REST Mock Server: http://${config.host}:${server.address().port}`));
  return server;
}
if (require.main === module) {
  try { startServer(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
