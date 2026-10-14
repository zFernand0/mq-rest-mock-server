/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const crypto = require('node:crypto');
const { fail, object, keys, wildcard } = require('./protocol');
const ROLES = ['MQWebAdmin', 'MQWebAdminRO', 'MQWebUser'];
const DEFAULT_USERS = {
  adminusr: { password: 'adminpas', roles: ['MQWebAdmin', 'MQWebUser'] },
  reader: { password: 'reader', roles: ['MQWebAdminRO'] },
  app: { password: 'app', roles: ['MQWebUser'], permissions: { admin: 'read' } },
  testuser: { otp: true, roles: ['MQWebUser'], permissions: { admin: 'read' } }
};
function normalizeUsers(users) {
  object(users, 'Users');
  const result = new Map();
  for (const [username, user] of Object.entries(users)) {
    object(user, 'User');
    keys(user, ['password', 'otp', 'roles', 'permissions'], 'user');
    if (!username || username.includes(':') || !Array.isArray(user.roles) || !user.roles.length ||
        user.roles.some(role => !ROLES.includes(role)) ||
        (user.otp !== true && (typeof user.password !== 'string' || !user.password))) throw new TypeError('Users require a username, password or OTP, and valid MQ roles');
    if (user.permissions !== undefined) {
      object(user.permissions, 'Permissions');
      keys(user.permissions, ['admin', 'queues'], 'permissions');
      if (user.permissions.admin !== undefined && ![false, 'read', 'write'].includes(user.permissions.admin)) throw new TypeError('Invalid administration permission');
      if (user.permissions.queues !== undefined) {
        if (!Array.isArray(user.permissions.queues) || user.permissions.queues.some(rule =>
          !rule || typeof rule.qmgr !== 'string' || typeof rule.name !== 'string' ||
          !Array.isArray(rule.operations) || rule.operations.some(op => !['put', 'get', 'browse', 'publish'].includes(op)))) throw new TypeError('Invalid queue permission rules');
      }
    }
    result.set(username, structuredClone(user));
  }
  return result;
}
function createAuth(state, config, users = DEFAULT_USERS) {
  const registry = normalizeUsers(users);
  function credentials(username, password) {
    const user = registry.get(username);
    let valid = false;
    if (user && typeof password === 'string') {
      const expected = user.otp ? state.otps.get(username)?.value : user.password;
      if (expected !== undefined) {
        const hash = value => crypto.createHash('sha256').update(value).digest();
        valid = crypto.timingSafeEqual(hash(password), hash(expected));
      }
    }
    if (!valid) fail(401, 'Invalid username or password');
    // Reserve a session before consuming a one-time credential.
    let session = state.sessions.get(username);
    if (!session) {
      if (state.sessions.size >= config.maxSessions) fail(503, 'Mock session limit reached');
      session = { username, token: crypto.randomBytes(32).toString('hex'), createdAt: state.now(), expiresAt: state.now() + config.sessionTtlMs };
      state.sessions.set(username, session);
    }
    if (user.otp && config.otpSingleUse) state.otps.delete(username);
    return { ...session, roles: user.roles, permissions: user.permissions };
  }
  function cookie(res, session, secure) {
    res.cookie('LtpaToken2', session.token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: session.expiresAt - state.now() });
  }
  function authenticate(req, res, next) {
    const authorization = req.get('authorization');
    if (authorization) {
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
      if (!match) fail(401, 'Basic authentication or an LtpaToken2 cookie is required');
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 1) fail(401, 'Invalid Basic credentials');
      req.session = credentials(decoded.slice(0, separator), decoded.slice(separator + 1));
      cookie(res, req.session, req.secure);
    } else {
      const token = req.cookies.LtpaToken2 || req.get('ltpatoken2');
      const session = [...state.sessions.values()].find(value => value.token === token);
      if (!session) fail(401, 'Authentication required; session is missing or expired');
      const user = registry.get(session.username);
      req.session = { ...session, roles: user.roles, permissions: user.permissions };
    }
    next();
  }
  function csrf(req, res, next) {
    if (config.requireCsrf && !Object.hasOwn(req.headers, 'ibm-mq-rest-csrf-token')) fail(401, 'The ibm-mq-rest-csrf-token header is required');
    next();
  }
  function administration(req, write = false) {
    const { roles, permissions } = req.session;
    if (roles.includes('MQWebAdmin') || (!write && roles.includes('MQWebAdminRO')) ||
        (roles.includes('MQWebUser') && (permissions?.admin === 'write' || (!write && permissions?.admin === 'read')))) return;
    fail(403, 'Administration authority is required', { reasonCode: 2035 });
  }
  function messaging(req, qmgr, queue, operation) {
    if (!req.session.roles.includes('MQWebUser')) fail(403, 'Messaging requires the MQWebUser role', { reasonCode: 2035 });
    const rules = req.session.permissions?.queues;
    if (rules && !rules.some(rule => wildcard(rule.qmgr, qmgr) && wildcard(rule.name, queue) && rule.operations.includes(operation))) fail(403, 'Messaging authority is required', { reasonCode: 2035 });
  }
  function requireAdmin(req, res, next) {
    if (!req.session.roles.includes('MQWebAdmin')) fail(403, 'Mock administration requires MQWebAdmin');
    next();
  }
  function generateOTP(username) {
    if (!registry.get(username)?.otp) fail(400, 'Unknown OTP-enabled user');
    const existing = state.otps.get(username);
    const stored = existing || { value: String(crypto.randomInt(100000, 1000000)), expiresAt: state.now() + config.otpTtlMs };
    state.otps.set(username, stored);
    return { username, otp: stored.value, expiresAt: new Date(stored.expiresAt).toISOString(), expiresInSeconds: Math.ceil((stored.expiresAt - state.now()) / 1000), isReused: Boolean(existing) };
  }
  return { authenticate, csrf, administration, messaging, requireAdmin, credentials, cookie, generateOTP };
}
module.exports = { createAuth, normalizeUsers, DEFAULT_USERS };
