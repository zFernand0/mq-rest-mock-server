/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const assert = require('node:assert/strict');
async function main() {
  const base = (process.env.MOCK_SERVER_URL || 'http://127.0.0.1:9080').replace(/\/$/, '');
  const credentials = Buffer.from('adminusr:adminpas').toString('base64');
  const headers = { Authorization: `Basic ${credentials}`, 'ibm-mq-rest-csrf-token': 'example' };
  const commandUrl = `${base}/ibmmq/rest/v3/admin/action/qmgr/QM1/mqsc`;
  const queueName = `EXAMPLE.${process.pid}`;
  async function command(command, parameters = {}) {
    const response = await fetch(commandUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'runCommandJSON', command, qualifier: 'qlocal', name: queueName, parameters }) });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.overallCompletionCode, 0);
    return body;
  }
  const messageUrl = `${base}/ibmmq/rest/v3/messaging/qmgr/QM1/queue/${queueName}/message`;
  await command('define', { maxdepth: 10 });
  try {
    const put = await fetch(messageUrl, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'Hello MQ from the example client' });
    assert.equal(put.status, 201); await put.text();
    const id = put.headers.get('ibm-mq-md-messageId'); assert.match(id, /^ID:[a-f\d]{48}$/i);
    const browse = await fetch(`${messageUrl}?messageId=${encodeURIComponent(id)}`, { headers });
    assert.equal(browse.status, 200); assert.equal(await browse.text(), 'Hello MQ from the example client');
    const consume = await fetch(messageUrl, { method: 'DELETE', headers });
    assert.equal(consume.status, 200); await consume.text();
    const empty = await fetch(messageUrl, { method: 'DELETE', headers }); assert.equal(empty.status, 204);
    const display = await command('display'); assert.equal(display.commandResponse[0].parameters.curdepth, 0);
    console.log('Queue creation, message IDs, browse, consume, and MQSC depth checks passed.');
  } finally { await command('delete', { purge: 'yes' }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
