/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, basic, jsonCommand, messagePath } = require('./helpers');
test('administrative diagnostics redact credentials and obey audit bounds', async t => {
  const { request, put } = await setup(t, { config: { maxAuditEntries: 3 } });
  await request('/ibmmq/rest/v3/login');
  await request('/auth/generate-otp', { method: 'POST', body: { username: 'testuser' } });
  await put('SECRET_MESSAGE_BODY', { headers: { 'X-Request-Id': 'my-request.123' } });
  const sessions = await request('/admin/sessions');
  assert.equal(sessions.data.sessions[0].username, 'adminusr');
  assert.equal(sessions.data.sessions[0].token, undefined);
  const otps = await request('/admin/otps');
  assert.equal(otps.data.otps[0].username, 'testuser'); assert.equal(otps.data.otps[0].value, undefined);
  const metrics = await request('/admin/metrics');
  assert.equal(metrics.data.counts.messages, 1); assert.equal(metrics.data.puts, 1); assert.ok(metrics.data.responses['200'] > 0);
  const audit = await request('/admin/audit');
  assert.equal(audit.data.audit.length, 3); assert.equal(JSON.stringify(audit.data).includes('SECRET'), false);
  assert.equal(JSON.stringify(audit.data).includes('adminpas'), false);
  assert.equal((await request('/admin/otps', { method: 'DELETE' })).status, 204);
  assert.deepEqual((await request('/admin/otps')).data, { otps: [] });
  const token = (await request('/ibmmq/rest/v3/login')).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/admin/sessions', { method: 'DELETE' })).status, 204);
  assert.equal((await request('/ibmmq/rest/v3/login', { auth: null, headers: { Cookie: token } })).status, 401);
  assert.equal((await request('/health', { auth: null })).data.sessions, 0);
});
test('state reset restores cloned fixtures; queue manager restart retains only persistent messages', async t => {
  const { request, put, mqsc } = await setup(t);
  await put('nonpersistent');
  await put('persistent', { headers: { 'ibm-mq-md-persistence': 'persistent' } });
  assert.equal((await request('/admin/qmgr/QM1/state', { method: 'PATCH', body: { state: 'ended' } })).status, 204);
  assert.equal((await request(messagePath)).status, 503);
  assert.equal((await request('/admin/qmgr/QM1/state', { method: 'PATCH', body: { state: 'running' } })).status, 204);
  assert.equal((await request(messagePath)).text, 'persistent');
  await mqsc(jsonCommand('define', 'qlocal', 'RESET.ME'));
  assert.equal((await request('/admin/state')).data.queueManagers[0].queues.some(record => record.name === 'RESET.ME'), true);
  assert.equal((await request('/admin/reset', { method: 'POST' })).status, 204);
  assert.equal((await request(messagePath)).status, 204);
  assert.equal((await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/RESET.ME')).status, 404);
  assert.equal((await request('/admin/qmgr/QM1/state', { method: 'PATCH', body: { state: 'bad' } })).status, 400);
});
test('scripted failures and latency sequences are isolated, bounded, and consumed once', async t => {
  const { request, put } = await setup(t, { config: { latencyMs: 1 } });
  const second = await setup(t);
  const scenarios = [{ method: 'POST', path: '/ibmmq/rest/v3/messaging/*', steps: [{ status: 503, reasonCode: 2059 }, { delayMs: 2 }, { status: 204 }] }];
  const set = await request('/admin/scenarios', { method: 'POST', body: { scenarios } });
  assert.equal(set.status, 201);
  let result = await put('first');
  assert.equal(result.status, 503); assert.equal(result.headers.get('retry-after'), '1'); assert.equal(result.headers.get('x-mock-simulated'), 'true'); assert.equal(result.data.error[0].reasonCode, 2059);
  assert.equal((await request('/health')).data.messages, 0);
  assert.equal((await put('second')).status, 201);
  assert.equal((await put('third')).status, 204);
  assert.equal((await put('fourth')).status, 201);
  assert.equal((await second.put('independent')).status, 201);
  assert.equal((await request('/admin/scenarios')).data.scenarios[0].index, 3);
  assert.equal((await request('/admin/scenarios', { method: 'DELETE' })).status, 204);
  assert.deepEqual((await request('/admin/scenarios')).data, { scenarios: [] });
  for (const [simulation, status] of Object.entries({ unauthorized: 401, forbidden: 403, notfound: 404, invalid: 400, unavailable: 503, error: 500, empty: 204 })) assert.equal((await request(`/ibmmq/rest/v3/admin/qmgr?simulate=${simulation}`)).status, status);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr?simulate=bad')).status, 400);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr?simulate=empty&simulate=error')).status, 400);
});
test('scenario validation preserves the previous sequence when new configuration is rejected', async t => {
  const { request } = await setup(t, { config: { maxScenarios: 1 } });
  const path = '/admin/scenarios';
  const valid = { method: '*', path: '/ibmmq/rest/*', steps: [{ status: 429 }] };
  assert.equal((await request(path, { method: 'POST', body: { scenarios: [valid] } })).status, 201);
  for (const scenarios of [
    null, [valid, valid], [{}], [{ ...valid, method: 'BAD' }], [{ ...valid, path: '/admin/*' }], [{ ...valid, steps: [] }],
    [{ ...valid, steps: Array(101).fill({}) }], [{ ...valid, steps: [{ status: 201 }] }], [{ ...valid, steps: [{ status: 600 }] }],
    [{ ...valid, steps: [{ status: 400.5 }] }], [{ ...valid, steps: [{ delayMs: 60001 }] }], [{ ...valid, steps: [{ reasonCode: -1 }] }], [{ ...valid, steps: [{ extra: true }] }]
  ]) assert.equal((await request(path, { method: 'POST', body: { scenarios } })).status, 400);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr')).status, 429);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr')).status, 200);
});
test('CORS, request IDs, error encoding, and logging support client integrations', async t => {
  const errors = [];
  const { request, app } = await setup(t, { config: { corsOrigin: 'http://localhost:3000' }, logger: { error: value => errors.push(value) } });
  const preflight = await request('/ibmmq/rest/v3/admin/qmgr', { method: 'OPTIONS', auth: null, headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000'); assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  const result = await request('/health', { headers: { 'X-Request-Id': 'known-id', Origin: 'http://localhost:3000' } });
  assert.equal(result.headers.get('x-request-id'), 'known-id'); assert.equal(result.headers.get('x-powered-by'), null); assert.equal(result.headers.get('x-content-type-options'), 'nosniff'); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match((await request('/health', { headers: { 'X-Request-Id': '!invalid' } })).headers.get('x-request-id'), /^[a-f\d-]{36}$/);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr/%ZZ')).status, 400);
  for (const body of ['{bad JSON}', 'null', '1', Buffer.from([0xff])]) assert.equal((await request('/ibmmq/rest/v3/login', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await request('/ibmmq/rest/v3/login', { method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  app.locals.state.qmgr = () => { throw new Error('PASSWORD=hidden'); };
  const error = await request('/ibmmq/rest/v3/admin/qmgr/QM1');
  assert.equal(error.status, 500); assert.equal(error.text.includes('PASSWORD'), false); assert.equal(JSON.stringify(errors).includes('PASSWORD'), false); assert.equal(errors.length, 1);
  const wildcard = await setup(t, { config: { corsOrigin: '*' } });
  const wildcardResult = await wildcard.request('/health', { headers: { Origin: 'http://example.test' } });
  assert.equal(wildcardResult.headers.get('access-control-allow-origin'), '*'); assert.equal(wildcardResult.headers.get('access-control-allow-credentials'), null);
});
test('resource, message, and byte limits reject new state without evicting existing data', async t => {
  const fixtures = { queueManagers: [{ name: 'QM1', queues: [{ name: 'DEV.QUEUE.1', storage: { maximumDepth: 2, maximumMessageLength: 10 } }] }] };
  const { request, put, mqsc } = await setup(t, { fixtures, config: { maxObjects: 1, maxMessages: 2, maxMessageBytes: 10 } });
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'OVER.LIMIT'))).status, 503);
  assert.equal((await mqsc(jsonCommand('define', 'channel', 'OVER.LIMIT'))).status, 503);
  assert.equal((await put('123456')).status, 201);
  assert.equal((await put('12345')).status, 503);
  assert.equal((await put('1234')).status, 201);
  assert.equal((await put('')).status, 503);
  assert.equal((await request('/health')).data.messageBytes, 10);
  assert.equal((await request(messagePath, { method: 'DELETE' })).text, '123456');
  assert.equal((await put('')).status, 201);
  assert.equal((await request('/health')).data.messages, 2);
  const queueLimit = await setup(t, { fixtures });
  assert.equal((await queueLimit.put('12345678901')).status, 400);
  assert.equal((await queueLimit.put('first')).status, 201); assert.equal((await queueLimit.put('second')).status, 201);
  assert.equal((await queueLimit.put('third')).status, 500);
  const qmgrLimit = await setup(t);
  await qmgrLimit.mqsc(jsonCommand('alter', 'qmgr', undefined, { maxmsgl: 1 }));
  assert.equal((await qmgrLimit.put('ab')).status, 400);
});
