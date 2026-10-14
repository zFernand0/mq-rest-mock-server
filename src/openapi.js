/**
 * SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Fernando Rijo Cedeno
 */
const { QUEUE_FIELDS } = require('./resources');
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const string = { type: 'string' };
function parameter(name, location = 'query', description = '') {
  const numeric = ['mockOffset', 'mockLimit', 'limit', 'wait'].includes(name);
  const schema = numeric ? { type: 'integer', minimum: ['mockOffset', 'wait'].includes(name) ? 0 : 1, maximum: name === 'wait' ? 60000 : 2147483647 } : string;
  return { name, in: location, required: location === 'path' || name === 'ibm-mq-rest-csrf-token', schema, description };
}
function json(schema) { return { 'application/json': { schema } }; }
function createOpenApi() {
  const queueProperties = { name: string, type: { type: 'string', enum: ['local', 'alias', 'model', 'remote'] } };
  for (const [group, fields] of Object.entries(QUEUE_FIELDS)) {
    queueProperties[group] = { type: 'object', additionalProperties: false, properties: {} };
    for (const [field, [, type, range]] of Object.entries(fields)) {
      queueProperties[group].properties[field] = type === 'integer' ? { type: 'integer', minimum: 0, maximum: range } :
        type === 'enum' ? { type: 'string', enum: Object.keys(range) } :
        type === 'string' ? string : { type: 'boolean' };
    }
  }
  const schemas = {
    Error: { type: 'object', required: ['error'], properties: { error: { type: 'array', items: { type: 'object', required: ['type', 'messageId', 'message', 'explanation', 'action'], properties: { type: string, messageId: string, message: string, explanation: string, action: string, reasonCode: { type: 'integer' }, completionCode: { type: 'integer' } } } } } },
    Login: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: string, password: { type: 'string', writeOnly: true } } },
    User: { type: 'object', properties: { user: { type: 'array', items: { type: 'object', properties: { name: string, role: { type: 'array', items: { type: 'string', enum: ['MQWebAdmin', 'MQWebAdminRO', 'MQWebUser'] } } } } } } },
    QueueWrite: { type: 'object', additionalProperties: false, properties: queueProperties },
    QueueCreate: { allOf: [ref('QueueWrite'), { type: 'object', required: ['name'] }] },
    QueuePatch: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(queueProperties).filter(([key]) => key !== 'name')) },
    QueueList: { type: 'object', properties: { queue: { type: 'array', items: { type: 'object', properties: { ...queueProperties, status: { type: 'object', properties: { currentDepth: { type: 'integer' }, openInputCount: { type: 'integer' }, openOutputCount: { type: 'integer' }, lastPut: { type: 'string', format: 'date-time' }, lastGet: { type: 'string', format: 'date-time' }, oldestMessageAge: { type: 'integer' } } } } } } } },
    QueueManagers: { type: 'object', properties: { qmgr: { type: 'array', items: { type: 'object', required: ['name', 'state'], properties: { name: string, state: string, extended: { type: 'object' }, status: { type: 'object' } } } } } },
    Installation: { type: 'object', properties: { installation: { type: 'array', items: { type: 'object', properties: { name: string, version: string, platform: string, extended: { type: 'object' } } } } } },
    ChannelList: { type: 'object', properties: { channel: { type: 'array', items: { type: 'object', properties: { name: string, type: string } } } } },
    SubscriptionList: { type: 'object', properties: { subscription: { type: 'array', items: { type: 'object', properties: { id: string, name: string, resolvedTopicString: string } } } } },
    Messages: { type: 'object', properties: { messages: { type: 'array', items: { type: 'object', properties: { messageId: string, correlationId: string, format: string } } } } },
    MqscRequest: {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['type', 'parameters'], properties: { type: { type: 'string', enum: ['runCommand'] }, parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: { command: string } } } },
        { type: 'object', additionalProperties: false, required: ['type', 'command', 'qualifier'], properties: { type: { type: 'string', enum: ['runCommandJSON'] }, command: string, qualifier: string, name: string, parameters: { type: 'object' }, responseParameters: { type: 'array', items: string } } }
      ]
    },
    MqscResponse: { type: 'object', required: ['commandResponse', 'overallCompletionCode', 'overallReasonCode'], properties: {
      overallCompletionCode: { type: 'integer' }, overallReasonCode: { type: 'integer' }, commandResponse: { type: 'array', items: { type: 'object', required: ['completionCode', 'reasonCode'], properties: { completionCode: { type: 'integer' }, reasonCode: { type: 'integer' }, parameters: { type: 'object' }, message: { type: 'array', items: string }, text: { type: 'array', items: string } } } }
    } }
  };
  const document = {
    openapi: '3.0.3', info: { title: 'IBM MQ REST Mock Server', version: '0.1.0', description: 'Implemented IBM MQ 9.4 REST subset. Mock extensions, unsupported behavior, and exact attribute coverage are documented in README.md. This is the mock contract, not the complete IBM Swagger definition.', license: { name: 'Apache-2.0' } },
    servers: [{ url: '/' }], security: [{ basicAuth: [] }, { ltpaCookie: [] }], paths: {},
    components: { securitySchemes: { basicAuth: { type: 'http', scheme: 'basic' }, ltpaCookie: { type: 'apiKey', in: 'cookie', name: 'LtpaToken2' } }, schemas }
  };
  function add(path, method, summary, status, schema, { parameters = [], body, text = false, csrf = false, publicAccess = false } = {}) {
    const pathParameters = [...path.matchAll(/\{(\w+)\}/g)].map(match => parameter(match[1], 'path'));
    const operation = { summary, parameters: [...pathParameters, ...parameters.map(name => parameter(name)), ...(csrf ? [parameter('ibm-mq-rest-csrf-token', 'header', 'Presence is required; any value, including empty, is accepted.')] : [])], responses: {} };
    operation.responses[status] = { description: 'Success', ...(schema ? { content: text ? { 'text/plain': { schema: string } } : json(ref(schema)) } : {}) };
    for (const error of [400, 401, 403, 404, 405, 413, 415, 500, 501, 503]) operation.responses[error] = { description: 'IBM-style REST error', content: json(ref('Error')) };
    if (text) operation.responses['204'] = { description: 'No matching message is available.' };
    if (body) operation.requestBody = { required: true, content: body === 'text' ? Object.fromEntries(['text/plain', 'text/html', 'text/xml', 'application/xml', 'application/json'].map(type => [type, { schema: string }])) : json(ref(body)) };
    if (path.includes('/messaging/')) {
      const version3 = path.includes('/v3/');
      if (method === 'post') {
        const headers = ['ibm-mq-md-correlationId', 'ibm-mq-md-expiry', 'ibm-mq-md-persistence', 'ibm-mq-md-replyTo', ...(version3 ? ['ibm-mq-md-priority', 'ibm-mq-usr'] : [])];
        operation.parameters.push(...headers.map(name => parameter(name, 'header', 'Optional MQ message metadata; see README.md for allowed formats.')));
      }
      const headers = ['ibm-mq-resolved-qmgr', ...(!path.endsWith('/messagelist') ? ['ibm-mq-md-messageId'] : []),
        ...(text ? ['ibm-mq-md-correlationId', 'ibm-mq-md-expiry', 'ibm-mq-md-persistence', 'ibm-mq-md-replyTo', ...(version3 ? ['ibm-mq-md-priority', 'ibm-mq-usr'] : [])] : [])];
      operation.responses[status].headers = Object.fromEntries(headers.map(name => [name, { schema: string, description: name === 'ibm-mq-md-messageId' ? `${version3 ? 'ID: followed by ' : ''}48 hexadecimal characters` : 'MQ message metadata' }]));
    }
    if (method === 'post' && path.endsWith('/queue')) operation.responses[status].headers = { Location: { schema: string, description: 'URL of the created queue.' } };
    if (publicAccess) operation.security = [];
    document.paths[path] ??= {};
    document.paths[path][method] = operation;
  }
  const pagination = ['mockOffset', 'mockLimit', 'mockOrderBy'];
  for (const version of ['v1', 'v2', 'v3']) {
    const base = `/ibmmq/rest/${version}`;
    add(`${base}/login`, 'post', 'Log in and receive an LtpaToken2 cookie', 204, null, { body: 'Login', publicAccess: true });
    add(`${base}/login`, 'get', 'Query the authenticated user and roles', 200, 'User');
    add(`${base}/login`, 'delete', 'Revoke the mock session and clear the cookie', 204, null, { csrf: true });
    for (const suffix of ['', '/{installationName}']) add(`${base}/admin/installation${suffix}`, 'get', 'Query the MQ installation', 200, 'Installation', { parameters: ['attributes'] });
    for (const suffix of ['', '/{qmgrName}']) add(`${base}/admin/qmgr${suffix}`, 'get', 'Query queue managers', 200, 'QueueManagers', { parameters: ['attributes', 'status', ...(!suffix ? ['state'] : []), ...pagination] });
    add(`${base}/admin/action/qmgr/{qmgrName}/mqsc`, 'post', 'Run a supported plain or JSON MQSC command', 200, 'MqscResponse', { body: 'MqscRequest', csrf: true });
    const messaging = `${base}/messaging/qmgr/{qmgrName}/queue/{queueName}`;
    add(`${messaging}/message`, 'post', 'Put a UTF-8 text message; message ID is returned in a header', 201, null, { body: 'text', csrf: true });
    add(`${messaging}/message`, 'get', 'Browse a message without removing it', 200, 'Messages', { text: true, csrf: true, parameters: ['messageId', 'correlationId'] });
    add(`${messaging}/message`, 'delete', 'Consume a message, optionally waiting for arrival', 200, 'Messages', { text: true, csrf: true, parameters: ['messageId', 'correlationId', 'wait'] });
    add(`${messaging}/messagelist`, 'get', 'List message metadata without removing messages', 200, 'Messages', { csrf: true, parameters: ['messageId', 'correlationId', 'limit'] });
    if (version !== 'v1') add(`${base}/messaging/qmgr/{qmgrName}/topic/{topicString}/message`, 'post', 'Publish text to exact-topic local subscriptions', 201, null, { body: 'text', csrf: true });
  }
  const base = '/ibmmq/rest/v1/admin/qmgr/{qmgrName}';
  for (const [resource, schema, identifier] of [['queue', 'QueueList', 'queueName'], ['channel', 'ChannelList', 'channelName'], ['subscription', 'SubscriptionList', 'subscriptionName']]) {
    for (const suffix of ['', `/{${identifier}}`]) add(`${base}/${resource}${suffix}`, 'get', `Query ${resource} definitions (v1 only)`, 200, schema, { parameters: ['attributes', ...(!suffix ? ['name'] : []), ...(resource === 'queue' ? ['type', 'status', 'filter'] : resource === 'channel' ? ['type'] : !suffix ? ['id', 'filter'] : []), ...pagination] });
  }
  add(`${base}/queue`, 'post', 'Create or replace a queue (v1 only)', 201, null, { body: 'QueueCreate', csrf: true, parameters: ['like', 'noReplace'] });
  add(`${base}/queue/{queueName}`, 'patch', 'Modify queue attributes (v1 only)', 204, null, { body: 'QueuePatch', csrf: true });
  add(`${base}/queue/{queueName}`, 'delete', 'Delete a queue (v1 only)', 204, null, { csrf: true, parameters: ['purge'] });
  return document;
}
module.exports = { createOpenApi };
