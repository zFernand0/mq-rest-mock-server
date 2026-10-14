/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, basic, jsonCommand, messagePath } = require('./helpers');
for (const version of ['v1', 'v2', 'v3']) {
  test(`${version}: Basic, login cookie, roles, expiry, and logout`, async t => {
    let now = 100000;
    const { request } = await setup(t, { now: () => now, config: { sessionTtlMs: 1000 } });
    const path = `/ibmmq/rest/${version}/login`;
    const anon = await request(path, { auth: null });
    assert.equal(anon.status, 401); assert.match(anon.headers.get('www-authenticate'), /Basic/);
    const result = await request(path);
    assert.deepEqual(result.data, { user: [{ name: 'adminusr', role: ['MQWebAdmin', 'MQWebUser'] }] });
    const cookie = result.headers.get('set-cookie').split(';')[0];
    assert.match(result.headers.get('set-cookie'), /HttpOnly/);
    assert.match(result.headers.get('set-cookie'), /SameSite=Lax/);
    const loggedIn = await request(path, { method: 'POST', auth: null, csrf: null, body: { username: 'adminusr', password: 'adminpas' } });
    assert.equal(loggedIn.status, 204); assert.equal(loggedIn.text, '');
    assert.equal(loggedIn.headers.get('set-cookie').split(';')[0], cookie);
    assert.equal((await request(path, { auth: null, headers: { Cookie: cookie } })).status, 200);
    assert.equal((await request(path, { auth: basic('adminusr', 'wrong'), headers: { Cookie: cookie } })).status, 401);
    assert.equal((await request(path, { auth: null, headers: { LtpaToken2: cookie.split('=')[1] } })).status, 200);
    assert.equal((await request(path, { method: 'DELETE', auth: null, csrf: null, headers: { Cookie: cookie } })).status, 401);
    const logout = await request(path, { method: 'DELETE', auth: null, headers: { Cookie: cookie } });
    assert.equal(logout.status, 204); assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
    assert.equal((await request(path, { auth: null, headers: { Cookie: cookie } })).status, 401);
    const fresh = await request(path);
    assert.notEqual(fresh.headers.get('set-cookie').split(';')[0], cookie);
    now += 1000;
    assert.equal((await request(path, { auth: null, headers: { Cookie: fresh.headers.get('set-cookie').split(';')[0] } })).status, 401);
  });
}
test('invalid credentials, login payloads, and methods fail with IBM error envelopes', async t => {
  const { request } = await setup(t);
  for (const auth of ['Bearer token', 'Basic abc!', 'Basic YWJj', basic('', 'x'), basic('unknown', 'x')]) {
    const result = await request('/ibmmq/rest/v3/login', { auth });
    assert.equal(result.status, 401); assert.equal(result.data.error[0].type, 'rest');
  }
  for (const body of [{ username: 5, password: 'p' }, { username: 'adminusr' }, { username: 'adminusr', password: 'adminpas', extra: true }, []]) {
    assert.equal((await request('/ibmmq/rest/v3/login', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/ibmmq/rest/v3/login', { method: 'POST', body: { username: 'adminusr', password: 'bad' } })).status, 401);
  assert.equal((await request('/ibmmq/rest/v3/login?unknown=x')).status, 400);
  const method = await request('/ibmmq/rest/v3/login', { method: 'PUT' });
  assert.equal(method.status, 405); assert.match(method.headers.get('allow'), /POST/);
});
test('roles distinguish read-only administration, MQWebUser, and mock controls', async t => {
  const { request, mqsc, put } = await setup(t);
  const reader = { auth: basic('reader', 'reader') };
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr', reader)).status, 200);
  assert.equal((await mqsc(jsonCommand('display', 'qlocal', '*'), reader)).status, 200);
  assert.equal((await mqsc(jsonCommand('ping', 'qmgr'), reader)).status, 200);
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'DENIED'), reader)).status, 403);
  assert.equal((await put('denied', reader)).status, 403);
  assert.equal((await request('/admin/state', reader)).status, 403);
  const app = { auth: basic('app', 'app') };
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr', app)).status, 200);
  assert.equal((await put('allowed', app)).status, 201);
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'DENIED'), app)).status, 403);
  const installation = await request('/ibmmq/rest/v3/admin/installation', reader);
  assert.equal(installation.status, 200);
});
test('custom users and queue permissions constrain messaging and administration', async t => {
  const users = {
    writer: { password: 'p:a:ss', roles: ['MQWebUser'], permissions: { admin: 'write', queues: [{ qmgr: 'QM*', name: 'DEV.QUEUE.1', operations: ['put', 'browse'] }] } },
    blocked: { password: 'p', roles: ['MQWebUser'], permissions: { queues: [] } },
    user: { password: 'p', roles: ['MQWebUser'] }
  };
  const { request, mqsc, put } = await setup(t, { users });
  const writer = { auth: basic('writer', 'p:a:ss') };
  assert.equal((await put('yes', writer)).status, 201);
  assert.equal((await request(messagePath, writer)).text, 'yes');
  assert.equal((await request(messagePath, { ...writer, method: 'DELETE' })).status, 403);
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'ALLOWED'), writer)).status, 200);
  assert.equal((await request('/ibmmq/rest/v3/messaging/qmgr/QM1/queue/DEV.QUEUE.2/message', writer)).status, 403);
  assert.equal((await put('no', { auth: basic('blocked', 'p') })).status, 403);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr', { auth: basic('blocked', 'p') })).status, 403);
  assert.equal((await request('/ibmmq/rest/v3/admin/installation', { auth: basic('user', 'p') })).status, 200);
});
test('single-use OTPs are reused until consumed, expire, and survive a rejected session allocation', async t => {
  let now = 100000;
  const { request } = await setup(t, { now: () => now, config: { otpTtlMs: 1000, maxSessions: 1, sessionTtlMs: 1000 } });
  const generate = () => request('/auth/generate-otp', { method: 'POST', auth: null, body: { username: 'testuser' } });
  assert.equal((await request('/auth/otp-status/testuser')).data.active, false);
  const first = await generate(); assert.match(first.data.otp, /^\d{6}$/); assert.equal(first.data.isReused, false);
  const second = await generate(); assert.equal(second.data.otp, first.data.otp); assert.equal(second.data.isReused, true);
  assert.equal((await request('/auth/otp-status/testuser')).data.active, true);
  await request('/ibmmq/rest/v3/login');
  assert.equal((await request('/ibmmq/rest/v3/login', { auth: basic('testuser', first.data.otp) })).status, 503);
  assert.equal((await generate()).data.otp, first.data.otp);
  now += 1000;
  assert.equal((await request('/auth/otp-status/testuser')).data.active, false);
  assert.equal((await request('/ibmmq/rest/v3/login', { auth: basic('testuser', first.data.otp) })).status, 401);
  const fresh = await generate();
  const authenticated = await request('/ibmmq/rest/v3/login', { auth: basic('testuser', fresh.data.otp) });
  assert.equal(authenticated.status, 200);
  assert.equal((await request('/ibmmq/rest/v3/login', { auth: basic('testuser', fresh.data.otp) })).status, 401);
  assert.equal((await request('/ibmmq/rest/v3/login', { auth: null, headers: { Cookie: authenticated.headers.get('set-cookie').split(';')[0] } })).status, 200);
  assert.equal((await request('/auth/generate-otp', { method: 'POST', body: { username: 'adminusr' } })).status, 400);
});
test('reusable OTPs and disabled CSRF are explicit configuration options', async t => {
  const { request, put } = await setup(t, { config: { otpSingleUse: false, requireCsrf: false } });
  const result = await request('/auth/generate-otp', { method: 'POST', body: { username: 'testuser' } });
  for (let index = 0; index < 2; index++) assert.equal((await request('/ibmmq/rest/v3/login', { auth: basic('testuser', result.data.otp) })).status, 200);
  assert.equal((await put('yes', { csrf: null })).status, 201);
});
test('CSRF presence is mandatory even for messaging GET but not administrative GET or login', async t => {
  const { request, put } = await setup(t);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr', { csrf: null })).status, 200);
  assert.equal((await put('no', { csrf: null })).status, 401);
  assert.equal((await request(messagePath, { csrf: null })).status, 401);
  assert.equal((await request(messagePath)).status, 204);
});
