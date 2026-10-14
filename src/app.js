/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('node:crypto');
const { createConfig } = require('./config');
const { createState } = require('./state');
const { createAuth } = require('./auth');
const { MqError, fail, errorBody, jsonBody, keys, query } = require('./protocol');
const { addAdminApi } = require('./admin-api');
const { addMessaging } = require('./messaging');
const { createMockRouter, validateScenarios, scenarioMiddleware } = require('./mock-controls');
function createApp({ config: overrides = {}, env = {}, fixtures, users, now, scenarios = [], logger = console } = {}) {
  const config = createConfig(overrides, env);
  const state = createState(config, { fixtures, now });
  const auth = createAuth(state, config, users);
  state.scenarios = validateScenarios(scenarios, config);
  const app = express();
  app.disable('x-powered-by'); app.disable('etag'); app.set('case sensitive routing', true); app.set('query parser', 'simple');
  app.locals.state = state; app.locals.config = config;
  app.use((req, res, next) => {
    state.cleanup();
    const suppliedId = req.get('x-request-id');
    req.requestId = suppliedId && /^[\w.-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
    res.set({ 'X-Request-Id': req.requestId, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    state.metrics.requests++;
    res.once('finish', () => {
      state.metrics.responses[res.statusCode] = (state.metrics.responses[res.statusCode] || 0) + 1;
      // Keep credentials, headers, query strings, and message bodies out of diagnostics.
      state.audit.push({ requestId: req.requestId, method: req.method, path: req.path.slice(0, 1024), status: res.statusCode, at: state.now(), ...(req.session ? { username: req.session.username } : {}) });
      if (state.audit.length > config.maxAuditEntries) state.audit.splice(0, state.audit.length - config.maxAuditEntries);
    });
    next();
  });
  if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin, credentials: config.corsOrigin !== '*', exposedHeaders: ['X-Request-Id', 'X-Mock-Total-Count', 'ibm-mq-md-messageId', 'ibm-mq-md-correlationId', 'ibm-mq-md-priority', 'ibm-mq-md-persistence', 'ibm-mq-md-expiry', 'ibm-mq-md-replyTo', 'ibm-mq-usr', 'ibm-mq-resolved-qmgr', 'Location'] }));
  app.use(cookieParser());
  app.use(express.raw({ type: () => true, limit: config.bodyLimit, inflate: false }));
  app.get('/health', (req, res) => res.json({ status: 'ok', product: 'IBM MQ REST mock', apiVersions: ['v1', 'v2', 'v3'], ...state.counts() }));
  app.post('/auth/generate-otp', (req, res) => {
    const body = jsonBody(req); keys(body, ['username']);
    res.json(auth.generateOTP(body.username));
  });
  app.get('/auth/otp-status/:username', (req, res) => {
    const otp = state.otps.get(req.params.username);
    res.json({ username: req.params.username, active: Boolean(otp), ...(otp ? { expiresAt: otp.expiresAt } : {}) });
  });
  app.use('/admin', createMockRouter(state, auth, config));
  const api = express.Router({ mergeParams: true, caseSensitive: true });
  api.post('/login', (req, res) => {
    query(req, []); const body = jsonBody(req); keys(body, ['username', 'password']);
    if (typeof body.username !== 'string' || typeof body.password !== 'string') fail(400, 'username and password must be strings');
    const session = auth.credentials(body.username, body.password);
    auth.cookie(res, session, req.secure);
    res.status(204).end();
  });
  api.use(auth.authenticate);
  api.get('/login', (req, res) => { query(req, []); res.json({ user: [{ name: req.session.username, role: [...req.session.roles] }] }); });
  api.delete('/login', auth.csrf, (req, res) => {
    query(req, []);
    state.sessions.delete(req.session.username); state.events.emit('change');
    res.clearCookie('LtpaToken2', { path: '/', httpOnly: true, secure: req.secure, sameSite: 'lax' }).status(204).end();
  });
  api.all('/login', (req, res) => { res.set('Allow', 'GET, POST, DELETE'); fail(405, 'Method is not supported'); });
  api.use((req, res, next) => {
    if (req.path.startsWith('/messaging/') || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return auth.csrf(req, res, next);
    next();
  });
  api.use((req, res, next) => {
    if (req.get('ibm-mq-rest-gateway-qmgr') !== undefined) fail(400, 'Gateway routing is not implemented; supply target queue managers as fixtures');
    if (req.get('accept-charset') && req.get('accept-charset').toLowerCase() !== 'utf-8') fail(406, 'Only UTF-8 responses are available');
    next();
  });
  api.use(scenarioMiddleware(state, config));
  function register(path, methods) {
    const route = api.route(path);
    for (const [method, handler] of Object.entries(methods)) route[method](handler);
    route.all((req, res) => { res.set('Allow', Object.keys(methods).map(method => method.toUpperCase()).join(', ')); fail(405, 'Method is not supported for this MQ resource'); });
  }
  addAdminApi(register, state, auth);
  addMessaging(register, state, auth, config);
  app.use('/ibmmq/rest/:version', (req, res, next) => {
    if (!['v1', 'v2', 'v3'].includes(req.params.version)) fail(404, 'Unsupported REST API version');
    next();
  }, api);
  app.use((req, res) => { fail(404, 'Resource is not implemented by the MQ REST mock'); });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let failure = error;
    if (!(error instanceof MqError)) {
      if (error.type === 'entity.too.large') failure = new MqError(413, 'Request body exceeds BODY_LIMIT');
      else if (error.status === 415) failure = new MqError(415, 'Unsupported request encoding');
      else if (error instanceof URIError) failure = new MqError(400, 'Invalid URL encoding');
      else {
        logger.error({ requestId: req.requestId, message: 'Unexpected mock server error' });
        failure = new MqError(500, 'Unexpected mock server error');
      }
    }
    if (failure.status === 401) res.set('WWW-Authenticate', 'Basic realm="IBM MQ REST mock"');
    res.status(failure.status).json(errorBody(failure));
  });
  return app;
}
module.exports = { createApp };
