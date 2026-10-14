/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { createConfig } = require('../src/config');
test('configuration validates types, ranges, precedence, and immutable defaults', () => {
  assert.equal(createConfig().port, 9080);
  assert.equal(createConfig({ port: 0 }, { PORT: '1234' }).port, 0);
  assert.equal(createConfig({}, { PORT: '1234', REQUIRE_CSRF: 'false', HOST: 'localhost', BODY_LIMIT: '2mb', CORS_ORIGIN: '*' }).requireCsrf, false);
  assert.ok(Object.isFrozen(createConfig()));
  for (const config of [{ unknown: 1 }, { port: -1 }, { port: 65536 }, { port: '1.2' }, { maxSessions: 0 }, { maxMessages: Number.MAX_SAFE_INTEGER + 1 }, { requireCsrf: 'yes' }, { host: '' }, { host: 1 }, { bodyLimit: 'none' }, { bodyLimit: '0b' }, { maxWaitMs: 60001 }, { latencyMs: 60001 }]) assert.throws(() => createConfig(config));
  assert.equal(createConfig({ corsOrigin: '', maxWaitMs: 0, otpSingleUse: 'false' }).otpSingleUse, false);
});
test('user configuration validates roles, credentials, and authorization rules', () => {
  for (const users of [null, [], { '': { password: 'p', roles: ['MQWebUser'] } }, { 'bad:name': { password: 'p', roles: ['MQWebUser'] } }, { user: { password: '', roles: ['MQWebUser'] } }, { user: { password: 'p', roles: ['bad'] } }, { user: { password: 'p', roles: [] } }, { user: { password: 'p', roles: 'MQWebUser' } }, { user: { password: 'p', roles: ['MQWebUser'], permissions: { admin: 'bad' } } }, { user: { password: 'p', roles: ['MQWebUser'], permissions: { queues: [{}] } } }, { user: { password: 'p', roles: ['MQWebUser'], permissions: { queues: [{ qmgr: '*', name: '*', operations: ['bad'] }] } } }, { user: { password: 'p', roles: ['MQWebUser'], permissions: { queues: 'bad' } } }]) assert.throws(() => createApp({ users }));
});
test('fixtures reject malformed data, duplicate identities, unsafe keys, and excessive startup allocations', () => {
  const base = { name: 'QM1', queues: [{ name: 'Q' }] };
  for (const fixtures of [null, [], {}, { unknown: [] }, { queueManagers: [base, base] }, { queueManagers: [{ name: 'QM1', state: 'bad' }] }, { queueManagers: [{ name: 'QM1', queues: [{ name: 'Q' }, { name: 'Q' }] }] }, { queueManagers: [{ name: 'QM1', messages: { MISSING: [] } }] }, { queueManagers: [{ ...base, messages: { Q: 'bad' } }] }, { queueManagers: [{ ...base, messages: { Q: [{ body: 1 }] } }] }, { queueManagers: [{ ...base, messages: { Q: [{ body: 'x', messageId: 'bad' }] } }] }, { queueManagers: [{ ...base, messages: { Q: [{ body: 'x', priority: 10 }] } }] }, { queueManagers: [{ ...base, messages: { Q: [{ body: 'x', persistence: 'bad' }] } }] }, { queueManagers: [{ ...base, messages: { Q: [{ body: 'x', expiryMs: -1 }] } }] }, JSON.parse('{"queueManagers":[{"name":"QM1","parameters":{"__proto__":{"polluted":true}}}]}')]) assert.throws(() => createApp({ fixtures }));
  assert.equal({}.polluted, undefined);
  assert.throws(() => createApp({ config: { maxQueueManagers: 1 } }));
  assert.throws(() => createApp({ config: { maxObjects: 1 } }));
  assert.throws(() => createApp({ config: { maxMessages: 1 }, fixtures: { queueManagers: [{ ...base, messages: { Q: [{ body: 'a' }, { body: 'b' }] } }] } }));
});
