/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { startServer } = require('../server');
test('programmatic startup uses validated configuration and removes shutdown listeners', async t => {
  const messages = [];
  const before = process.listenerCount('SIGTERM');
  const server = startServer({ env: { PORT: '0', HOST: '127.0.0.1' }, logger: { log: value => messages.push(value), error: value => messages.push(value) } });
  t.after(() => { if (server.listening) server.close(); });
  await once(server, 'listening');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/health`)).status, 200);
  assert.match(messages[0], /IBM MQ REST Mock Server/);
  const closed = once(server, 'close');
  server.close(); server.closeAllConnections(); await closed;
  assert.equal(process.listenerCount('SIGTERM'), before);
});
test('imports create no listener or background interval; invalid CLI settings fail clearly', () => {
  const imported = spawnSync(process.execPath, ['-e', "const mock = require('./server'); if (typeof mock !== 'function' || typeof mock.createApp !== 'function') process.exit(2);"], { encoding: 'utf8', timeout: 5000 });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, '');
  const invalid = spawnSync(process.execPath, ['server.js'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, PORT: 'bad' } });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /PORT must be an integer/);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`CLI starts on an ephemeral port and shuts down on ${signal}`, async t => {
    const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const output = await new Promise((resolve, reject) => {
      child.stdout.once('data', buffer => resolve(buffer.toString()));
      child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`CLI exited ${code}`)); });
    });
    assert.match(output, /http:\/\/127.0.0.1:\d+/);
    const exit = once(child, 'exit'); child.kill(signal);
    assert.deepEqual(await exit, [0, null]);
  });
}
test('port conflicts produce a controlled CLI error and exit status', async t => {
  const server = startServer({ env: { PORT: '0' }, logger: { log() {}, error() {} } });
  t.after(() => server.close());
  await once(server, 'listening');
  const result = spawnSync(process.execPath, ['server.js'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, HOST: '127.0.0.1', PORT: String(server.address().port) } });
  assert.equal(result.status, 1); assert.match(result.stderr, /Cannot start MQ mock server:.*EADDRINUSE/);
});
