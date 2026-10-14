/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, jsonCommand } = require('./helpers');

for (const version of ['v1', 'v2', 'v3']) {
  test(`${version}: Zowe's z/OS queue lifecycle commands return completion messages and change state`, async t => {
    const { request } = await setup(t, { config: { mqscResponseStyle: 'zos' } });
    const plain = command => request(`/ibmmq/rest/${version}/admin/action/qmgr/QM1/mqsc`, {
      method: 'POST', csrf: 'true', body: { type: 'runCommand', parameters: { command } }
    });
    const commands = [
      ["DEFINE QL(ZOWE.TEST.DONT.USE) DESCR('A test queue to play with for Zowe') HARDENBO INDXTYPE(MSGID)", "CSQMAQLC ' DEFINE QL' NORMAL COMPLETION"],
      ['DISPLAY QL(ZOWE.TEST.DONT.USE) ALL', "CSQMDRTS ' DISPLAY QLOCAL' NORMAL COMPLETION"],
      ['DELETE QL(ZOWE.TEST.DONT.USE)', "CSQMUQLC ' DELETE QL' NORMAL COMPLETION"]
    ];
    for (const [command, expected] of commands) {
      const result = await plain(command);
      assert.equal(result.status, 200);
      assert.equal(result.data.overallReasonCode, 0); assert.equal(result.data.overallCompletionCode, 0);
      const response = result.data.commandResponse[0];
      assert.equal(response.reasonCode, 0); assert.equal(response.completionCode, 0);
      assert.match(response.text[0], /^CSQN205I .*RETURN=00000000/);
      assert.ok(response.text.at(-1).includes(expected));
      if (command.startsWith('DEFINE')) {
        const queue = (await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/ZOWE.TEST.DONT.USE?attributes=*')).data.queue[0];
        assert.equal(queue.general.description, 'A test queue to play with for Zowe');
        assert.equal(queue.extended.hardenGetBackout, true); assert.equal(queue.storage.indexType, 'messageId');
        const duplicate = await plain(command);
        assert.equal(duplicate.data.overallCompletionCode, 2);
        assert.equal(duplicate.data.commandResponse[0].reasonCode, 4001);
        assert.ok(!duplicate.data.commandResponse[0].text.join('').includes('NORMAL COMPLETION'));
      } else if (command.startsWith('DISPLAY')) {
        assert.match(response.text[1], /QUEUE\(ZOWE.TEST.DONT.USE\)/);
        assert.match(response.text[1], /INDXTYPE\(MSGID\)/); assert.match(response.text[1], /HARDENBO\(YES\)/);
      }
    }
    assert.equal((await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/ZOWE.TEST.DONT.USE')).status, 404);
    const missing = await plain('DISPLAY QL(ZOWE.TEST.DONT.USE) ALL');
    assert.equal(missing.data.overallCompletionCode, 2); assert.equal(missing.data.overallReasonCode, 3008);
    assert.ok(!missing.data.commandResponse[0].text.join('').includes('NORMAL COMPLETION'));
  });
}

test('queue abbreviations and z/OS attributes round trip through JSON MQSC and REST', async t => {
  const { mqsc, request } = await setup(t, { config: { mqscResponseStyle: 'zos' } });
  const created = await mqsc(jsonCommand('define', 'ql', 'TEST.LOCAL', { hardenbo: 'yes', indxtype: 'CORRELID' }));
  assert.match(created.data.commandResponse[0].message[0], /^AMQ8006I/);
  assert.equal(created.data.commandResponse[0].text, undefined);
  for (const [qualifier, name, parameters, type] of [
    ['qa', 'TEST.ALIAS', { target: 'TEST.LOCAL' }, 'QALIAS'],
    ['qr', 'TEST.REMOTE', { rqmname: 'QM2' }, 'QREMOTE'],
    ['qm', 'TEST.MODEL', { deftype: 'PERMDYN' }, 'QMODEL']
  ]) {
    assert.equal((await mqsc(jsonCommand('define', qualifier, name, parameters))).data.overallCompletionCode, 0);
    assert.equal((await mqsc(jsonCommand('display', qualifier, name))).data.commandResponse[0].parameters.type, type);
  }
  await mqsc({ type: 'runCommand', parameters: { command: 'ALTER QL(TEST.LOCAL) NOHARDENBO INDXTYPE(NONE)' } });
  const fields = (await mqsc(jsonCommand('display', 'ql', 'TEST.LOCAL', {}, ['hardenbo', 'indxtype']))).data.commandResponse[0].parameters;
  assert.equal(fields.hardenbo, 'NO'); assert.equal(fields.indxtype, 'NONE');
  assert.equal((await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/TEST.LOCAL', {
    method: 'PATCH', body: { storage: { indexType: 'groupId' }, extended: { hardenGetBackout: true } }
  })).status, 204);
  const changed = (await mqsc(jsonCommand('display', 'qlocal', 'TEST.LOCAL'))).data.commandResponse[0].parameters;
  assert.equal(changed.indxtype, 'GROUPID'); assert.equal(changed.hardenbo, 'YES');
  const multi = await mqsc({ type: 'runCommand', parameters: { command: 'DISPLAY QL(DEV.*) ALL' } });
  assert.equal(multi.data.commandResponse.length, 3);
  assert.ok(multi.data.commandResponse.every(response => response.text.at(-1).includes("CSQMDRTS ' DISPLAY QLOCAL' NORMAL COMPLETION")));
});

test('invalid index values and conflicting backout flags cannot create a queue', async t => {
  const { mqsc, request } = await setup(t);
  for (const parameters of [{ indxtype: 'INVALID' }, { hardenbo: true }, { hardenbo: 'no' }, { hardenbo: 'yes', nohardenbo: 'yes' }]) {
    assert.equal((await mqsc(jsonCommand('define', 'ql', 'INVALID.Q', parameters))).status, 400);
  }
  for (const command of ['DEFINE QL(INVALID.Q) HARDENBO NOHARDENBO', 'DEFINE QL(INVALID.Q) INDXTYPE(INVALID)']) {
    assert.equal((await mqsc({ type: 'runCommand', parameters: { command } })).status, 400);
  }
  assert.equal((await request('/ibmmq/rest/v1/admin/qmgr/QM1/queue/INVALID.Q')).status, 404);
  assert.equal((await mqsc(jsonCommand('define', 'ql', 'NOHARDEN.Q', { nohardenbo: 'yes', indxtype: 'MSGTOKEN' }))).data.overallCompletionCode, 0);
  const fields = (await mqsc(jsonCommand('display', 'ql', 'NOHARDEN.Q'))).data.commandResponse[0].parameters;
  assert.equal(fields.hardenbo, 'NO'); assert.equal(fields.indxtype, 'MSGTOKEN');
});
