/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const { once } = require('node:events');
const { createApp } = require('../server');
const { main } = require('./test-client');
async function run() {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previous = process.env.MOCK_SERVER_URL;
  process.env.MOCK_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
  try { await main(); }
  finally {
    if (previous === undefined) delete process.env.MOCK_SERVER_URL;
    else process.env.MOCK_SERVER_URL = previous;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
