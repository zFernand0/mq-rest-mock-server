/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, jsonCommand, messagePath } = require('./helpers');
test('plain MQSC preserves quoted names, escaped apostrophes, and text response envelopes', async t => {
  const { mqsc, request } = await setup(t);
  const plain = command => mqsc({ type: 'runCommand', parameters: { command } });
  let result = await plain("DEFINE QLOCAL('lower.Q') DESCR('It''s a test') MAXDEPTH(2) NOSHARE UNSUPPORTED");
  assert.equal(result.status, 400);
  result = await plain("DEFINE QLOCAL('lower.Q') DESCR('It''s a test') MAXDEPTH(2) NOSHARE TRIGGER");
  assert.equal(result.status, 200); assert.equal(result.data.overallCompletionCode, 0);
  assert.match(result.data.commandResponse[0].text[0], /queue created/);
  const display = await plain("DIS QLOCAL('lower.Q') DESCR MAXDEPTH");
  assert.match(display.data.commandResponse[0].text[0], /QUEUE\(lower.Q\)/);
  assert.match(display.data.commandResponse[0].text[0], /DESCR\(It's a test\)/);
  const queue = (await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/lower.Q?attributes=general,extended')).data.queue[0];
  assert.equal(queue.general.description, "It's a test"); assert.equal(queue.extended.allowSharedInput, false);
  await plain('DEF QLOCAL(UPPER.Q) MAXDEPTH(10)');
  assert.equal((await plain('ALT QLOCAL(upper.q) MAXDEPTH(20)')).data.overallCompletionCode, 0);
  assert.equal((await plain('DEL QLOCAL(upper.q) NOPURGE')).data.overallCompletionCode, 0);
  assert.equal((await plain('DISPLAY CHANNEL(MISSING) ALL')).data.overallReasonCode, 3008);
  await plain("DEFINE NAMELIST(TEST.LIST) NAMES('A,B')");
  assert.match((await plain('DISPLAY NAMELIST(TEST.LIST) ALL')).data.commandResponse[0].text[0], /NAMES\(A,B\)/);
});
test('JSON MQSC definitions share state with the v1 queue and messaging APIs', async t => {
  const { mqsc, request, put } = await setup(t);
  const parameters = { maxdepth: 2, maxmsgl: 20, descr: 'Queue contract', share: 'yes', defprty: 3, defpsist: 'yes', msgdlvsq: 'fifo', usage: 'normal', trigger: 'yes', trigtype: 'every', trigdpth: 5, trigdata: 'data', initq: 'INIT', process: 'PROC', bothresh: 2, boqname: 'BACKOUT' };
  const created = await mqsc(jsonCommand('DEFINE', 'QLOCAL', 'TEST.Q', parameters));
  assert.equal(created.status, 200); assert.equal(created.data.overallReasonCode, 0); assert.match(created.data.commandResponse[0].message[0], /^AMQ8006I/);
  const queue = (await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/TEST.Q?attributes=*')).data.queue[0];
  assert.equal(queue.applicationDefaults.messagePersistence, 'persistent'); assert.equal(queue.trigger.type, 'every'); assert.equal(queue.general.inhibitGet, false);
  const dup = await mqsc(jsonCommand('define', 'qlocal', 'TEST.Q'));
  assert.equal(dup.data.overallCompletionCode, 2); assert.equal(dup.data.commandResponse[0].reasonCode, 4001);
  assert.equal((await mqsc(jsonCommand('define', 'qlocal', 'TEST.Q', { replace: "yes", maxdepth: 3 }))).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('define', 'queue', 'TEST.REMOTE', { type: 'QREMOTE', rname: 'Q', rqmname: 'QM2', xmitq: 'XMIT' }))).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('define', 'qalias', 'TEST.ALIAS', { target: 'TEST.Q', targtype: 'queue' }))).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('define', 'qmodel', 'TEST.MODEL', { deftype: 'permdyn' }))).data.overallCompletionCode, 0);
  const copy = await mqsc(jsonCommand('define', 'qlocal', 'COPY.Q', { like: 'TEST.Q' }));
  assert.equal(copy.data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('display', 'queue', '*', { type: 'QALIAS' }))).data.commandResponse.every(row => row.parameters.type === 'QALIAS'), true);
  await put('live message');
  const status = await mqsc(jsonCommand('display', 'qstatus', 'DEV.QUEUE.1', {}, ['curdepth']));
  assert.deepEqual(status.data.commandResponse[0].parameters, { qstatus: 'DEV.QUEUE.1', type: 'QUEUE', curdepth: 1 });
  assert.equal((await mqsc(jsonCommand('delete', 'qlocal', 'DEV.QUEUE.1'))).data.overallCompletionCode, 2);
  assert.equal((await mqsc(jsonCommand('clear', 'qlocal', 'DEV.QUEUE.1'))).data.overallCompletionCode, 0);
  assert.equal((await request(messagePath)).status, 204);
  await put('purge message');
  assert.equal((await mqsc(jsonCommand('delete', 'qlocal', 'DEV.QUEUE.1', { purge: "yes" }))).data.overallCompletionCode, 0);
});
for (const [qualifier, identity, parameters] of [
  ['channel', 'channel', { chltype: 'SVRCONN', descr: 'Test' }], ['listener', 'listener', { port: 1515 }],
  ['topic', 'topic', { topicstr: 'test/events' }], ['sub', 'sub', { topicstr: 'test/events', dest: 'DEV.QUEUE.1', durable: 'NO' }],
  ['process', 'process', { applicid: '/bin/test' }], ['namelist', 'namelist', { names: ['A', 'B'] }],
  ['authinfo', 'authinfo', { authtype: 'IDPWOS' }], ['service', 'service', { startcmd: '/bin/test' }]
]) {
  test(`MQSC ${qualifier} create, display, alter, copy, and delete`, async t => {
    const { mqsc } = await setup(t);
    const name = 'TEST.OBJECT';
    assert.equal((await mqsc(jsonCommand('define', qualifier, name, parameters))).data.overallCompletionCode, 0);
    let result = await mqsc(jsonCommand('display', qualifier, name));
    assert.equal(result.data.commandResponse[0].parameters[identity], name);
    assert.equal((await mqsc(jsonCommand('alter', qualifier, name, { descr: 'Changed' }))).data.overallCompletionCode, 0);
    assert.equal((await mqsc(jsonCommand('define', qualifier, 'COPY.OBJECT', { like: name }))).data.overallCompletionCode, 0);
    result = await mqsc(jsonCommand('display', qualifier, 'COPY.OBJECT', {}, ['descr']));
    assert.equal(result.data.commandResponse[0].parameters.descr, 'Changed');
    assert.equal((await mqsc(jsonCommand('define', qualifier, name, { ...parameters, replace: 'yes' }))).data.overallCompletionCode, 0);
    assert.equal((await mqsc(jsonCommand('delete', qualifier, name))).data.overallCompletionCode, 0);
    result = await mqsc(jsonCommand('display', qualifier, name));
    assert.equal(result.data.overallCompletionCode, 2); assert.equal(result.data.overallReasonCode, 3008); assert.equal(result.data.commandResponse[0].reasonCode, 2085);
  });
}
test('MQSC start/stop and status commands reflect object state', async t => {
  const { mqsc } = await setup(t);
  for (const [qualifier, status, name] of [['channel', 'chstatus', 'QM1.TO.QM2'], ['listener', 'lsstatus', 'DEV.LISTENER.TCP'], ['service', 'svstatus', 'DEV.SERVICE']]) {
    assert.equal((await mqsc(jsonCommand('start', qualifier, name))).data.overallCompletionCode, 0);
    let result = await mqsc(jsonCommand('display', status, name));
    assert.equal(result.data.commandResponse[0].parameters.status, 'RUNNING');
    assert.equal((await mqsc(jsonCommand('stop', qualifier, name))).data.overallCompletionCode, 0);
    result = await mqsc(jsonCommand('display', status, name));
    assert.equal(result.data.commandResponse[0].parameters.status, 'STOPPED');
  }
  assert.equal((await mqsc(jsonCommand('ping', 'channel', 'QM1.TO.QM2'))).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('display', 'qmgr'))).data.commandResponse[0].parameters.qmgr, 'QM1');
  assert.equal((await mqsc(jsonCommand('display', 'qmstatus'))).data.commandResponse[0].parameters.status, 'RUNNING');
  assert.equal((await mqsc(jsonCommand('alter', 'qmgr', undefined, { descr: 'Changed', deadq: 'DEAD', maxmsgl: 1024 }))).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('display', 'qmgr', undefined, {}, ['descr']))).data.commandResponse[0].parameters.descr, 'Changed');
});
test('DISPLAY selectors and WHERE operators filter current MQSC attributes', async t => {
  const { mqsc } = await setup(t);
  await mqsc(jsonCommand('define', 'qlocal', 'SMALL.Q', { maxdepth: 2, descr: 'different' }));
  for (const [op, expected] of [['EQ', 1], ['NE', 4], ['GT', 4], ['LT', 0], ['GE', 5], ['LE', 1]]) {
    const result = await mqsc(jsonCommand('display', 'qlocal', '*', { where: `MAXDEPTH ${op} 2` }));
    const count = result.data.overallCompletionCode ? 0 : result.data.commandResponse.length;
    assert.equal(count, expected, op);
  }
  assert.equal((await mqsc(jsonCommand('display', 'queue', '*', { where: 'DESCR LK diff*' }))).data.commandResponse[0].parameters.queue, 'SMALL.Q');
  assert.equal((await mqsc(jsonCommand('display', 'queue', 'SMALL.Q', { where: "DESCR EQ 'different'" }))).data.overallCompletionCode, 0);
  assert.equal((await mqsc(jsonCommand('display', 'queue', '*', { where: 'DESCR NL diff*' }))).data.commandResponse.length, 7);
  assert.equal((await mqsc(jsonCommand('display', 'qlocal', 'DEV.*', {}, ['maxdepth']))).data.commandResponse.length, 3);
  assert.deepEqual(Object.keys((await mqsc(jsonCommand('display', 'qlocal', 'SMALL.Q', {}, ['maxdepth']))).data.commandResponse[0].parameters), ['queue', 'type', 'maxdepth']);
});
test('MQSC validates syntax and unsupported operations without pretending to succeed', async t => {
  const { mqsc, request } = await setup(t);
  const commands = [
    jsonCommand('unsupported', 'queue', '*'), jsonCommand('display', 'unsupported', '*'),
    jsonCommand('start', 'qmgr'), jsonCommand('display', 'qmgr', 'QM1'), jsonCommand('alter', 'qmstatus'),
    jsonCommand('alter', 'qmgr', undefined, { maxmsgl: -1 }), jsonCommand('alter', 'qmgr', undefined, { unknown: 'x' }),
    jsonCommand('display', 'queue', '*', { type: 'bad' }), jsonCommand('define', 'queue', 'BAD.Q'),
    jsonCommand('alter', 'qremote', 'DEV.QUEUE.1'), jsonCommand('alter', 'qlocal', 'DEV.QUEUE.1', { like: 'DEV.QUEUE.2' }),
    jsonCommand('define', 'qlocal', 'BAD.Q', { get: 'BAD' }), jsonCommand('define', 'qlocal', 'BAD.Q', { extra: 'value' }),
    jsonCommand('define', 'channel', 'BAD.CHL', { chltype: 'BAD' }), jsonCommand('define', 'channel', 'BAD.CHL', { descr: {} }),
    jsonCommand('define', 'channel', 'BAD.CHL', { 'bad-key': 1 }), jsonCommand('define', 'listener', 'BAD.LISTENER', { port: 0 }),
    jsonCommand('define', 'qlocal', 'BAD.Q', {}, ['all']), jsonCommand('display', 'queue', '*', {}, ['unknown']),
    jsonCommand('display', 'queue', '*', { where: 'CURDEPTH EQ bad' }), jsonCommand('display', 'queue', '*', { where: 'UNKNOWN EQ 1' }),
    jsonCommand('display', 'queue', '*', { where: 1 }), jsonCommand('display', 'queue', '*', { where: 'BAD' }),
    jsonCommand('delete', 'qstatus', 'DEV.QUEUE.1'), jsonCommand('start', 'chstatus', 'QM1.TO.QM2'),
    jsonCommand('ping', 'topic', 'DEV.TOPIC'), jsonCommand('clear', 'qmodel', 'DEV.MODEL.1'),
    jsonCommand('display', 'qlocal', '*', { MAXDEPTH: 1, maxdepth: 2 }),
    { type: 'runCommandJSON', command: 1, qualifier: 'queue' }, { type: 'runCommandJSON', command: 'display', qualifier: 'queue', name: 1 },
    { type: 'runCommandJSON', command: 'display', qualifier: 'queue', responseParameters: [1] }, { type: 'bad' }
  ];
  for (const body of commands) assert.equal((await mqsc(body)).status, 400, JSON.stringify(body));
  for (const command of ['', 'DISPLAY', 'DISPLAY() QUEUE(*)', "DISPLAY QUEUE('unterminated)", 'DISPLAY QUEUE(UNFINISHED', 'DISPLAY QUEUE(*) ; DELETE QLOCAL(DEV.QUEUE.1)', 'DEFINE QLOCAL(BAD.Q) MAXDEPTH(1) MAXDEPTH(2)', 'x'.repeat(16385)]) assert.equal((await mqsc({ type: 'runCommand', parameters: { command } })).status, 400, command.slice(0, 80));
  for (const body of [jsonCommand('alter', 'qlocal', 'MISSING'), jsonCommand('define', 'qlocal', 'NEW.Q', { like: 'MISSING' }), jsonCommand('delete', 'qlocal', 'MISSING')]) assert.equal((await mqsc(body)).data.overallCompletionCode, 2);
  assert.equal((await request(messagePath.replace('DEV.QUEUE.1', 'BAD.Q'))).status, 404);
});
