/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const { fail, keys, object, name, merge, integer } = require('./protocol');
const QUEUE_TYPES = { local: 'QLOCAL', alias: 'QALIAS', model: 'QMODEL', remote: 'QREMOTE' };
const QUEUE_FIELDS = {
  general: { description: ['descr', 'string'], inhibitGet: ['get', 'inhibit'], inhibitPut: ['put', 'inhibit'], isTransmissionQueue: ['usage', 'transmission'] },
  storage: { maximumDepth: ['maxdepth', 'integer', 999999999], maximumMessageLength: ['maxmsgl', 'integer', 104857600], messageDeliverySequence: ['msgdlvsq', 'enum', { fifo: 'FIFO', priority: 'PRIORITY' }] },
  applicationDefaults: { messagePriority: ['defprty', 'integer', 9], messagePersistence: ['defpsist', 'enum', { persistent: 'YES', nonPersistent: 'NO' }] },
  extended: { allowSharedInput: ['share', 'boolean'], backoutThreshold: ['bothresh', 'integer', 999999999], backoutRequeueQueueName: ['boqname', 'string'] },
  alias: { targetName: ['target', 'string'], targetType: ['targtype', 'enum', { queue: 'QUEUE', topic: 'TOPIC' }] },
  remote: { queueName: ['rname', 'string'], qmgrName: ['rqmname', 'string'], transmissionQueueName: ['xmitq', 'string'] },
  model: { type: ['deftype', 'enum', { permanentDynamic: 'PERMDYN', temporaryDynamic: 'TEMPDYN' }] },
  cluster: { name: ['cluster', 'string'], namelist: ['clusnl', 'string'], workloadPriority: ['clwlprty', 'integer', 9], workloadRank: ['clwlrank', 'integer', 9] },
  trigger: { enabled: ['trigger', 'boolean'], type: ['trigtype', 'enum', { first: 'FIRST', every: 'EVERY', depth: 'DEPTH', none: 'NONE' }], depth: ['trigdpth', 'integer', 999999999], data: ['trigdata', 'string'], initiationQueueName: ['initq', 'string'], processName: ['process', 'string'] }
};
function validateQueue(update) {
  object(update);
  keys(update, ['name', 'type', ...Object.keys(QUEUE_FIELDS)], 'queue');
  if (update.name !== undefined) name(update.name);
  if (update.type !== undefined && !Object.hasOwn(QUEUE_TYPES, update.type)) fail(400, 'Unsupported queue type');
  for (const [group, fields] of Object.entries(QUEUE_FIELDS)) {
    if (update[group] === undefined) continue;
    object(update[group], group);
    keys(update[group], Object.keys(fields), group);
    for (const [field, value] of Object.entries(update[group])) {
      const [, type, range] = fields[field];
      if (type === 'integer') {
        if (typeof value !== 'number') fail(400, `${group}.${field} must be a number`);
        integer(value, `${group}.${field}`, 0, range);
      } else if (type === 'enum') {
        if (!Object.hasOwn(range, value)) fail(400, `Invalid ${group}.${field}`);
      } else if (type === 'string') {
        if (typeof value !== 'string' || value.length > (field === 'description' ? 64 : 256)) fail(400, `Invalid ${group}.${field}`);
      } else if (typeof value !== 'boolean') fail(400, `${group}.${field} must be boolean`);
    }
  }
  return update;
}
function createQueue(update, base = {}) {
  validateQueue(update);
  const type = update.type || base.type || 'local';
  const queue = merge({
    name: update.name, type,
    general: { description: '', inhibitGet: false, inhibitPut: false, isTransmissionQueue: false },
    storage: { maximumDepth: 5000, maximumMessageLength: 4194304, messageDeliverySequence: 'priority' },
    applicationDefaults: { messagePriority: 0, messagePersistence: 'nonPersistent' },
    extended: { allowSharedInput: true, backoutThreshold: 0, backoutRequeueQueueName: '' },
    cluster: { name: '', namelist: '', workloadPriority: 0, workloadRank: 0 },
    trigger: { enabled: false, type: 'first', depth: 1, data: '', initiationQueueName: '', processName: '' }
  }, base);
  if (type === 'alias') queue.alias = { targetName: '', targetType: 'queue', ...queue.alias };
  if (type === 'remote') queue.remote = { queueName: '', qmgrName: '', transmissionQueueName: '', ...queue.remote };
  if (type === 'model') queue.model = { type: 'temporaryDynamic', ...queue.model };
  merge(queue, update);
  for (const group of ['alias', 'remote', 'model']) {
    if (queue[group] !== undefined && group !== queue.type) fail(400, `${group} attributes require a ${group} queue`);
  }
  return queue;
}
function queueParameters(queue, depth = 0) {
  const result = { queue: queue.name, type: QUEUE_TYPES[queue.type] };
  for (const [group, fields] of Object.entries(QUEUE_FIELDS)) {
    for (const [field, [parameter, type, options]] of Object.entries(fields)) {
      const value = queue[group]?.[field];
      if (value === undefined) continue;
      result[parameter] = type === 'boolean' ? (value ? 'YES' : 'NO') :
        type === 'inhibit' ? (value ? 'DISABLED' : 'ENABLED') :
        type === 'transmission' ? (value ? 'XMITQ' : 'NORMAL') :
        type === 'enum' ? options[value] : value;
    }
  }
  if (queue.type === 'local') result.curdepth = depth;
  return result;
}
function queueFromParameters(parameters, queueName, type, base) {
  const update = { name: queueName, type };
  const supported = ['like', 'replace'];
  for (const [group, fields] of Object.entries(QUEUE_FIELDS)) {
    for (const [field, [parameter, fieldType, options]] of Object.entries(fields)) {
      supported.push(parameter);
      if (parameters[parameter] === undefined) continue;
      let value = parameters[parameter];
      if (fieldType === 'enum') value = Object.keys(options).find(key => options[key] === String(value).toUpperCase());
      if (['boolean', 'inhibit', 'transmission'].includes(fieldType)) {
        const choices = fieldType === 'boolean' ? ['NO', 'YES'] : fieldType === 'inhibit' ? ['ENABLED', 'DISABLED'] : ['NORMAL', 'XMITQ'];
        const index = choices.indexOf(String(value).toUpperCase());
        if (index < 0) fail(400, `Invalid MQSC ${parameter}`);
        value = index === 1;
      }
      update[group] = { ...update[group], [field]: value };
    }
  }
  keys(parameters, supported, 'MQSC queue');
  return createQueue(update, base);
}
const OBJECT_TYPES = {
  channel: { collection: 'channels', identity: 'channel', defaults: { chltype: 'SVRCONN', trptype: 'TCP', descr: '', conname: '', xmitq: '', status: 'INACTIVE' } },
  listener: { collection: 'listeners', identity: 'listener', defaults: { trptype: 'TCP', port: 1414, control: 'QMGR', status: 'STOPPED' } },
  topic: { collection: 'topics', identity: 'topic', defaults: { topicstr: '', descr: '', pub: 'ENABLED', sub: 'ENABLED', defprty: 0 } },
  sub: { collection: 'subscriptions', identity: 'sub', defaults: { topicstr: '', dest: '', destqm: '', durable: 'YES' } },
  process: { collection: 'processes', identity: 'process', defaults: { appltype: 'UNIX', applicid: '', descr: '' } },
  namelist: { collection: 'namelists', identity: 'namelist', defaults: { names: [], descr: '' } },
  authinfo: { collection: 'authinfos', identity: 'authinfo', defaults: { authtype: 'IDPWOS', chckclnt: 'REQDADM', chcklocl: 'OPTIONAL' } },
  service: { collection: 'services', identity: 'service', defaults: { servtype: 'SERVER', control: 'MANUAL', startcmd: '', status: 'STOPPED' } }
};
function createResource(type, resourceName, parameters = {}) {
  const spec = OBJECT_TYPES[type];
  if (!spec) fail(400, 'Unsupported MQSC object type');
  name(resourceName, 'Object name', type === 'channel' ? 20 : 48);
  object(parameters, 'MQSC parameters');
  const record = merge({ ...spec.defaults }, parameters);
  // Extra scalar/list MQSC attributes are fixture data; no command execution occurs.
  for (const [key, value] of Object.entries(record)) {
    if (!/^[a-z][a-z0-9]*$/.test(key) || !['string', 'number'].includes(typeof value) &&
        !(Array.isArray(value) && value.every(item => typeof item === 'string'))) fail(400, 'MQSC attributes must be scalar values or string lists');
  }
  for (const key of ['chltype', 'trptype', 'control', 'pub', 'sub', 'durable', 'servtype', 'authtype', 'chckclnt', 'chcklocl', 'appltype', 'status']) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== 'string') fail(400, `MQSC ${key} must be a string`);
      record[key] = record[key].toUpperCase();
    }
  }
  if (type === 'channel' && !['SDR', 'RCVR', 'SVR', 'RQSTR', 'CLUSSDR', 'CLUSRCVR', 'SVRCONN', 'CLNTCONN'].includes(String(record.chltype).toUpperCase())) fail(400, 'Invalid channel type');
  if (type === 'listener') integer(record.port, 'Listener port', 1, 65535);
  record[spec.identity] = resourceName;
  return record;
}
module.exports = { QUEUE_TYPES, QUEUE_FIELDS, OBJECT_TYPES, createQueue, validateQueue, queueParameters, queueFromParameters, createResource };
