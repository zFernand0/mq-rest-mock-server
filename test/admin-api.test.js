/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, basic, jsonCommand } = require('./helpers');
const queuePath = '/ibmmq/rest/v1/admin/qmgr/QM1/queue';
test('installation and queue managers return IBM envelopes and attribute projections across versions', async t => {
  const { request } = await setup(t);
  for (const version of ['v1', 'v2', 'v3']) {
    const base = `/ibmmq/rest/${version}/admin`;
    assert.deepEqual((await request(`${base}/installation`)).data.installation[0], { name: 'Installation1', version: '9.4.0.0', platform: 'unix' });
    assert.equal((await request(`${base}/installation/Installation1?attributes=extended`)).data.installation[0].extended.maximumCommandLevel, 940);
    assert.deepEqual((await request(`${base}/installation?attributes=extended.primary`)).data.installation[0].extended, { primary: true });
    const qmgrs = await request(`${base}/qmgr`);
    assert.deepEqual(qmgrs.data, { qmgr: [{ name: 'QM1', state: 'running' }, { name: 'QM2', state: 'ended' }] });
    assert.equal((await request(`${base}/qmgr?state=running`)).data.qmgr.length, 1);
    assert.equal((await request(`${base}/qmgr/QM1?attributes=*&status=*`)).data.qmgr[0].status.connectionCount, 0);
    assert.deepEqual((await request(`${base}/qmgr/QM1?status=status.connectionCount`)).data.qmgr[0].status, { connectionCount: 0 });
    assert.equal((await request(`${base}/qmgr/QM2?status=*`)).data.qmgr[0].status, undefined);
    const missing = await request(`${base}/qmgr/missing`);
    assert.equal(missing.status, 404); assert.equal(missing.data.error[0].messageId, 'MQWB0009E');
  }
});
test('queue writes are stateful, replace by default, preserve messages, and support LIKE and noReplace', async t => {
  const { request, put } = await setup(t);
  const create = await request(queuePath, { method: 'POST', body: { name: 'TEST.Q', storage: { maximumDepth: 20 }, general: { description: 'Test queue' } } });
  assert.equal(create.status, 201); assert.equal(create.text, ''); assert.match(create.headers.get('location'), /queue\/TEST.Q$/);
  let record = (await request(`${queuePath}/TEST.Q?attributes=storage,general`)).data.queue[0];
  assert.equal(record.storage.maximumDepth, 20); assert.equal(record.general.description, 'Test queue');
  assert.equal((await request(`${queuePath}?like=TEST.Q`, { method: 'POST', body: { name: 'COPY.Q' } })).status, 201);
  assert.equal((await request(`${queuePath}/COPY.Q?attributes=storage.maximumDepth`)).data.queue[0].storage.maximumDepth, 20);
  assert.equal((await request(`${queuePath}?noReplace`, { method: 'POST', body: { name: 'TEST.Q' } })).status, 400);
  assert.equal((await request(`${queuePath}?like=MISSING`, { method: 'POST', body: { name: 'NO.Q' } })).status, 404);
  await put('retained');
  assert.equal((await request(queuePath, { method: 'POST', body: { name: 'DEV.QUEUE.1', general: { description: 'Replaced definition' } } })).status, 201);
  assert.equal((await request(`${queuePath}/DEV.QUEUE.1?status=*`)).data.queue[0].status.currentDepth, 1);
  assert.equal((await request(`${queuePath}/DEV.QUEUE.1`, { method: 'DELETE' })).status, 400);
  assert.equal((await request(`${queuePath}/DEV.QUEUE.1?purge`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`${queuePath}/DEV.QUEUE.1`)).status, 404);
  assert.equal((await request(`${queuePath}/COPY.Q`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`${queuePath}/COPY.Q`, { method: 'PATCH', body: { general: { description: 'x' } } })).status, 404);
  assert.equal((await request(`${queuePath}/TEST.Q`, { method: 'PATCH', body: { storage: { maximumDepth: 30 } } })).status, 204);
  record = (await request(`${queuePath}/TEST.Q?attributes=*`)).data.queue[0];
  assert.equal(record.storage.maximumDepth, 30); assert.equal(record.general.description, 'Test queue');
});
test('all queue types return their defining objects and invalid updates do not mutate state', async t => {
  const { request } = await setup(t);
  for (const [type, group] of [['alias', { targetName: 'DEV.QUEUE.1' }], ['remote', { queueName: 'REMOTE.Q', qmgrName: 'QM2' }], ['model', { type: 'permanentDynamic' }]]) {
    assert.equal((await request(queuePath, { method: 'POST', body: { name: `${type}.Q`, type, [type]: group } })).status, 201);
    const record = (await request(`${queuePath}/${type}.Q`)).data.queue[0];
    assert.equal(record.type, type);
    for (const [key, value] of Object.entries(group)) assert.equal(record[type][key], value);
  }
  for (const body of [
    { name: 'BAD.Q', type: 'bad' }, { name: 'bad name' }, { name: 'BAD.Q', unknown: true },
    { name: 'BAD.Q', general: { extra: 1 } }, { name: 'BAD.Q', general: { inhibitGet: 'true' } },
    { name: 'BAD.Q', storage: { maximumDepth: '100' } }, { name: 'BAD.Q', storage: { maximumDepth: -1 } },
    { name: 'BAD.Q', applicationDefaults: { persistence: 'invalid' } },
    { name: 'BAD.Q', general: { description: 1 } }, { name: 'BAD.Q', general: { description: 'x'.repeat(65) } },
    { name: 'BAD.Q', general: [] }, { name: 'BAD.Q', alias: { targetName: 'DEV.QUEUE.1' } }
  ]) assert.equal((await request(queuePath, { method: 'POST', body })).status, 400, JSON.stringify(body));
  for (const body of [{ name: 'CHANGED.Q' }, { type: 'remote' }, { general: { inhibitPut: true }, storage: { maximumDepth: -1 } }]) {
    assert.equal((await request(`${queuePath}/DEV.QUEUE.1`, { method: 'PATCH', body })).status, 400);
  }
  assert.equal((await request(`${queuePath}/DEV.QUEUE.1?attributes=general.inhibitPut`)).data.queue[0].general.inhibitPut, false);
  assert.equal((await request(`${queuePath}/BAD.Q`)).status, 404);
});
test('queue filtering, status, sorting, and mock pagination use actual state', async t => {
  const { request, put } = await setup(t);
  await put('one');
  const filtered = await request(`${queuePath}?type=local&name=DEV.*&attributes=storage.maximumDepth&status=status.currentDepth&filter=status.currentDepth:greaterThan:0`);
  assert.equal(filtered.data.queue.length, 1); assert.equal(filtered.data.queue[0].name, 'DEV.QUEUE.1');
  const page = await request(`${queuePath}?type=local&name=DEV.*&mockOrderBy=name/D&mockOffset=1&mockLimit=1`);
  assert.equal(page.headers.get('x-mock-total-count'), '3'); assert.deepEqual(page.data.queue, [{ name: 'DEV.QUEUE.2', type: 'local' }]);
  assert.equal((await request(`${queuePath}?filter=general.inhibitPut:equalTo:false`)).data.queue.length, 7);
  assert.equal((await request(`${queuePath}?filter=general.description:notEqualTo:nonempty`)).data.queue.length, 7);
  assert.equal((await request(`${queuePath}?filter=general.description:equalTo:`)).data.queue.length, 7);
  for (const [op, expected] of [['lessThan', 0], ['greaterThan', 7], ['lessThanOrEqualTo', 7], ['greaterThanOrEqualTo', 7]]) {
    const constant = op === 'greaterThan' ? 1 : 5000;
    assert.equal((await request(`${queuePath}?filter=storage.maximumDepth:${op}:${constant}`)).data.queue.length, expected);
  }
  const tie = await request(`${queuePath}?type=local&mockOrderBy=storage.maximumDepth/A&attributes=storage`);
  assert.equal(tie.data.queue[0].name, 'DEV.QUEUE.1');
  assert.equal((await request(`${queuePath}?name=NOTHING*`)).data.queue.length, 0);
});
test('invalid read parameters and unsupported versions fail explicitly', async t => {
  const { request } = await setup(t);
  const bad = [
    `${queuePath}?name=DEV.QUEUE.1`, `${queuePath}/DEV.QUEUE.1?name=*`, `${queuePath}/DEV.QUEUE.1?filter=general.description:equalTo:`,
    `${queuePath}?type=bad`, `${queuePath}?type=remote&status=*`, `${queuePath}?filter=status.currentDepth:equalTo:0`,
    `${queuePath}?filter=bad`, `${queuePath}?filter=name:equalTo:DEV.QUEUE.1`, `${queuePath}?filter=general.unknown:equalTo:`,
    `${queuePath}?filter=general.inhibitPut:equalTo:wrong`, `${queuePath}?filter=storage.maximumDepth:equalTo:bad`,
    `${queuePath}?filter=general.description:greaterThan:x`, `${queuePath}?filter=general:equalTo:x`,
    `${queuePath}?attributes=missing`, `${queuePath}?attributes=general.missing`, `${queuePath}?attributes=general.a.b`,
    `${queuePath}?attributes=general&attributes=storage`, `${queuePath}?mockLimit=0`, `${queuePath}?mockOffset=-1`,
    `${queuePath}?mockOrderBy=name`, `${queuePath}?mockOrderBy=unknown/A`, `${queuePath}?mockOrderBy=general/A`, `${queuePath}?Count=1`,
    '/ibmmq/rest/v3/admin/qmgr?state=bad', '/ibmmq/rest/v3/admin/qmgr/QM1?state=running'
  ];
  for (const path of bad) assert.equal((await request(path)).status, 400, path);
  for (const version of ['v2', 'v3']) {
    assert.equal((await request(queuePath.replace('/v1/', `/${version}/`))).status, 404);
    assert.equal((await request(queuePath.replace('/v1/', `/${version}/`), { method: 'POST', body: { name: 'NO.Q' } })).status, 404);
  }
  assert.equal((await request('/ibmmq/rest/v4/admin/qmgr')).status, 404);
  assert.equal((await request('/ibmmq/rest/v3/Admin/qmgr')).status, 404);
  assert.equal((await request('/ibmmq/rest/v3/admin/installation/missing')).status, 404);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr', { method: 'POST', body: { name: 'FAKE.QM' } })).status, 405);
  assert.equal((await request(queuePath.replace('QM1', 'QM2'))).status, 503);
  assert.equal((await request('/ibmmq/rest/v3/admin/qmgr', { headers: { 'ibm-mq-rest-gateway-qmgr': 'QM1' } })).status, 400);
});
test('v1 channel and subscription queries use MQSC-created definitions', async t => {
  const { request, mqsc } = await setup(t);
  const channels = '/ibmmq/rest/v1/admin/qmgr/QM1/channel';
  assert.deepEqual((await request(channels)).data.channel.map(row => row.name), ['QM1.TO.QM2']);
  assert.equal((await request(`${channels}/DEV.APP.SVRCONN`)).status, 404);
  assert.equal((await request(`${channels}?attributes=general`)).data.channel[0].sender.connection[0].port, 1415);
  for (const [chltype, type] of [['RCVR', 'receiver'], ['SVR', 'server'], ['RQSTR', 'requester'], ['CLUSSDR', 'clusterSender'], ['CLUSRCVR', 'clusterReceiver']]) {
    const name = `TEST.${chltype}`;
    assert.equal((await mqsc(jsonCommand('define', 'channel', name, { chltype, conname: 'remote.example', xmitq: 'XMIT', cluster: 'CLUSTER1' }))).data.overallCompletionCode, 0);
    const record = (await request(`${channels}/${name}?attributes=*`)).data.channel[0];
    assert.equal(record.type, type);
    if (record[type]?.connection) assert.equal(record[type].connection[0].host, 'remote.example');
  }
  await mqsc(jsonCommand('define', 'channel', 'NO.CONNAME', { chltype: 'SDR' }));
  assert.deepEqual((await request(`${channels}/NO.CONNAME`)).data.channel[0].sender.connection, []);
  assert.equal((await request(`${channels}?type=receiver&name=TEST.*`)).data.channel.length, 1);
  const subs = '/ibmmq/rest/v1/admin/qmgr/QM1/subscription';
  const record = (await request(`${subs}/DEV.SUB?attributes=topic,destination,general`)).data.subscription[0];
  assert.match(record.id, /^[a-f\d]{48}$/); assert.equal(record.resolvedTopicString, 'dev/events'); assert.equal(record.destination.queueName, 'DEV.QUEUE.2');
  assert.equal((await request(`${subs}?id=${record.id.toUpperCase()}`)).data.subscription.length, 1);
  assert.equal((await request(`${subs}?name=DEV.*&filter=general.durable:equalTo:true`)).data.subscription.length, 1);
  assert.equal((await request(`${subs}?name=`)).data.subscription.length, 0);
  for (const path of [`${channels}?type=bad`, `${channels}?name=exact`, `${channels}/QM1.TO.QM2?name=*`, `${subs}?name=exact`, `${subs}?id=bad`, `${subs}/DEV.SUB?id=${record.id}`, `${subs}?id=${record.id}&name=*`, `${subs}/DEV.SUB?name=*`, `${subs}/DEV.SUB?filter=general.durable:equalTo:true`, `${subs}?id=${record.id}&filter=general.durable:equalTo:true`]) assert.equal((await request(path)).status, 400, path);
  assert.equal((await request(`${subs}/MISSING`)).status, 404);
  assert.equal((await request(subs.replace('/v1/', '/v3/'))).status, 404);
  assert.equal((await request(channels.replace('/v1/', '/v2/'))).status, 404);
});
test('fixtures are cloned and separate app instances do not share mutations', async t => {
  const fixtures = { installation: { name: 'TestInstall' }, queueManagers: [{ name: 'MY.QM/1%', queues: [{ name: 'lower.case/Q%', storage: { maximumDepth: 2 } }] }] };
  const first = await setup(t, { fixtures });
  const second = await setup(t, { fixtures });
  fixtures.queueManagers[0].queues[0].name = 'MUTATED';
  const path = '/ibmmq/rest/v1/admin/qmgr/MY.QM%2F1%25/queue/lower.case%2FQ%25';
  assert.equal((await first.request(path)).data.queue[0].name, 'lower.case/Q%');
  assert.equal((await first.request(path, { method: 'PATCH', body: { general: { description: 'First app only' } } })).status, 204);
  assert.equal((await second.request(`${path}?attributes=general.description`)).data.queue[0].general.description, '');
});
