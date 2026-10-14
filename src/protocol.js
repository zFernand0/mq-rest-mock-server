/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
class MqError extends Error {
  constructor(status, message, { messageId = 'MQWB0001E', reasonCode } = {}) {
    super(message);
    this.status = status;
    this.messageId = messageId;
    this.reasonCode = reasonCode;
  }
}
function fail(status, message, details) { throw new MqError(status, message, details); }
function errorBody(error) {
  const item = {
    type: 'rest', messageId: error.messageId,
    message: `${error.messageId}: ${error.message}`,
    explanation: error.message, action: 'Correct the request or mock configuration and retry.'
  };
  if (error.reasonCode !== undefined) Object.assign(item, { completionCode: 2, reasonCode: error.reasonCode });
  return { error: [item] };
}
function object(value, label = 'Request body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, `${label} must be a JSON object`);
  return value;
}
function keys(value, allowed, label = 'Request') {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(400, `Unsupported ${label} field: ${key}`);
  }
}
function integer(value, label, min, max) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) fail(400, `${label} must be an integer from ${min} to ${max}`);
  return Number(value);
}
function name(value, label = 'Object name', max = 48) {
  if (typeof value !== 'string' || !value.length || value.length > max || !/^[A-Za-z0-9._/%]+$/.test(value)) fail(400, `${label} must be 1-${max} MQ name characters`);
  return value;
}
function query(req, allowed) {
  const values = req.mqQuery || req.query;
  keys(values, allowed, 'query');
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') fail(400, `Query parameter ${key} must occur once`);
  }
  return values;
}
function jsonBody(req) {
  if (!req.is('application/json')) fail(415, 'Content-Type must be application/json');
  if (/charset\s*=\s*(?!"?utf-8(?:"|\s|;|$))/i.test(req.get('content-type'))) fail(415, 'JSON requests require UTF-8');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)); }
  catch { fail(400, 'Request body must be valid UTF-8 JSON'); }
  return object(value);
}
function wildcard(pattern, value) {
  const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`).test(value);
}
function merge(target, update) {
  for (const [key, value] of Object.entries(update)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, 'Unsafe object key');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = merge({ ...target[key] }, value);
    } else target[key] = structuredClone(value);
  }
  return target;
}
function project(record, selection, defaults) {
  const result = Object.fromEntries(defaults.map(key => [key, structuredClone(record[key])]));
  if (selection === undefined) return result;
  const fields = selection.split(',');
  if (new Set(fields).size !== fields.length || (fields.includes('*') && fields.length !== 1)) fail(400, 'Attribute selections must be unique; * must occur alone');
  for (const field of fields) {
    if (field === '*') return structuredClone(record);
    const [group, child, extra] = field.split('.');
    if (extra || !Object.hasOwn(record, group)) fail(400, `Unknown attribute: ${field}`);
    if (child === undefined) result[group] = structuredClone(record[group]);
    else {
      if (!record[group] || !Object.hasOwn(record[group], child)) fail(400, `Unknown attribute: ${field}`);
      result[group] = { ...result[group], [child]: structuredClone(record[group][child]) };
    }
  }
  return result;
}
module.exports = { MqError, fail, errorBody, object, keys, integer, name, query, jsonBody, wildcard, merge, project };
