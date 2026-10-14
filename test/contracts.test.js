/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, jsonCommand, messagePath } = require('./helpers');
test('OpenAPI declares only supported versions, correct bodies, and resolvable schemas', async t => {
  const { request } = await setup(t);
  const response = await request('/openapi.json', { auth: null });
  assert.equal(response.status, 200);
  const spec = response.data;
  assert.equal(spec.openapi, '3.0.3');
  function inspect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      let target = spec;
      for (const key of value.$ref.slice(2).split('/')) target = target[key];
      assert.ok(target, value.$ref);
    }
    for (const child of Object.values(value)) inspect(child);
  }
  inspect(spec);
  assert.ok(spec.paths['/ibmmq/rest/v1/admin/qmgr/{qmgrName}/queue'].post);
  assert.equal(spec.paths['/ibmmq/rest/v3/admin/qmgr/{qmgrName}/queue'], undefined);
  assert.equal(spec.paths['/ibmmq/rest/v1/messaging/qmgr/{qmgrName}/topic/{topicString}/message'], undefined);
  const messaging = spec.paths['/ibmmq/rest/v3/messaging/qmgr/{qmgrName}/queue/{queueName}/message'];
  assert.ok(messaging.get.responses['200'].content['text/plain']);
  assert.ok(messaging.get.responses['204']);
  assert.equal(messaging.post.requestBody.content['application/json'].schema.type, 'string');
  assert.ok(messaging.post.parameters.some(param => param.name === 'ibm-mq-md-priority'));
  assert.equal(spec.paths['/ibmmq/rest/v2/messaging/qmgr/{qmgrName}/queue/{queueName}/message'].post.parameters.some(param => param.name === 'ibm-mq-md-priority'), false);
  assert.equal(messaging.delete.parameters.find(param => param.name === 'wait').schema.type, 'integer');
  assert.equal(spec.components.schemas.QueuePatch.properties.name, undefined);
  assert.ok(spec.components.schemas.QueueWrite.properties.applicationDefaults.properties.messagePriority);
});
test('IBM attribute names, flag syntax, and mixed queue filtering match the documented contract', async t => {
  const { request, mqsc, put } = await setup(t);
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'FLAGS.Q', { trigger: 'yes', noshare: 'yes', noreplace: 'yes', defprty: 8, defpsist: 'YES', clusnl: 'CLUSTER.LIST' }))).data.overallCompletionCode, 0);
  const queue = (await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/FLAGS.Q?attributes=*')).data.queue[0];
  assert.equal(queue.applicationDefaults.messagePriority, 8); assert.equal(queue.applicationDefaults.messagePersistence, 'persistent');
  assert.equal(queue.cluster.namelist, 'CLUSTER.LIST'); assert.equal(queue.extended.allowSharedInput, false); assert.equal(queue.trigger.enabled, true);
  assert.equal((await mqsc(jsonCommand('alter', 'qlocal', 'FLAGS.Q', { notrigger: 'yes', share: 'yes' }))).data.overallCompletionCode, 0);
  for (const parameters of [{ replace: true }, { replace: 'no' }, { replace: 'yes', noreplace: 'yes' }, { share: 'no' }]) assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'INVALID.Q', parameters))).status, 400);
  await put('mixed status filter');
  const filtered = await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue?status=*&filter=status.currentDepth:greaterThan:0');
  assert.equal(filtered.status, 200); assert.deepEqual(filtered.data.queue.map(queue => queue.name), ['DEV.QUEUE.1']);
  for (const attributes of ['general,general', '*,general']) assert.equal((await request(`/ibmmq/rest/v1/admin/qmgr/QM1/queue?attributes=${attributes}`)).status, 400);
  assert.equal((await request('/ibmmq/rest/v3/login', { method: 'POST', body: { username: 'adminusr', password: 'adminpas' }, headers: { 'Content-Type': 'application/json;charset=latin1' } })).status, 415);
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', '123'))).data.overallCompletionCode, 0);
  assert.equal((await mqsc({ type: 'runCommand', parameters: { command: 'DISPLAY QLOCAL(123)' } })).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('alter', 'qmgr', undefined, { descr: 1 }))).status, 400);
});
test('message fixtures normalize hexadecimal metadata and reject unsafe HTTP header values', async t => {
  const id = 'AB'.repeat(24);
  const fixtures = { queueManagers: [{ name: 'QM1', queues: [{ name: 'DEV.QUEUE.1' }], messages: { 'DEV.QUEUE.1': [{ body: 'fixture', messageId: id, correlationId: id, replyTo: 'REPLY@QM1', properties: 'a;1;integer' }] } }] };
  const { request } = await setup(t, { fixtures });
  const received = await request(`${messagePath}?correlationId=ID:${id}`);
  assert.equal(received.status, 200); assert.equal(received.headers.get('ibm-mq-md-correlationid'), `ID:${id.toLowerCase()}`);
  assert.equal(received.headers.get('ibm-mq-md-messageid'), `ID:${id.toLowerCase()}`);
  const { createApp } = require('../server');
  for (const patch of [{ correlationId: 1 }, { replyTo: 'A@B@C' }, { replyTo: 'bad\nheader' }, { properties: 'bad' }]) {
    const invalid = structuredClone(fixtures); Object.assign(invalid.queueManagers[0].messages['DEV.QUEUE.1'][0], patch);
    assert.throws(() => createApp({ fixtures: invalid }));
  }
  const { put } = await setup(t);
  assert.equal((await put('no', { headers: { 'ibm-mq-md-correlationId': 'x'.repeat(257) } })).status, 400);
  assert.equal((await put('no', { headers: { 'ibm-mq-usr': 'a;1e100;float' } })).status, 400);
});
test('sessions revoked during scripted latency cannot mutate resource state', async t => {
  let now = 100000;
  const { request, put } = await setup(t, { now: () => now, config: { sessionTtlMs: 1000 }, scenarios: [{ method: 'POST', path: '/ibmmq/rest/v3/messaging/*', steps: [{ delayMs: 30 }] }] });
  const pending = put('expired session');
  await new Promise(resolve => setTimeout(resolve, 5));
  now += 1000;
  assert.equal((await pending).status, 401); assert.equal((await request('/health')).data.messages, 0);
});
test('the embedded example exercises the public client workflow and closes its listener', async () => {
  const { run } = require('../examples/embedded-client');
  await run();
});
