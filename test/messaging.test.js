/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: pause } = require('node:timers/promises');
const { setup, jsonCommand, messagePath } = require('./helpers');
async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition timed out'); await pause(2); }
}
for (const version of ['v1', 'v2', 'v3']) {
  test(`${version}: put, list, browse, select, consume, and empty response contracts`, async t => {
    const { request } = await setup(t);
    const base = `/ibmmq/rest/${version}/messaging/qmgr/QM1/queue/DEV.QUEUE.1`;
    const correlation = `${version === 'v3' ? 'ID:' : ''}${'ab'.repeat(24)}`;
    const put = await request(`${base}/message`, { method: 'POST', body: 'hello 🌎', headers: { 'Content-Type': 'text/plain;charset=utf-8', 'ibm-mq-md-correlationId': correlation, 'ibm-mq-md-persistence': 'persistent', 'ibm-mq-md-replyTo': 'REPLY.Q@QM1' } });
    assert.equal(put.status, 201); assert.equal(put.text, '');
    const id = put.headers.get('ibm-mq-md-messageid');
    assert.match(id, version === 'v3' ? /^ID:[a-f\d]{48}$/ : /^[a-f\d]{48}$/);
    assert.equal(put.headers.get('ibm-mq-resolved-qmgr'), 'QM1');
    const list = await request(`${base}/messagelist?limit=1&correlationId=${correlation}&messageId=${id}`);
    assert.deepEqual(list.data, { messages: [{ messageId: id, correlationId: correlation, format: 'MQSTR' }] });
    assert.equal(list.text.includes('hello'), false);
    const browse = await request(`${base}/message?messageId=${id}`);
    assert.equal(browse.status, 200); assert.equal(browse.text, 'hello 🌎');
    assert.match(browse.headers.get('content-type'), /^text\/plain/);
    assert.equal(browse.headers.get('content-length'), String(Buffer.byteLength('hello 🌎')));
    assert.equal(browse.headers.get('ibm-mq-md-persistence'), 'persistent');
    assert.equal(browse.headers.get('ibm-mq-md-expiry'), 'unlimited');
    assert.equal(browse.headers.get('ibm-mq-md-replyto'), 'REPLY.Q@QM1');
    assert.equal(browse.headers.get('ibm-mq-md-priority'), version === 'v3' ? '0' : null);
    assert.equal((await request(`${base}/message?correlationId=${correlation}`)).text, 'hello 🌎');
    assert.equal((await request(`${base}/message?correlationId=${version === 'v3' ? 'ID:' : ''}${'cd'.repeat(24)}`)).status, 204);
    assert.equal((await request(`${base}/message?messageId=${id}`, { method: 'DELETE' })).text, 'hello 🌎');
    const depth = (await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/DEV.QUEUE.1?status=*')).data.queue[0].status;
    assert.equal(depth.currentDepth, 0); assert.match(depth.lastGet, /^\d{4}-/); assert.match(depth.lastPut, /^\d{4}-/);
    assert.deepEqual((await request(`${base}/messagelist`)).data, { messages: [] });
    const empty = await request(`${base}/message`, { method: 'DELETE' });
    assert.equal(empty.status, 204); assert.equal(empty.text, '');
  });
}
test('JSON is opaque messaging text; UTF-8 XML, HTML, and empty bodies are supported', async t => {
  const { request } = await setup(t);
  for (const [type, body] of [['application/json', '{not JSON}'], ['application/xml', '<request/>'], ['text/html', '<p>hello</p>'], ['text/xml', '<x>y</x>'], ['text/plain', '']]) {
    assert.equal((await request(messagePath, { method: 'POST', body, headers: { 'Content-Type': type } })).status, 201);
    assert.equal((await request(messagePath, { method: 'DELETE' })).text, body);
  }
});
test('v3 priorities, FIFO, user properties, and application correlation IDs round trip', async t => {
  const { put, request, mqsc } = await setup(t);
  const properties = 'userPropertyA;5;byte,description;"hello, world";string,flag;true;boolean,count;-10;integer,value;1.5;double';
  const lower = await put('low', { headers: { 'ibm-mq-md-priority': '2' } });
  const higher = await put('high', { headers: { 'ibm-mq-md-priority': '9', 'ibm-mq-usr': properties, 'ibm-mq-md-correlationId': 'My-Custom-ID' } });
  const browse = await request(messagePath);
  assert.equal(browse.text, 'high'); assert.equal(browse.headers.get('ibm-mq-usr'), properties); assert.equal(browse.headers.get('ibm-mq-md-correlationid'), 'My-Custom-ID');
  assert.equal((await request(messagePath, { method: 'DELETE' })).text, 'high');
  assert.equal((await request(messagePath, { method: 'DELETE' })).text, 'low');
  await mqsc(jsonCommand('alter', 'qlocal', 'DEV.QUEUE.1', { msgdlvsq: 'FIFO', defprty: 7 }));
  await put('first', { headers: { 'ibm-mq-md-priority': '1' } });
  await put('second', { headers: { 'ibm-mq-md-priority': '9' } });
  const destination = await put('default');
  assert.equal((await request(`${messagePath}?messageId=${destination.headers.get('ibm-mq-md-messageid')}`)).headers.get('ibm-mq-md-priority'), '7');
  assert.equal((await request(messagePath)).text, 'first');
  const list = await request(messagePath.replace('/message', '/messagelist'));
  assert.equal(list.data.messages[0].messageId, (await request(messagePath)).headers.get('ibm-mq-md-messageid'));
  assert.match(lower.headers.get('ibm-mq-md-messageid'), /^ID:/); assert.match(higher.headers.get('ibm-mq-md-messageid'), /^ID:/);
});
test('expiry and status age use an injected clock without sleeping', async t => {
  let now = 100000;
  const { request, put } = await setup(t, { now: () => now });
  await put('expires', { headers: { 'ibm-mq-md-expiry': '10000' } });
  now += 2000;
  assert.equal((await request(messagePath)).headers.get('ibm-mq-md-expiry'), '8000');
  assert.equal((await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/DEV.QUEUE.1?status=*')).data.queue[0].status.oldestMessageAge, 2);
  now += 8000;
  assert.equal((await request(messagePath)).status, 204);
  assert.equal((await request('/health')).data.messages, 0);
  await put('zero expiry', { headers: { 'ibm-mq-md-expiry': '0' } });
  assert.equal((await request(messagePath)).status, 204);
});
test('aliases share the target queue and honor both alias and target inhibition', async t => {
  const { request, mqsc } = await setup(t);
  const alias = messagePath.replace('DEV.QUEUE.1', 'DEV.ALIAS.1');
  assert.equal((await request(alias, { method: 'POST', body: 'aliased', headers: { 'Content-Type': 'text/plain' } })).status, 201);
  assert.equal((await request(messagePath)).text, 'aliased');
  await mqsc(jsonCommand('alter', 'qalias', 'DEV.ALIAS.1', { get: 'DISABLED', put: 'DISABLED' }));
  assert.equal((await request(alias)).status, 405);
  assert.equal((await request(alias, { method: 'POST', body: 'denied', headers: { 'Content-Type': 'text/plain' } })).status, 405);
  assert.deepEqual((await request(alias.replace('/message', '/messagelist'))).data, { messages: [] });
  await mqsc(jsonCommand('alter', 'qlocal', 'DEV.QUEUE.1', { get: 'DISABLED', put: 'DISABLED' }));
  assert.equal((await request(messagePath, { method: 'DELETE' })).status, 405);
  assert.equal((await request(messagePath.replace('DEV.QUEUE.1', 'DEV.REMOTE.1'))).status, 400);
  await mqsc(jsonCommand('define', 'qalias', 'LOOP.A', { target: 'LOOP.B' }));
  await mqsc(jsonCommand('define', 'qalias', 'LOOP.B', { target: 'LOOP.A' }));
  assert.equal((await request(messagePath.replace('DEV.QUEUE.1', 'LOOP.A'))).status, 400);
  await mqsc(jsonCommand('define', 'qalias', 'TOPIC.ALIAS', { target: 'DEV.TOPIC', targtype: 'TOPIC' }));
  assert.equal((await request(messagePath.replace('DEV.QUEUE.1', 'TOPIC.ALIAS'))).status, 400);
});
test('invalid media types, metadata, UTF-8, and oversized requests leave queues unchanged', async t => {
  const { request, put } = await setup(t, { config: { bodyLimit: '100b' } });
  for (const headers of [
    { 'ibm-mq-md-priority': '10' }, { 'ibm-mq-md-expiry': '-1' }, { 'ibm-mq-md-persistence': 'bad' },
    { 'ibm-mq-md-messageId': 'custom' }, { 'ibm-mq-md-correlationId': 'ID:bad' },
    { 'ibm-mq-md-replyTo': 'A@B@C' }, { 'ibm-mq-md-replyTo': 'bad name' }
  ]) assert.equal((await put('no', { headers })).status, 400, JSON.stringify(headers));
  for (const type of ['application/octet-stream', 'text/plain;charset=latin1']) assert.equal((await put('no', { headers: { 'Content-Type': type } })).status, 415);
  assert.equal((await request(messagePath, { method: 'POST', body: Buffer.from('no') })).status, 415);
  assert.equal((await put(Buffer.from([0xff, 0xfe]))).status, 415);
  assert.equal((await put('x'.repeat(101))).status, 413);
  assert.equal((await put('no', { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  for (const suffix of ['?messageId=bad', '?correlationId=ID:bad', '?messageId=a&messageId=b', '?wait=1', '?unknown=1']) assert.equal((await request(`${messagePath}${suffix}`)).status, 400, suffix);
  for (const version of ['v1', 'v2']) {
    for (const headers of [{ 'ibm-mq-md-priority': '4' }, { 'ibm-mq-usr': 'a;1;integer' }, { 'ibm-mq-md-correlationId': 'app-id' }]) assert.equal((await request(messagePath.replace('/v3/', `/${version}/`), { method: 'POST', body: 'no', headers: { 'Content-Type': 'text/plain', ...headers } })).status, 400);
  }
  assert.equal((await request(messagePath.replace('/message', '/messagelist?limit=0'))).status, 400);
  assert.equal((await request(messagePath, { headers: { 'Accept-Charset': 'latin1' } })).status, 406);
  assert.equal((await request('/health')).data.messages, 0);
});
test('message properties validate types and reject duplicates or malformed values', async t => {
  const { put, request } = await setup(t);
  for (const header of ['a;1;byte,a;2;byte', 'bad-format', 'a;1;invalid', 'a;unquoted;string', 'a;4;boolean', 'a;NaN;double', 'a;128;byte', 'a;1.5;integer', 'a;;integer', ',a;1;byte', 'a;"unterminated;string', 'a;9007199254740992;long']) assert.equal((await put('no', { headers: { 'ibm-mq-usr': header } })).status, 400, header);
  for (const header of ['a;-32768;short', 'a;123;long', 'a;1.25;float', 'a;"hello \\"quoted\\"";string']) {
    const result = await put('yes', { headers: { 'ibm-mq-usr': header } });
    assert.equal(result.status, 201, header);
    assert.equal((await request(messagePath, { method: 'DELETE' })).headers.get('ibm-mq-usr'), header);
  }
});
test('unsupported fixture message formats remain available after failed consumption', async t => {
  const fixtures = { queueManagers: [{ name: 'QM1', queues: [{ name: 'DEV.QUEUE.1' }], messages: { 'DEV.QUEUE.1': [{ body: 'binary', format: 'MQFMT_NONE' }] } }] };
  const { request } = await setup(t, { fixtures });
  assert.equal((await request(messagePath, { method: 'DELETE' })).status, 501);
  assert.equal((await request(messagePath)).status, 501);
  assert.equal((await request('/health')).data.messages, 1);
  assert.equal((await request(messagePath.replace('/message', '/messagelist'))).data.messages[0].format, 'MQFMT_NONE');
});
test('waiting consumers receive a later put exactly once under concurrency', async t => {
  const { request, put, app } = await setup(t);
  const consumers = Array.from({ length: 4 }, () => request(`${messagePath}?wait=100`, { method: 'DELETE' }));
  await waitUntil(() => app.locals.state.waiters === 4);
  await put('one delivery');
  const responses = await Promise.all(consumers);
  assert.equal(responses.filter(result => result.status === 200).length, 1);
  assert.equal(responses.filter(result => result.status === 204).length, 3);
  assert.equal(app.locals.state.waiters, 0);
});
test('waiting limits, cancellation, revocation, and stopped managers release waiters', async t => {
  const { request, app } = await setup(t, { config: { maxWaiters: 1 } });
  const abort = new AbortController();
  const pending = request(`${messagePath}?wait=1000`, { method: 'DELETE', signal: abort.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await waitUntil(() => app.locals.state.waiters === 1);
  assert.equal((await request(`${messagePath}?wait=1`, { method: 'DELETE' })).status, 503);
  abort.abort(); await rejection; await waitUntil(() => app.locals.state.waiters === 0);
  const revoked = request(`${messagePath}?wait=1000`, { method: 'DELETE' });
  await waitUntil(() => app.locals.state.waiters === 1);
  await request('/admin/sessions', { method: 'DELETE' });
  assert.equal((await revoked).status, 401);
  const stopped = request(`${messagePath}?wait=1000`, { method: 'DELETE' });
  await waitUntil(() => app.locals.state.waiters === 1);
  await request('/admin/qmgr/QM1/state', { method: 'PATCH', body: { state: 'ended' } });
  assert.equal((await stopped).status, 503);
  assert.equal(app.locals.state.waiters, 0);
  assert.equal((await request(`${messagePath}?wait=30001`, { method: 'DELETE' })).status, 400);
});
test('exact topic publications route atomically to subscriptions using encoded or multi-level paths', async t => {
  const { request, mqsc } = await setup(t);
  for (const path of ['/ibmmq/rest/v3/messaging/qmgr/QM1/topic/dev/events/message', '/ibmmq/rest/v2/messaging/qmgr/QM1/topic/dev%2Fevents/message']) {
    assert.equal((await request(path, { method: 'POST', body: 'event', headers: { 'Content-Type': 'text/plain' } })).status, 201);
  }
  assert.equal((await request(messagePath.replace('DEV.QUEUE.1', 'DEV.QUEUE.2'), { method: 'DELETE' })).text, 'event');
  await mqsc(jsonCommand('define', 'sub', 'SECOND.SUB', { topicstr: 'dev/events', dest: 'DEV.QUEUE.3' }));
  await mqsc(jsonCommand('alter', 'qlocal', 'DEV.QUEUE.3', { maxdepth: 0 }));
  const path = '/ibmmq/rest/v3/messaging/qmgr/QM1/topic/dev/events/message';
  assert.equal((await request(path, { method: 'POST', body: 'failure', headers: { 'Content-Type': 'text/plain' } })).status, 500);
  assert.equal((await request('/health')).data.messages, 1);
  await mqsc(jsonCommand('alter', 'qlocal', 'DEV.QUEUE.3', { maxdepth: 1 }));
  await mqsc(jsonCommand('alter', 'topic', 'DEV.TOPIC', { pub: 'DISABLED' }));
  assert.equal((await request(path, { method: 'POST', body: 'failure', headers: { 'Content-Type': 'text/plain' } })).status, 405);
  assert.equal((await request(path.replace('/v3/', '/v1/'), { method: 'POST', body: 'failure', headers: { 'Content-Type': 'text/plain' } })).status, 404);
  assert.equal((await request('/ibmmq/rest/v3/messaging/qmgr/QM1/topic/no/subscribers/message', { method: 'POST', body: 'no subscribers', headers: { 'Content-Type': 'text/plain' } })).status, 201);
  assert.equal((await request('/ibmmq/rest/v3/messaging/qmgr/QM1/topic/%00/message', { method: 'POST', body: 'no', headers: { 'Content-Type': 'text/plain' } })).status, 400);
  await mqsc(jsonCommand('alter', 'topic', 'DEV.TOPIC', { pub: 'ENABLED' }));
  await mqsc(jsonCommand('alter', 'sub', 'SECOND.SUB', { destqm: 'OTHER' }));
  assert.equal((await request(path, { method: 'POST', body: 'no', headers: { 'Content-Type': 'text/plain' } })).status, 400);
  await mqsc(jsonCommand('alter', 'sub', 'SECOND.SUB', { destqm: '', dest: 'DEV.QUEUE.3' }));
  await mqsc(jsonCommand('alter', 'qlocal', 'DEV.QUEUE.3', { put: 'DISABLED' }));
  assert.equal((await request(path, { method: 'POST', body: 'no', headers: { 'Content-Type': 'text/plain' } })).status, 405);
});
