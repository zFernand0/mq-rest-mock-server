/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const crypto = require('node:crypto');
const { fail, query, project, wildcard, integer, jsonBody, keys, name } = require('./protocol');
const { createQueue } = require('./resources');
const { parseRequest, runMqsc } = require('./mqsc');
const LIST_QUERY = ['attributes', 'status', 'name', 'type', 'filter', 'mockOffset', 'mockLimit', 'mockOrderBy'];
function v1(req) {
  if (req.params.version !== 'v1') fail(404, 'This resource is available only in REST API v1; use the MQSC action endpoint');
}
function filterRecords(records, expression) {
  if (expression === undefined) return records;
  const match = /^([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*):(lessThan|greaterThan|equalTo|notEqualTo|lessThanOrEqualTo|greaterThanOrEqualTo):(.*)$/.exec(expression);
  if (!match) fail(400, 'filter must be attribute:operator:value');
  const [, field, op, expected] = match;
  if (['name', 'type', 'id'].includes(field)) fail(400, 'Filter by name with the name query parameter');
  const values = records.map(record => {
    let actual = record;
    for (const key of field.split('.')) {
      if (!actual || !Object.hasOwn(actual, key)) return undefined;
      actual = actual[key];
    }
    return actual;
  });
  if (records.length && values.every(value => value === undefined)) fail(400, 'Unknown filter attribute');
  return records.filter((record, index) => {
    const actual = values[index];
    if (actual === undefined) return false;
    let value = expected;
    if (typeof actual === 'number') {
      if (!/^-?\d+$/.test(value)) fail(400, 'Numeric filter requires an integer');
      value = Number(value);
    } else if (typeof actual === 'boolean') {
      if (!['true', 'false', ''].includes(value)) fail(400, 'Boolean filter requires true or false');
      value = value === 'true';
    } else if (typeof actual !== 'string') fail(400, 'Cannot filter an object attribute');
    const equals = typeof actual === 'string' && value.endsWith('*') ? wildcard(value, actual) : actual === value;
    if (op === 'equalTo') return equals;
    if (op === 'notEqualTo') return !equals;
    if (typeof actual !== 'number') fail(400, 'Ordering filters require integer attributes');
    return { lessThan: actual < value, greaterThan: actual > value, lessThanOrEqualTo: actual <= value, greaterThanOrEqualTo: actual >= value }[op];
  });
}
function page(records, values, res) {
  if (values.mockOrderBy !== undefined) {
    const match = /^([A-Za-z][A-Za-z0-9.]*)\/(A|D)$/.exec(values.mockOrderBy);
    if (!match) fail(400, 'mockOrderBy must be attribute/A or attribute/D');
    const get = record => {
      let value = record;
      for (const key of match[1].split('.')) {
        if (!value || !Object.hasOwn(value, key)) fail(400, 'Unknown sort attribute');
        value = value[key];
      }
      if (!['string', 'number', 'boolean'].includes(typeof value)) fail(400, 'Sort requires a scalar attribute');
      return value;
    };
    for (const record of records) get(record);
    records.sort((a, b) => {
      const first = get(a), second = get(b);
      const result = first < second ? -1 : first > second ? 1 : 0;
      return match[2] === 'D' ? -result : result;
    });
  }
  const offset = values.mockOffset === undefined ? 0 : integer(values.mockOffset, 'mockOffset', 0, 2147483647);
  const limit = values.mockLimit === undefined ? records.length : integer(values.mockLimit, 'mockLimit', 1, 2147483647);
  if (values.mockOffset !== undefined || values.mockLimit !== undefined) res.set('X-Mock-Total-Count', String(records.length));
  return records.slice(offset, offset + limit);
}
function selectedStatus(record, attributes, status, defaults, statusKey = 'status') {
  const configuration = { ...record };
  delete configuration[statusKey];
  const result = project(configuration, attributes, defaults);
  if (status !== undefined && record[statusKey] !== undefined) {
    const selection = status === '*' ? statusKey : status;
    const statusResult = project(record, selection, defaults);
    result[statusKey] = statusResult[statusKey];
  }
  return result;
}
function addAdminApi(register, state, auth) {
  register('/admin/installation{/:installationName}', {
    get(req, res) {
      const values = query(req, ['attributes']);
      if (req.params.installationName && req.params.installationName !== state.installation.name) fail(404, 'Installation does not exist');
      res.json({ installation: [project(state.installation, values.attributes === 'extended' ? 'extended' : values.attributes, ['name', 'version', 'platform'])] });
    }
  });
  register('/admin/qmgr{/:qmgrName}', {
    get(req, res) {
      auth.administration(req);
      const values = query(req, ['attributes', 'status', 'state', 'mockOffset', 'mockLimit', 'mockOrderBy']);
      if (values.state !== undefined && (req.params.qmgrName || !['running', 'ended', 'endedImmediately', 'endedUnexpectedly', 'starting', 'quiescing', 'runningAsStandby'].includes(values.state))) fail(400, 'Invalid queue manager state filter');
      let records = req.params.qmgrName ? [state.qmgr(req.params.qmgrName, false)] : [...state.queueManagers.values()];
      if (values.state !== undefined) records = records.filter(record => record.state === values.state);
      records = records.map(record => {
        const data = { name: record.name, state: record.state, extended: record.extended };
        if (record.state === 'running') data.status = record.status;
        return selectedStatus(data, values.attributes, values.status, ['name', 'state']);
      });
      res.json({ qmgr: page(records, values, res) });
    }
  });
  register('/admin/action/qmgr/:qmgrName/mqsc', {
    post(req, res) {
      query(req, []);
      const request = parseRequest(jsonBody(req));
      auth.administration(req, !['display', 'ping'].includes(request.command));
      const qmgr = state.qmgr(req.params.qmgrName);
      res.json(runMqsc(state, qmgr, request));
    }
  });
  register('/admin/qmgr/:qmgrName/queue', {
    get: getQueues,
    post(req, res) {
      v1(req); auth.administration(req, true);
      const values = query(req, ['like', 'noReplace']);
      const qmgr = state.qmgr(req.params.qmgrName);
      const update = jsonBody(req);
      name(update.name);
      const defaultName = `SYSTEM.DEFAULT.${(update.type || 'local').toUpperCase()}.QUEUE`;
      const base = values.like === undefined ? qmgr.objects.queues.get(defaultName) : state.queue(qmgr, values.like);
      state.putQueue(qmgr, createQueue(update, base), { replace: values.noReplace === undefined });
      res.location(`${req.baseUrl}/admin/qmgr/${encodeURIComponent(qmgr.name)}/queue/${encodeURIComponent(update.name)}`).status(201).end();
    }
  });
  register('/admin/qmgr/:qmgrName/queue/:queueName', {
    get: getQueues,
    patch(req, res) {
      v1(req); auth.administration(req, true); query(req, []);
      const qmgr = state.qmgr(req.params.qmgrName);
      const queue = state.queue(qmgr, req.params.queueName);
      const update = jsonBody(req);
      if (update.name !== undefined) fail(400, 'PATCH cannot change a queue name');
      state.putQueue(qmgr, createQueue({ ...update, name: queue.name }, queue));
      res.status(204).end();
    },
    delete(req, res) {
      v1(req); auth.administration(req, true);
      const values = query(req, ['purge']);
      const qmgr = state.qmgr(req.params.qmgrName);
      const queue = state.queue(qmgr, req.params.queueName);
      if (qmgr.messages.get(queue.name).length && values.purge === undefined) fail(400, 'Queue is not empty', { reasonCode: 2055 });
      qmgr.objects.queues.delete(queue.name);
      qmgr.messages.delete(queue.name); qmgr.lastGet.delete(queue.name); qmgr.lastPut.delete(queue.name);
      state.events.emit('change');
      res.status(204).end();
    }
  });
  function getQueues(req, res) {
    v1(req); auth.administration(req);
    const values = query(req, LIST_QUERY);
    if (values.name !== undefined && (req.params.queueName || !values.name.includes('*'))) fail(400, 'name requires a wildcard and a collection URL');
    if (values.filter !== undefined && req.params.queueName) fail(400, 'filter requires a collection URL');
    if (values.type !== undefined && !['all', 'local', 'alias', 'remote', 'model'].includes(values.type)) fail(400, 'Invalid queue type filter');
    if (values.status !== undefined && values.type !== undefined && !['all', 'local'].includes(values.type)) fail(400, 'Status requires local queues');
    const qmgr = state.qmgr(req.params.qmgrName);
    let records = req.params.queueName ? [state.queue(qmgr, req.params.queueName)] : [...qmgr.objects.queues.values()];
    if (values.name !== undefined) records = records.filter(queue => wildcard(values.name, queue.name));
    if (values.type && values.type !== 'all') records = records.filter(queue => queue.type === values.type);
    records = records.map(queue => ({ ...queue, ...(queue.type === 'local' ? { status: state.queueStatus(qmgr, queue) } : {}) }));
    if (values.filter?.startsWith('status.') && values.status === undefined) fail(400, 'A status filter requires status');
    records = filterRecords(records, values.filter).map(queue => {
      const defaults = ['name', 'type'];
      if (['remote', 'alias', 'model'].includes(queue.type)) defaults.push(queue.type);
      return selectedStatus(queue, values.attributes, values.status, defaults);
    });
    res.json({ queue: page(records, values, res) });
  }
  register('/admin/qmgr/:qmgrName/channel{/:channelName}', {
    get(req, res) {
      v1(req); auth.administration(req);
      const values = query(req, ['attributes', 'name', 'type', 'mockOffset', 'mockLimit', 'mockOrderBy']);
      if (values.name !== undefined && (req.params.channelName || !values.name.includes('*'))) fail(400, 'name requires a wildcard and a collection URL');
      const types = { SDR: 'sender', RCVR: 'receiver', SVR: 'server', RQSTR: 'requester', CLUSSDR: 'clusterSender', CLUSRCVR: 'clusterReceiver' };
      if (values.type !== undefined && !['all', ...Object.values(types)].includes(values.type)) fail(400, 'Invalid channel type filter');
      const qmgr = state.qmgr(req.params.qmgrName);
      let records = [...qmgr.objects.channels.values()].filter(channel => types[channel.chltype] && channel.trptype === 'TCP');
      if (req.params.channelName) {
        records = records.filter(channel => channel.channel === req.params.channelName);
        if (!records.length) fail(404, 'Channel does not exist or is not supported by REST v1');
      }
      if (values.name !== undefined) records = records.filter(channel => wildcard(values.name, channel.channel));
      if (values.type && values.type !== 'all') records = records.filter(channel => types[channel.chltype] === values.type);
      records = records.map(channel => {
        const type = types[channel.chltype];
        const data = { name: channel.channel, type, general: { description: channel.descr } };
        const defaults = ['name', 'type'];
        if (type !== 'receiver') {
          data[type] = {};
          if (['sender', 'server'].includes(type)) data[type].transmissionQueueName = channel.xmitq;
          if (type !== 'server') {
            const match = /^(.*)\((\d+)\)$/.exec(channel.conname);
            data[type].connection = channel.conname ? [{ host: match ? match[1] : channel.conname, port: match ? Number(match[2]) : 1414 }] : [];
          }
          if (type.startsWith('cluster')) data[type].clusterName = channel.cluster || '';
          defaults.push(type);
        }
        return project(data, values.attributes, defaults);
      });
      res.json({ channel: page(records, values, res) });
    }
  });
  register('/admin/qmgr/:qmgrName/subscription{/:subscriptionName}', {
    get(req, res) {
      v1(req); auth.administration(req);
      const values = query(req, ['attributes', 'name', 'id', 'filter', 'mockOffset', 'mockLimit', 'mockOrderBy']);
      if (values.name !== undefined && (req.params.subscriptionName || values.id !== undefined || values.name && !values.name.includes('*'))) fail(400, 'Invalid subscription name filter');
      if (values.id !== undefined && (req.params.subscriptionName || !/^[a-f\d]{48}$/i.test(values.id))) fail(400, 'Invalid subscription id');
      if (values.filter !== undefined && (req.params.subscriptionName || values.id !== undefined)) fail(400, 'filter requires a collection URL');
      const qmgr = state.qmgr(req.params.qmgrName);
      let records = [...qmgr.objects.subscriptions.values()].map(sub => ({
        id: crypto.createHash('sha256').update(JSON.stringify([qmgr.name, sub.sub])).digest('hex').slice(0, 48),
        name: sub.sub, resolvedTopicString: sub.topicstr,
        topic: { name: '', definedString: sub.topicstr }, destination: { name: sub.dest, qmgrName: sub.destqm }, general: { isDurable: sub.durable === 'YES' }
      }));
      if (req.params.subscriptionName) {
        records = records.filter(record => record.name === req.params.subscriptionName);
        if (!records.length) fail(404, 'Subscription does not exist');
      }
      if (values.name !== undefined) records = records.filter(record => wildcard(values.name, record.name));
      if (values.id !== undefined) records = records.filter(record => record.id.toLowerCase() === values.id.toLowerCase());
      records = filterRecords(records, values.filter).map(record => project(record, values.attributes, ['id', 'name', 'resolvedTopicString']));
      res.json({ subscription: page(records, values, res) });
    }
  });
}
module.exports = { addAdminApi, filterRecords, page };
