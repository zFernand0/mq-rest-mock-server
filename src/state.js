/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { fail, object, keys, name, merge } = require('./protocol');
const { createQueue, createResource, OBJECT_TYPES } = require('./resources');
const { properties, identifier } = require('./messaging');
const DEFAULT_FIXTURES = {
  queueManagers: [
    {
      name: 'QM1', state: 'running',
      queues: [
        { name: 'DEV.QUEUE.1' }, { name: 'DEV.QUEUE.2' }, { name: 'DEV.QUEUE.3' },
        { name: 'SYSTEM.DEFAULT.LOCAL.QUEUE' },
        { name: 'DEV.ALIAS.1', type: 'alias', alias: { targetName: 'DEV.QUEUE.1' } },
        { name: 'DEV.REMOTE.1', type: 'remote', remote: { queueName: 'DEV.QUEUE.1', qmgrName: 'QM2', transmissionQueueName: 'DEV.XMITQ' } },
        { name: 'DEV.MODEL.1', type: 'model' }
      ],
      channels: [ { channel: 'DEV.APP.SVRCONN', chltype: 'SVRCONN' }, { channel: 'QM1.TO.QM2', chltype: 'SDR', conname: 'localhost(1415)', xmitq: 'DEV.XMITQ' } ],
      listeners: [{ listener: 'DEV.LISTENER.TCP', port: 1414 }],
      topics: [{ topic: 'DEV.TOPIC', topicstr: 'dev/events' }],
      subscriptions: [{ sub: 'DEV.SUB', topicstr: 'dev/events', dest: 'DEV.QUEUE.2' }],
      processes: [{ process: 'DEV.PROCESS' }], namelists: [{ namelist: 'DEV.NAMELIST', names: ['DEV.QUEUE.1'] }],
      authinfos: [{ authinfo: 'SYSTEM.DEFAULT.AUTHINFO.IDPWOS' }], services: [{ service: 'DEV.SERVICE' }]
    }, { name: 'QM2', state: 'ended' }
  ]
};
const INSTALLATION = {
  name: 'Installation1', version: '9.4.0.0', platform: 'unix',
  extended: { level: 'mock-9.4.0', operatingSystem: 'Linux (mock)', description: 'IBM MQ REST mock', installationPath: '/opt/mqm', dataPath: '/var/mqm', maximumCommandLevel: 940, primary: true }
};
function createState(config, { now = Date.now, fixtures = DEFAULT_FIXTURES } = {}) {
  const source = structuredClone(fixtures);
  const state = {
    now, queueManagers: new Map(), sessions: new Map(), otps: new Map(), scenarios: [], audit: [],
    events: new EventEmitter(), waiters: 0, metrics: { requests: 0, responses: {}, puts: 0, gets: 0, browses: 0 },
    installation: structuredClone(INSTALLATION)
  };
  state.events.setMaxListeners(config.maxWaiters + 1);
  state.counts = () => {
    let objects = 0, messages = 0, messageBytes = 0;
    for (const qmgr of state.queueManagers.values()) {
      for (const collection of Object.values(qmgr.objects)) objects += collection.size;
      for (const queue of qmgr.messages.values()) {
        messages += queue.length;
        messageBytes += queue.reduce((sum, message) => sum + Buffer.byteLength(message.body), 0);
      }
    }
    return { queueManagers: state.queueManagers.size, objects, messages, messageBytes, sessions: state.sessions.size, otps: state.otps.size, waiters: state.waiters };
  };
  state.cleanup = () => {
    const current = now();
    for (const [user, session] of state.sessions) if (session.expiresAt <= current) state.sessions.delete(user);
    for (const [user, otp] of state.otps) if (otp.expiresAt <= current) state.otps.delete(user);
    for (const qmgr of state.queueManagers.values()) {
      for (const [queue, messages] of qmgr.messages) qmgr.messages.set(queue, messages.filter(message => message.expiresAt === null || message.expiresAt > current));
    }
  };
  state.qmgr = (qmgrName, running = true) => {
    const qmgr = state.queueManagers.get(qmgrName);
    if (!qmgr) fail(404, `Queue manager '${qmgrName}' does not exist`, { messageId: 'MQWB0009E', reasonCode: 2058 });
    if (running && qmgr.state !== 'running') fail(503, `Queue manager '${qmgrName}' is not running`, { reasonCode: 2059 });
    return qmgr;
  };
  state.queue = (qmgr, queueName) => {
    const queue = qmgr.objects.queues.get(queueName);
    if (!queue) fail(404, `Queue '${queueName}' does not exist`, { messageId: 'MQWB0037E', reasonCode: 2085 });
    return queue;
  };
  state.resolveQueue = (qmgr, queueName) => {
    const visited = new Set();
    let queue = state.queue(qmgr, queueName);
    while (queue.type === 'alias') {
      if (visited.has(queue.name) || queue.alias.targetType !== 'queue') fail(400, 'Alias cannot resolve to a local queue');
      visited.add(queue.name);
      queue = state.queue(qmgr, queue.alias.targetName);
    }
    if (queue.type !== 'local') fail(400, 'Mock messaging supports local queues and queue aliases');
    return queue;
  };
  state.putQueue = (qmgr, queue, { replace = true } = {}) => {
    const previous = qmgr.objects.queues.get(queue.name);
    if (previous && !replace) fail(400, 'Queue already exists', { reasonCode: 4001 });
    if (previous && previous.type !== queue.type) fail(400, 'An existing queue type cannot change');
    if (!previous && state.counts().objects >= config.maxObjects) fail(503, 'Mock object limit reached');
    qmgr.objects.queues.set(queue.name, queue);
    if (!qmgr.messages.has(queue.name)) qmgr.messages.set(queue.name, []);
    state.events.emit('change');
  };
  state.putResource = (qmgr, type, resource, replace = false) => {
    const spec = OBJECT_TYPES[type];
    const collection = qmgr.objects[spec.collection];
    const resourceName = resource[spec.identity];
    if (collection.has(resourceName) && !replace) fail(400, 'Object already exists', { reasonCode: 4001 });
    if (!collection.has(resourceName) && state.counts().objects >= config.maxObjects) fail(503, 'Mock object limit reached');
    collection.set(resourceName, resource);
  };
  state.ensureCapacity = (deliveries) => {
    const counts = state.counts();
    if (counts.messages + deliveries.length > config.maxMessages ||
        counts.messageBytes + deliveries.reduce((sum, item) => sum + Buffer.byteLength(item.message.body), 0) > config.maxMessageBytes) fail(503, 'Mock message storage limit reached');
    const depths = new Map();
    for (const { qmgr, queue, message } of deliveries) {
      const key = JSON.stringify([qmgr.name, queue.name]);
      const depth = (depths.get(key) ?? qmgr.messages.get(queue.name).length) + 1;
      depths.set(key, depth);
      if (depth > queue.storage.maximumDepth) fail(500, 'Queue is full', { reasonCode: 2053 });
      if (Buffer.byteLength(message.body) > queue.storage.maximumMessageLength) fail(400, 'Message exceeds queue maximumMessageLength', { reasonCode: 2030 });
    }
  };
  state.deliver = deliveries => {
    state.ensureCapacity(deliveries);
    for (const { qmgr, queue, message } of deliveries) {
      qmgr.messages.get(queue.name).push(structuredClone(message));
      qmgr.lastPut.set(queue.name, now());
      state.metrics.puts++;
    }
    state.events.emit('change');
  };
  state.queueStatus = (qmgr, queue) => {
    const messages = qmgr.messages.get(queue.name);
    const status = { currentDepth: messages.length, openInputCount: 0, openOutputCount: 0, uncommittedMessages: 0,
      oldestMessageAge: messages.length ? Math.max(0, Math.floor((now() - Math.min(...messages.map(item => item.putAt))) / 1000)) : 0 };
    if (qmgr.lastPut.has(queue.name)) status.lastPut = new Date(qmgr.lastPut.get(queue.name)).toISOString();
    if (qmgr.lastGet.has(queue.name)) status.lastGet = new Date(qmgr.lastGet.get(queue.name)).toISOString();
    return status;
  };
  state.waitForChange = (res, milliseconds) => {
    if (state.waiters >= config.maxWaiters) fail(503, 'Mock waiting consumer limit reached');
    state.waiters++;
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        state.events.removeListener('change', finish);
        res.removeListener('close', finish);
        state.waiters--;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      state.events.once('change', finish);
      res.once('close', finish);
    });
  };
  state.reset = () => {
    object(source, 'Fixtures');
    keys(source, ['installation', 'queueManagers'], 'fixtures');
    if (!Array.isArray(source.queueManagers) || source.queueManagers.length > config.maxQueueManagers) throw new TypeError('Fixture queueManagers must be an array within MAX_QUEUE_MANAGERS');
    state.queueManagers.clear();
    state.installation = merge(structuredClone(INSTALLATION), source.installation || {});
    for (const fixture of source.queueManagers) {
      object(fixture, 'Queue manager fixture');
      const collections = Object.values(OBJECT_TYPES).map(spec => spec.collection);
      keys(fixture, ['name', 'state', 'extended', 'status', 'parameters', 'queues', 'messages', ...collections], 'queue manager fixture');
      name(fixture.name);
      if (state.queueManagers.has(fixture.name)) throw new TypeError('Duplicate fixture queue manager');
      if (fixture.state !== undefined && !['running', 'ended', 'endedImmediately', 'endedUnexpectedly', 'starting', 'quiescing', 'runningAsStandby'].includes(fixture.state)) throw new TypeError('Invalid queue manager state');
      const qmgr = {
        name: fixture.name, state: fixture.state || 'running',
        extended: merge({ installationName: state.installation.name, isDefaultQmgr: false, permitStandby: 'notApplicable' }, fixture.extended || {}),
        status: merge({ started: new Date(now()).toISOString(), channelInitiatorState: 'running', ldapConnectionState: 'disconnected', connectionCount: 0, publishSubscribeState: 'running' }, fixture.status || {}),
        parameters: merge({ qmgr: fixture.name, descr: 'Mock queue manager', deadq: '', cmdlevel: 940, platform: 'UNIX', maxmsgl: 4194304 }, fixture.parameters || {}),
        objects: { queues: new Map() }, messages: new Map(), lastPut: new Map(), lastGet: new Map()
      };
      if (!Number.isInteger(qmgr.parameters.maxmsgl) || qmgr.parameters.maxmsgl < 0 || qmgr.parameters.maxmsgl > 104857600) throw new TypeError('Invalid queue manager MAXMSGL');
      for (const collection of collections) qmgr.objects[collection] = new Map();
      state.queueManagers.set(qmgr.name, qmgr);
      for (const queue of fixture.queues || []) {
        if (qmgr.objects.queues.has(queue.name)) throw new TypeError('Duplicate fixture queue');
        name(queue.name);
        state.putQueue(qmgr, createQueue(queue));
      }
      for (const [type, spec] of Object.entries(OBJECT_TYPES)) {
        for (const attributes of fixture[spec.collection] || []) state.putResource(qmgr, type, createResource(type, attributes[spec.identity], attributes));
      }
      for (const [queueName, records] of Object.entries(fixture.messages || {})) {
        const queue = state.resolveQueue(qmgr, queueName);
        if (!Array.isArray(records)) throw new TypeError('Fixture messages must be arrays');
        for (const record of records) {
          object(record, 'Message fixture');
          keys(record, ['body', 'messageId', 'correlationId', 'priority', 'persistence', 'expiryMs', 'format', 'replyTo', 'properties'], 'message fixture');
          if (typeof record.body !== 'string') throw new TypeError('Fixture message body must be text');
          const correlationId = record.correlationId === undefined ? null : identifier(/^[a-f\d]{48}$/i.test(record.correlationId) ? `ID:${record.correlationId}` : record.correlationId, 'v3', true);
          const userProperties = properties(record.properties);
          if (record.replyTo !== undefined) {
            if (typeof record.replyTo !== 'string' || record.replyTo.split('@').length > 2) throw new TypeError('Invalid fixture replyTo');
            for (const part of record.replyTo.split('@')) name(part, 'Reply destination');
          }
          const message = { body: record.body, messageId: record.messageId || crypto.randomBytes(24).toString('hex'), correlationId,
            priority: record.priority ?? 4, persistence: record.persistence || 'nonPersistent', format: record.format || 'MQSTR',
            replyTo: record.replyTo || null, properties: userProperties, putAt: now(), expiresAt: record.expiryMs === undefined ? null : now() + record.expiryMs };
          if (!/^[a-f\d]{48}$/i.test(message.messageId) || !Number.isInteger(message.priority) || message.priority < 0 || message.priority > 9 ||
              !['persistent', 'nonPersistent'].includes(message.persistence) ||
              (record.expiryMs !== undefined && (!Number.isSafeInteger(record.expiryMs) || record.expiryMs < 0))) throw new TypeError('Invalid message fixture metadata');
          message.messageId = message.messageId.toLowerCase();
          state.deliver([{ qmgr, queue, message }]);
        }
      }
    }
    state.events.emit('change');
  };
  state.reset();
  return state;
}
module.exports = { createState, DEFAULT_FIXTURES };
