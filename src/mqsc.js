/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const { MqError, fail, object, keys, wildcard, name: validateName } = require('./protocol');
const { OBJECT_TYPES, QUEUE_TYPES, queueParameters, queueFromParameters, createResource } = require('./resources');
const VERBS = { dis: 'display', def: 'define', alt: 'alter', del: 'delete' };
const QUEUES = { queue: null, qlocal: 'local', qalias: 'alias', qremote: 'remote', qmodel: 'model', qstatus: 'local' };
const STATUSES = { chstatus: 'channel', lsstatus: 'listener', svstatus: 'service' };
function tokens(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 16384) fail(400, 'A single MQSC command is required');
  const result = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    const keyword = /^[A-Za-z][A-Za-z0-9_]*/.exec(text.slice(index));
    if (!keyword) fail(400, 'Invalid MQSC syntax');
    const key = keyword[0].toLowerCase();
    index += keyword[0].length;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    let value;
    if (text[index] === '(') {
      index++;
      let depth = 1, quoted = false, buffer = '';
      while (index < text.length && depth > 0) {
        const char = text[index++];
        if (char === "'") {
          if (quoted && text[index] === "'") { buffer += "''"; index++; continue; }
          quoted = !quoted;
        }
        if (!quoted && char === '(') depth++;
        if (!quoted && char === ')') depth--;
        if (depth) buffer += char;
      }
      if (depth || quoted) fail(400, 'Unterminated MQSC value');
      value = buffer.trim();
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
      else if (/^-?\d+$/.test(value)) value = Number(value);
      else value = value.toUpperCase();
    }
    result.push({ key, value });
  }
  return result;
}
function parseRequest(body) {
  object(body);
  if (body.type === 'runCommand') {
    keys(body, ['type', 'parameters']);
    object(body.parameters, 'Parameters');
    keys(body.parameters, ['command']);
    const list = tokens(body.parameters.command);
    if (list.length < 2 || list[0].value !== undefined) fail(400, 'MQSC requires a verb and qualifier');
    const parameters = {};
    const responseParameters = [];
    const displaying = ['display', 'dis'].includes(list[0].key);
    for (const token of list.slice(2)) {
      if (!displaying && token.value === undefined && ['replace', 'noreplace', 'purge', 'nopurge', 'share', 'noshare', 'trigger', 'notrigger'].includes(token.key)) parameters[token.key] = 'YES';
      else if (token.value === undefined) responseParameters.push(token.key);
      else {
        if (Object.hasOwn(parameters, token.key)) fail(400, 'Duplicate MQSC parameter');
        parameters[token.key] = token.value;
      }
    }
    if (parameters.names !== undefined) parameters.names = String(parameters.names).split(',').map(value => value.trim());
    return normalize({ command: list[0].key, qualifier: list[1].key, name: list[1].value === undefined ? undefined : String(list[1].value), parameters, responseParameters, plain: true });
  }
  if (body.type !== 'runCommandJSON') fail(400, 'type must be runCommand or runCommandJSON');
  keys(body, ['type', 'command', 'qualifier', 'name', 'parameters', 'responseParameters']);
  return normalize({ ...body, plain: false });
}
function normalize(request) {
  if (typeof request.command !== 'string' || typeof request.qualifier !== 'string') fail(400, 'command and qualifier must be strings');
  const command = VERBS[request.command.toLowerCase()] || request.command.toLowerCase();
  if (!['display', 'define', 'alter', 'delete', 'clear', 'start', 'stop', 'ping'].includes(command)) fail(400, 'Unsupported MQSC command');
  if (request.name !== undefined && typeof request.name !== 'string') fail(400, 'MQSC name must be a string');
  const parameters = {};
  for (const [key, value] of Object.entries(object(request.parameters === undefined ? {} : request.parameters, 'Parameters'))) {
    const normalized = key.toLowerCase();
    if (Object.hasOwn(parameters, normalized) || !/^[a-z][a-z0-9]*$/.test(normalized)) fail(400, 'Invalid or duplicate MQSC parameter');
    parameters[normalized] = value;
  }
  const responseParameters = request.responseParameters === undefined ? [] : request.responseParameters;
  for (const [positive, negative] of [['replace', 'noreplace'], ['purge', 'nopurge'], ['share', 'noshare'], ['trigger', 'notrigger']]) {
    if (parameters[positive] !== undefined && parameters[negative] !== undefined) fail(400, 'Conflicting MQSC flag parameters');
    for (const flag of [positive, negative]) {
      if (parameters[flag] !== undefined && String(parameters[flag]).toUpperCase() !== 'YES') fail(400, `MQSC ${flag} must be YES; use its opposite flag to disable it`);
    }
    if (parameters[negative] !== undefined) { parameters[positive] = 'NO'; delete parameters[negative]; }
  }
  if (!Array.isArray(responseParameters) || responseParameters.some(field => typeof field !== 'string' || !/^[a-z][a-z0-9]*$/i.test(field))) fail(400, 'responseParameters must contain MQSC attribute names');
  if (command !== 'display' && responseParameters.length) fail(400, 'responseParameters is valid only for DISPLAY');
  return { command, qualifier: request.qualifier.toLowerCase(), name: request.name, parameters, responseParameters: responseParameters.map(field => field.toLowerCase()), plain: request.plain };
}
function commandResult(rows, request, { reasonCode = 0, message = 'Mock MQSC command completed.' } = {}) {
  const completionCode = reasonCode ? 2 : 0;
  const responses = rows.length ? rows : [null];
  return {
    commandResponse: responses.map(parameters => {
      const entry = { completionCode, reasonCode };
      if (request.plain) entry.text = [parameters ? Object.entries(parameters).map(([key, value]) => `${key.toUpperCase()}(${Array.isArray(value) ? value.join(',') : value})`).join(' ') : message];
      else if (parameters) entry.parameters = parameters;
      else entry.message = [message];
      return entry;
    }), overallCompletionCode: completionCode, overallReasonCode: reasonCode ? 3008 : 0
  };
}
function whereFilter(expression) {
  if (typeof expression !== 'string') fail(400, 'WHERE must be a string');
  const match = /^([A-Za-z][A-Za-z0-9]*)\s+(EQ|NE|GT|LT|GE|LE|LK|NL)\s+(.+)$/i.exec(expression.trim());
  if (!match) fail(400, 'WHERE must be ATTRIBUTE OPERATOR VALUE');
  const [, field, operator, raw] = match;
  const expected = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
  return record => {
    const value = record[field.toLowerCase()];
    if (value === undefined) fail(400, 'Unknown WHERE attribute');
    const operation = operator.toUpperCase();
    if (['LK', 'NL'].includes(operation)) {
      const matches = wildcard(expected.toUpperCase(), String(value).toUpperCase());
      return operation === 'LK' ? matches : !matches;
    }
    const compare = typeof value === 'number' ? Number(expected) : expected.toUpperCase();
    const actual = typeof value === 'number' ? value : String(value).toUpperCase();
    if (typeof compare === 'number' && !Number.isFinite(compare)) fail(400, 'Numeric WHERE requires a number');
    return { EQ: actual === compare, NE: actual !== compare, GT: actual > compare, LT: actual < compare, GE: actual >= compare, LE: actual <= compare }[operation];
  };
}
function execute(state, qmgr, request) {
  const { command, qualifier, parameters } = request;
  const isQueue = Object.hasOwn(QUEUES, qualifier);
  const type = STATUSES[qualifier] || qualifier;
  const spec = OBJECT_TYPES[type];
  if (['qmgr', 'qmstatus'].includes(qualifier)) {
    if (request.name !== undefined) fail(400, 'QMGR does not accept an object name');
    if (command === 'display') {
      keys(parameters, ['where']);
      const row = qualifier === 'qmgr' ? structuredClone(qmgr.parameters) : { qmgr: qmgr.name, status: qmgr.state.toUpperCase(), conns: qmgr.status.connectionCount };
      return select([row], request, 'qmgr');
    }
    if (command === 'ping' && qualifier === 'qmgr') { keys(parameters, []); return commandResult([], request); }
    if (command === 'alter' && qualifier === 'qmgr') {
      keys(parameters, ['descr', 'deadq', 'maxmsgl']);
      if (parameters.descr !== undefined && (typeof parameters.descr !== 'string' || parameters.descr.length > 64)) fail(400, 'DESCR must be a string of at most 64 characters');
      if (parameters.deadq !== undefined && parameters.deadq !== '') validateName(parameters.deadq, 'Dead-letter queue');
      if (parameters.maxmsgl !== undefined && (!Number.isInteger(parameters.maxmsgl) || parameters.maxmsgl < 0 || parameters.maxmsgl > 104857600)) fail(400, 'Invalid MAXMSGL');
      Object.assign(qmgr.parameters, parameters);
      return commandResult([], request);
    }
    fail(400, 'Unsupported queue manager command');
  }
  if (!isQueue && !spec) fail(400, 'Unsupported MQSC qualifier');
  const resourceName = request.name ?? (command === 'display' ? '*' : undefined);
  if (typeof resourceName !== 'string' || !resourceName) fail(400, 'An object name is required');
  const collection = isQueue ? qmgr.objects.queues : qmgr.objects[spec.collection];
  let queueType = QUEUES[qualifier];
  if (isQueue && parameters.type !== undefined) {
    queueType = Object.keys(QUEUE_TYPES).find(key => QUEUE_TYPES[key] === String(parameters.type).toUpperCase());
    if (!queueType) fail(400, 'Invalid MQSC queue TYPE');
  }
  if (command === 'display') {
    keys(parameters, isQueue ? ['where', 'type'] : ['where']);
    let records = [...collection.values()].filter(row => wildcard(resourceName, isQueue ? row.name : row[spec.identity]));
    if (isQueue && queueType) records = records.filter(row => row.type === queueType);
    const identity = isQueue ? (qualifier === 'qstatus' ? 'qstatus' : 'queue') : qualifier;
    const rows = records.map(row => {
      if (qualifier === 'qstatus') {
        const status = state.queueStatus(qmgr, row);
        return { qstatus: row.name, type: 'QUEUE', curdepth: status.currentDepth, ipprocs: 0, opprocs: 0, uncomm: 0, msgage: status.oldestMessageAge };
      }
      if (isQueue) return queueParameters(row, qmgr.messages.get(row.name).length);
      if (STATUSES[qualifier]) return { [qualifier]: row[spec.identity], status: row.status, ...(type === 'channel' ? { chltype: row.chltype, conname: row.conname } : {}) };
      const copy = structuredClone(row);
      delete copy.status;
      return copy;
    });
    return select(rows, request, identity);
  }
  if (qualifier === 'qstatus' || STATUSES[qualifier]) fail(400, 'Status qualifiers support DISPLAY only');
  validateName(resourceName, 'MQSC object name', type === 'channel' ? 20 : 48);
  const previous = collection.get(resourceName);
  if (command === 'define' || command === 'alter') {
    if (command === 'alter' && !previous) fail(404, 'Object does not exist', { reasonCode: 2085 });
    if (command === 'alter' && isQueue && previous.type !== (queueType || previous.type)) fail(400, 'Queue type mismatch');
    const replace = parameters.replace === true || String(parameters.replace).toLowerCase() === 'yes';
    let base = command === 'alter' ? previous : undefined;
    if (parameters.like !== undefined) {
      if (command !== 'define') fail(400, 'LIKE is supported only for DEFINE');
      base = collection.get(parameters.like);
      if (!base) fail(404, 'LIKE object does not exist', { reasonCode: 2085 });
    }
    const update = { ...parameters };
    delete update.type;
    if (isQueue) {
      const actualType = queueType || base?.type;
      if (!actualType) fail(400, 'DEFINE QUEUE requires a type');
      const record = queueFromParameters(update, resourceName, actualType, base);
      state.putQueue(qmgr, record, { replace: command === 'alter' || replace });
    } else {
      delete update.like;
      delete update.replace;
      const record = createResource(type, resourceName, { ...base, ...update });
      state.putResource(qmgr, type, record, command === 'alter' || replace);
    }
    const message = isQueue && command === 'define' ? 'AMQ8006I: IBM MQ queue created.' : 'Mock MQSC object updated.';
    return commandResult([], request, { message });
  }
  if (!previous || (isQueue && queueType && previous.type !== queueType)) fail(404, 'Object does not exist', { reasonCode: 2085 });
  if (command === 'delete') {
    keys(parameters, ['purge']);
    if (isQueue && qmgr.messages.get(resourceName).length && parameters.purge !== true && String(parameters.purge).toLowerCase() !== 'yes') fail(400, 'Queue is not empty', { reasonCode: 2055 });
    collection.delete(resourceName);
    if (isQueue) { qmgr.messages.delete(resourceName); qmgr.lastPut.delete(resourceName); qmgr.lastGet.delete(resourceName); }
  } else if (command === 'clear' && isQueue && previous.type === 'local') {
    keys(parameters, []);
    qmgr.messages.set(resourceName, []);
  } else if (['start', 'stop'].includes(command) && ['channel', 'listener', 'service'].includes(type)) {
    keys(parameters, []);
    previous.status = command === 'start' ? 'RUNNING' : 'STOPPED';
  } else if (command === 'ping' && type === 'channel') {
    keys(parameters, []);
  } else fail(400, 'Unsupported MQSC operation for this object');
  state.events.emit('change');
  return commandResult([], request);
}
function select(rows, request, identity) {
  if (request.parameters.where !== undefined) rows = rows.filter(whereFilter(request.parameters.where));
  if (!rows.length) return commandResult([], request, { reasonCode: 2085, message: 'AMQ8147: IBM MQ object not found.' });
  if (request.responseParameters.length && !request.responseParameters.includes('all')) {
    rows = rows.map(row => {
      keys(Object.fromEntries(request.responseParameters.map(key => [key, true])), Object.keys(row), 'response parameter');
      return Object.fromEntries(Object.entries(row).filter(([key]) => [identity, 'type', ...request.responseParameters].includes(key)));
    });
  }
  return commandResult(rows, request);
}
function runMqsc(state, qmgr, request) {
  try { return execute(state, qmgr, request); }
  catch (error) {
    if (error instanceof MqError && error.reasonCode !== undefined && error.status !== 503) return commandResult([], request, { reasonCode: error.reasonCode, message: error.message });
    throw error;
  }
}
module.exports = { parseRequest, runMqsc, whereFilter };
