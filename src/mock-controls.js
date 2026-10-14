/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const express = require('express');
const { fail, query, jsonBody, keys, object, integer, wildcard } = require('./protocol');
function validateScenarios(value, config) {
  if (!Array.isArray(value) || value.length > config.maxScenarios) fail(400, 'Scenarios must be an array within MAX_SCENARIOS');
  return value.map(rule => {
    object(rule, 'Scenario'); keys(rule, ['method', 'path', 'steps'], 'scenario');
    if (!['GET', 'POST', 'PATCH', 'DELETE', 'PUT', '*'].includes(rule.method) || typeof rule.path !== 'string' || !rule.path.startsWith('/ibmmq/rest/') || rule.path.length > 256 ||
        !Array.isArray(rule.steps) || !rule.steps.length || rule.steps.length > 100) fail(400, 'Scenario requires method, API path pattern, and 1-100 steps');
    const steps = rule.steps.map(step => {
      object(step, 'Scenario step'); keys(step, ['status', 'delayMs', 'reasonCode'], 'scenario step');
      const status = step.status ?? 200;
      if (status !== 200 && status !== 204 && (status < 400 || status > 599) || !Number.isInteger(status)) fail(400, 'Scenario status must be 200 (continue), 204, or 400-599');
      const delayMs = integer(step.delayMs ?? 0, 'delayMs', 0, 60000);
      if (step.reasonCode !== undefined) integer(step.reasonCode, 'reasonCode', 0, 999999999);
      return { status, delayMs, ...(step.reasonCode === undefined ? {} : { reasonCode: step.reasonCode }) };
    });
    return { method: rule.method, path: rule.path, steps, index: 0 };
  });
}
function delay(res, milliseconds) {
  if (!milliseconds) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); res.removeListener('close', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    res.once('close', finish);
  });
}
function scenarioMiddleware(state, config) {
  const simulations = { unauthorized: 401, forbidden: 403, notfound: 404, invalid: 400, unavailable: 503, error: 500, empty: 204 };
  return async (req, res, next) => {
    const values = { ...req.query };
    const simulation = values.simulate;
    delete values.simulate;
    req.mqQuery = values;
    if (simulation !== undefined && (typeof simulation !== 'string' || !Object.hasOwn(simulations, simulation))) fail(400, 'Unknown mock simulation');
    const path = req.originalUrl.split('?')[0];
    const rule = state.scenarios.find(item => item.index < item.steps.length && (item.method === '*' || item.method === req.method) && wildcard(item.path, path));
    const step = rule ? rule.steps[rule.index++] : { status: 200, delayMs: config.latencyMs };
    await delay(res, step.delayMs);
    if (res.destroyed) return;
    state.cleanup();
    if (state.sessions.get(req.session.username)?.token !== req.session.token) fail(401, 'Session expired or was revoked during mock latency');
    const status = simulation === undefined ? step.status : simulations[simulation];
    if (status === 204) return res.status(204).end();
    if (status !== 200) {
      res.set('X-Mock-Simulated', 'true');
      if (status === 429 || status === 503) res.set('Retry-After', '1');
      fail(status, 'Scripted mock response', { reasonCode: step.reasonCode });
    }
    next();
  };
}
function createMockRouter(state, auth, config) {
  const router = express.Router();
  router.use(auth.authenticate, auth.requireAdmin);
  router.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return auth.csrf(req, res, next);
    next();
  });
  router.get('/state', (req, res) => {
    query(req, []);
    res.json({ counts: state.counts(), queueManagers: [...state.queueManagers.values()].map(qmgr => ({ name: qmgr.name, state: qmgr.state, queues: [...qmgr.objects.queues.values()] })) });
  });
  router.post('/reset', (req, res) => {
    query(req, []);
    state.reset(); state.scenarios = []; state.otps.clear(); state.audit.length = 0;
    res.status(204).end();
  });
  router.patch('/qmgr/:qmgrName/state', (req, res) => {
    query(req, []);
    const update = jsonBody(req); keys(update, ['state']);
    if (!['running', 'ended'].includes(update.state)) fail(400, 'Mock queue manager state must be running or ended');
    const qmgr = state.qmgr(req.params.qmgrName, false);
    if (qmgr.state !== 'running' && update.state === 'running') {
      for (const [queue, messages] of qmgr.messages) qmgr.messages.set(queue, messages.filter(message => message.persistence === 'persistent'));
      qmgr.status.started = new Date(state.now()).toISOString();
    }
    qmgr.state = update.state;
    state.events.emit('change');
    res.status(204).end();
  });
  router.get('/sessions', (req, res) => {
    query(req, []);
    res.json({ sessions: [...state.sessions.values()].map(({ username, createdAt, expiresAt }) => ({ username, createdAt, expiresAt })) });
  });
  router.delete('/sessions', (req, res) => {
    query(req, []); state.sessions.clear(); state.events.emit('change'); res.status(204).end();
  });
  router.get('/otps', (req, res) => {
    query(req, []);
    res.json({ otps: [...state.otps.entries()].map(([username, value]) => ({ username, expiresAt: value.expiresAt })) });
  });
  router.delete('/otps', (req, res) => { query(req, []); state.otps.clear(); res.status(204).end(); });
  router.get('/scenarios', (req, res) => { query(req, []); res.json({ scenarios: structuredClone(state.scenarios) }); });
  router.post('/scenarios', (req, res) => {
    query(req, []); const body = jsonBody(req); keys(body, ['scenarios']);
    state.scenarios = validateScenarios(body.scenarios, config);
    res.status(201).json({ scenarios: structuredClone(state.scenarios) });
  });
  router.delete('/scenarios', (req, res) => { query(req, []); state.scenarios = []; res.status(204).end(); });
  router.get('/metrics', (req, res) => { query(req, []); res.json({ ...structuredClone(state.metrics), counts: state.counts() }); });
  router.get('/audit', (req, res) => { query(req, []); res.json({ audit: structuredClone(state.audit) }); });
  return router;
}
module.exports = { createMockRouter, validateScenarios, scenarioMiddleware, delay };
