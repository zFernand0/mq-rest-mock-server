/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const DEFAULTS = Object.freeze({
  host: '127.0.0.1', port: 9080, bodyLimit: '1mb',
  sessionTtlMs: 28800000, otpTtlMs: 300000, otpSingleUse: true,
  maxQueueManagers: 100, maxObjects: 10000, maxMessages: 10000,
  maxMessageBytes: 16777216, maxSessions: 1000, maxWaitMs: 30000,
  maxWaiters: 100, maxAuditEntries: 1000, maxScenarios: 100,
  requireCsrf: true, latencyMs: 0, corsOrigin: '', mqscResponseStyle: 'distributed', logRequests: false
});
const ENV = {
  host: 'HOST', port: 'PORT', bodyLimit: 'BODY_LIMIT', sessionTtlMs: 'SESSION_TTL_MS',
  otpTtlMs: 'OTP_TTL_MS', otpSingleUse: 'OTP_SINGLE_USE', maxQueueManagers: 'MAX_QUEUE_MANAGERS',
  maxObjects: 'MAX_OBJECTS', maxMessages: 'MAX_MESSAGES', maxMessageBytes: 'MAX_MESSAGE_BYTES',
  maxSessions: 'MAX_SESSIONS', maxWaitMs: 'MAX_WAIT_MS', maxWaiters: 'MAX_WAITERS',
  maxAuditEntries: 'MAX_AUDIT_ENTRIES', maxScenarios: 'MAX_SCENARIOS',
  requireCsrf: 'REQUIRE_CSRF', latencyMs: 'LATENCY_MS', corsOrigin: 'CORS_ORIGIN', mqscResponseStyle: 'MQSC_RESPONSE_STYLE', logRequests: 'LOG_REQUESTS'
};
function createConfig(overrides = {}, env = {}) {
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`Unknown configuration key: ${key}`);
  }
  const config = { ...DEFAULTS };
  for (const [key, envKey] of Object.entries(ENV)) {
    const value = overrides[key] ?? env[envKey];
    if (value === undefined) continue;
    if (typeof DEFAULTS[key] === 'boolean') {
      if (![true, false, 'true', 'false'].includes(value)) throw new TypeError(`${envKey} must be true or false`);
      config[key] = value === true || value === 'true';
    } else if (typeof DEFAULTS[key] === 'number') {
      if (!/^\d+$/.test(String(value))) throw new TypeError(`${envKey} must be an integer`);
      config[key] = Number(value);
      const min = ['port', 'latencyMs', 'maxWaitMs'].includes(key) ? 0 : 1;
      if (!Number.isSafeInteger(config[key]) || config[key] < min ||
          (key === 'port' && config[key] > 65535) ||
          (['latencyMs', 'maxWaitMs'].includes(key) && config[key] > 60000)) throw new RangeError(`${envKey} is out of range`);
    } else {
      if (typeof value !== 'string' || (!value.trim() && key !== 'corsOrigin')) throw new TypeError(`${envKey} must be a string`);
      if (key === 'bodyLimit' && (!/^\d+(?:\.\d+)?(?:b|kb|mb)?$/i.test(value) || parseFloat(value) <= 0)) throw new TypeError('BODY_LIMIT must be a positive byte size');
      if (key === 'mqscResponseStyle' && !['distributed', 'zos'].includes(value)) throw new TypeError('MQSC_RESPONSE_STYLE must be distributed or zos');
      config[key] = value;
    }
  }
  return Object.freeze(config);
}
module.exports = { createConfig, DEFAULTS };
