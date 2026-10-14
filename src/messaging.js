/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const crypto = require('node:crypto');
const { fail, query, integer, name } = require('./protocol');
const MEDIA_TYPES = ['text/plain', 'text/html', 'text/xml', 'application/json', 'application/xml'];
function identifier(value, version, correlation = false) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(400, 'MQ identifiers must be strings');
  const pattern = version === 'v3' ? /^ID:([a-f\d]{48})$/i : /^([a-f\d]{48})$/i;
  const match = pattern.exec(value);
  if (match) return `ID:${match[1].toLowerCase()}`;
  if (version === 'v3' && correlation && /^[\x20-\x7e]{1,256}$/.test(value) && !/^ID:/i.test(value)) return value;
  fail(400, 'MQ identifiers require 48 hexadecimal characters; v3 requires the ID: prefix');
}
function externalId(value, version) {
  return version === 'v3' || !value.startsWith('ID:') ? value : value.slice(3);
}
function properties(header) {
  if (header === undefined) return null;
  if (typeof header !== 'string' || !/^[\x20-\x7e]{1,8192}$/.test(header)) fail(400, 'User properties must fit an ASCII HTTP header');
  // Quoted strings may contain commas and escaped double quotes.
  const entries = header.match(/(?:[^,"\\]|\\.|"(?:[^"\\]|\\.)*")+/g);
  if (!entries || entries.join(',') !== header) fail(400, 'Invalid ibm-mq-usr properties');
  const seen = new Set();
  for (const entry of entries) {
    const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*;\s*(.*?)\s*;\s*(boolean|byte|short|integer|long|float|double|string)\s*$/.exec(entry);
    if (!match || seen.has(match[1])) fail(400, 'Invalid or duplicate user property');
    const [, key, value, type] = match;
    seen.add(key);
    if (type === 'string') {
      try { if (typeof JSON.parse(value) !== 'string') fail(400, 'String properties must be quoted'); }
      catch { fail(400, 'String properties must be JSON quoted strings'); }
    } else if (type === 'boolean') {
      if (!['true', 'false'].includes(value)) fail(400, 'Invalid boolean property');
    } else {
      if (!value || !Number.isFinite(Number(value))) fail(400, 'Invalid numeric property');
      const ranges = { byte: [-128, 127], short: [-32768, 32767], integer: [-2147483648, 2147483647], long: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] };
      if (type === 'float' && !Number.isFinite(Math.fround(Number(value)))) fail(400, 'Float property is out of range');
      if (ranges[type] && (!Number.isSafeInteger(Number(value)) || Number(value) < ranges[type][0] || Number(value) > ranges[type][1])) fail(400, 'Integer property is out of range');
    }
  }
  return header;
}
function createMessage(req, state, defaultPriority) {
  const version = req.params.version;
  const contentType = req.get('content-type') || '';
  if (!MEDIA_TYPES.includes(contentType.split(';')[0].trim().toLowerCase()) || /charset\s*=\s*(?!"?utf-8(?:"|\s|;|$))/i.test(contentType)) fail(415, 'Messaging accepts UTF-8 text, XML, or JSON content types');
  let body;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(req.body); }
  catch { fail(415, 'Message body must be UTF-8'); }
  const headers = ['ibm-mq-md-correlationid', 'ibm-mq-md-expiry', 'ibm-mq-md-persistence', 'ibm-mq-md-replyto', 'ibm-mq-md-priority'];
  for (const key of Object.keys(req.headers)) {
    if (key.startsWith('ibm-mq-md-') && !headers.includes(key)) fail(400, `Unsupported message header: ${key}`);
  }
  if (version !== 'v3' && (req.get('ibm-mq-usr') !== undefined || req.get('ibm-mq-md-priority') !== undefined)) fail(400, 'Priority and user properties require REST API v3');
  const correlationId = identifier(req.get('ibm-mq-md-correlationid'), version, true) || null;
  const persistence = req.get('ibm-mq-md-persistence') || 'nonPersistent';
  if (!['persistent', 'nonPersistent'].includes(persistence)) fail(400, 'Invalid message persistence');
  const expiry = req.get('ibm-mq-md-expiry') ?? 'unlimited';
  const expiryMs = expiry === 'unlimited' ? null : integer(expiry, 'Expiry milliseconds', 0, 99999999900);
  const priorityHeader = req.get('ibm-mq-md-priority') ?? 'asDestination';
  const priority = version === 'v3' ? priorityHeader === 'asDestination' ? defaultPriority : integer(priorityHeader, 'Priority', 0, 9) : 4;
  const replyTo = req.get('ibm-mq-md-replyto') || null;
  if (replyTo) {
    const parts = replyTo.split('@');
    if (parts.length > 2) fail(400, 'Invalid replyTo destination');
    for (const part of parts) name(part, 'Reply destination');
  }
  const userProperties = properties(req.get('ibm-mq-usr'));
  const jms = Boolean(userProperties || correlationId && !correlationId.startsWith('ID:'));
  return { body, messageId: crypto.randomBytes(24).toString('hex'), correlationId, persistence, priority, replyTo,
    properties: userProperties, format: jms ? 'MQHRF2' : 'MQSTR', putAt: state.now(), expiresAt: expiryMs === null ? null : state.now() + expiryMs };
}
function messageHeaders(res, message, version, now) {
  res.set('ibm-mq-md-messageId', externalId(`ID:${message.messageId}`, version));
  if (message.correlationId) res.set('ibm-mq-md-correlationId', externalId(message.correlationId, version));
  res.set('ibm-mq-md-persistence', message.persistence);
  res.set('ibm-mq-md-expiry', message.expiresAt === null ? 'unlimited' : String(Math.max(0, message.expiresAt - now)));
  if (message.replyTo) res.set('ibm-mq-md-replyTo', message.replyTo);
  if (version === 'v3') {
    res.set('ibm-mq-md-priority', String(message.priority));
    if (message.properties) res.set('ibm-mq-usr', message.properties);
  }
}
function addMessaging(register, state, auth, config) {
  function queueContext(req, operation) {
    auth.messaging(req, req.params.qmgrName, req.params.queueName, operation);
    const qmgr = state.qmgr(req.params.qmgrName);
    const requested = state.queue(qmgr, req.params.queueName);
    const queue = state.resolveQueue(qmgr, req.params.queueName);
    if (operation === 'put' && (requested.general.inhibitPut || queue.general.inhibitPut)) fail(405, 'Queue is PUT inhibited', { reasonCode: 2051 });
    return { qmgr, queue, inhibited: requested.general.inhibitGet || queue.general.inhibitGet };
  }
  register('/messaging/qmgr/:qmgrName/queue/:queueName/message', {
    post(req, res) {
      query(req, []);
      const { qmgr, queue } = queueContext(req, 'put');
      const message = createMessage(req, state, queue.applicationDefaults.messagePriority);
      if (Buffer.byteLength(message.body) > qmgr.parameters.maxmsgl) fail(400, 'Message exceeds queue manager MAXMSGL', { reasonCode: 2030 });
      state.deliver([{ qmgr, queue, message }]);
      res.set('ibm-mq-resolved-qmgr', qmgr.name).set('ibm-mq-md-messageId', externalId(`ID:${message.messageId}`, req.params.version));
      res.status(201).end();
    },
    get: receive,
    delete: receive
  });
  async function receive(req, res) {
    const consuming = req.method === 'DELETE';
    const values = query(req, consuming ? ['messageId', 'correlationId', 'wait'] : ['messageId', 'correlationId']);
    const messageId = identifier(values.messageId, req.params.version);
    const correlationId = identifier(values.correlationId, req.params.version, true);
    const wait = values.wait === undefined ? 0 : integer(values.wait, 'wait', 0, config.maxWaitMs);
    const deadline = performance.now() + wait;
    while (!res.destroyed) {
      state.cleanup();
      if (state.sessions.get(req.session.username)?.token !== req.session.token) fail(401, 'Session expired or was revoked while waiting');
      const { qmgr, queue, inhibited } = queueContext(req, consuming ? 'get' : 'browse');
      res.set('ibm-mq-resolved-qmgr', qmgr.name);
      if (inhibited) fail(405, 'Queue is GET inhibited', { reasonCode: 2016 });
      const messages = qmgr.messages.get(queue.name);
      const candidates = messages.map((message, index) => ({ message, index })).filter(({ message }) =>
        (!messageId || `ID:${message.messageId}` === messageId) && (!correlationId || message.correlationId === correlationId));
      if (queue.storage.messageDeliverySequence === 'priority') candidates.sort((a, b) => b.message.priority - a.message.priority);
      const next = candidates[0];
      if (next) {
        const { message, index } = next;
        if (message.format !== 'MQSTR' && !(message.format === 'MQHRF2' && (message.properties || message.correlationId && !message.correlationId.startsWith('ID:')))) fail(501, 'Message format is not supported by the text REST API');
        messageHeaders(res, message, req.params.version, state.now());
        if (consuming) {
          messages.splice(index, 1); state.metrics.gets++; qmgr.lastGet.set(queue.name, state.now());
        } else state.metrics.browses++;
        return res.type('text/plain; charset=utf-8').status(200).send(message.body);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return res.status(204).end();
      await state.waitForChange(res, Math.ceil(remaining));
    }
  }
  register('/messaging/qmgr/:qmgrName/queue/:queueName/messagelist', {
    get(req, res) {
      const values = query(req, ['messageId', 'correlationId', 'limit']);
      const messageId = identifier(values.messageId, req.params.version);
      const correlationId = identifier(values.correlationId, req.params.version, true);
      const limit = values.limit === undefined ? 10 : integer(values.limit, 'limit', 1, 2147483647);
      const { qmgr, queue, inhibited } = queueContext(req, 'browse');
      res.set('ibm-mq-resolved-qmgr', qmgr.name);
      const records = inhibited ? [] : qmgr.messages.get(queue.name).filter(message =>
        (!messageId || `ID:${message.messageId}` === messageId) && (!correlationId || message.correlationId === correlationId));
      const ordered = [...records];
      if (queue.storage.messageDeliverySequence === 'priority') ordered.sort((a, b) => b.priority - a.priority);
      res.json({ messages: ordered.slice(0, limit).map(message => ({
        messageId: externalId(`ID:${message.messageId}`, req.params.version), format: message.format,
        ...(message.correlationId ? { correlationId: externalId(message.correlationId, req.params.version) } : {})
      })) });
    }
  });
  register('/messaging/qmgr/:qmgrName/topic/*topicString/message', {
    post(req, res) {
      if (req.params.version === 'v1') fail(404, 'Topic publishing requires REST API v2 or v3');
      query(req, []);
      const topicString = req.params.topicString.join('/');
      auth.messaging(req, req.params.qmgrName, topicString, 'publish');
      const qmgr = state.qmgr(req.params.qmgrName);
      if (!topicString || topicString.length > 10240 || /[\x00-\x1f]/.test(topicString)) fail(400, 'Invalid topic string');
      const topic = [...qmgr.objects.topics.values()].find(record => record.topicstr === topicString);
      if (topic?.pub === 'DISABLED') fail(405, 'Topic publishing is inhibited');
      const message = createMessage(req, state, topic?.defprty ?? 0);
      if (Buffer.byteLength(message.body) > qmgr.parameters.maxmsgl) fail(400, 'Message exceeds queue manager MAXMSGL', { reasonCode: 2030 });
      const subscriptions = [...qmgr.objects.subscriptions.values()].filter(sub => sub.topicstr === topicString);
      const deliveries = subscriptions.map(sub => {
        if (sub.destqm && sub.destqm !== qmgr.name) fail(400, 'Mock topic delivery requires a local subscription destination');
        const queue = state.resolveQueue(qmgr, sub.dest);
        if (queue.general.inhibitPut) fail(405, 'Subscription destination is PUT inhibited');
        return { qmgr, queue, message };
      });
      state.deliver(deliveries);
      res.set('ibm-mq-resolved-qmgr', qmgr.name).set('ibm-mq-md-messageId', externalId(`ID:${message.messageId}`, req.params.version)).status(201).end();
    }
  });
}
module.exports = { addMessaging, identifier, externalId, properties, createMessage };
