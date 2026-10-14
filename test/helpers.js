/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const { once } = require('node:events');
const { createApp } = require('../server');
const basic = (username = 'adminusr', password = 'adminpas') => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
async function setup(t, options = {}) {
  const app = createApp(options);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', auth = basic(), csrf = '', body, headers = {}, signal } = {}) {
    const outgoing = { ...headers };
    if (auth !== null) outgoing.authorization = auth;
    if (csrf !== null) outgoing['ibm-mq-rest-csrf-token'] = csrf;
    let data = body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      data = JSON.stringify(body); outgoing['Content-Type'] ??= 'application/json';
    }
    const response = await fetch(`${url}${path}`, { method, body: data, headers: outgoing, signal });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, data: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  }
  const mqsc = (body, options) => request('/ibmmq/rest/v3/admin/action/qmgr/QM1/mqsc', { method: 'POST', body, ...options });
  const put = (body = 'hello', options = {}) => request('/ibmmq/rest/v3/messaging/qmgr/QM1/queue/DEV.QUEUE.1/message', { method: 'POST', body, headers: { 'Content-Type': 'text/plain', ...options.headers }, ...options, ...(options.headers ? { headers: { 'Content-Type': 'text/plain', ...options.headers } } : {}) });
  return { app, server, url, request, mqsc, put };
}
const jsonCommand = (command, qualifier, name, parameters = {}, responseParameters) => ({ type: 'runCommandJSON', command, qualifier, ...(name === undefined ? {} : { name }), parameters, ...(responseParameters === undefined ? {} : { responseParameters }) });
const messagePath = '/ibmmq/rest/v3/messaging/qmgr/QM1/queue/DEV.QUEUE.1/message';
module.exports = { setup, basic, jsonCommand, messagePath };
