<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Fernando Rijo Cedeno
-->

# IBM MQ REST Mock Server

A stateful Node.js mock for developing and testing IBM MQ REST clients without an MQ installation. It implements a documented subset of the IBM MQ 9.4 `mqweb` administration and messaging APIs, with Basic authentication, mock LTPA sessions, roles, CSRF checks, OTP test controls, isolated fixtures, bounded storage, and scripted failures.

The IBM MQ Console is a browser application hosted by `mqweb`; the published REST APIs are the compatibility target here. This project provides API responses and behavior for client tests. It does not serve the IBM Console UI or implement its private interfaces. See the [API research and payload examples](docs/api-research.md) for the IBM sources and version distinctions.

## Start and validate

Requires Node.js 22 or later.

```sh
npm ci
npm start                         # http://127.0.0.1:9080
npm run dev                       # Node's built-in file watcher
npm test                          # isolated unit and real HTTP tests
npm run validate                  # syntax, SPDX headers, tests, coverage
```

Tests start independent servers on ephemeral loopback ports. They do not require a running mock, queue manager, or mainframe. Expiry tests use an injected clock. CI runs validation on Node.js 22 and 24 and enforces 95% lines, 85% branches, and 95% functions across server code.

The lockfile includes exact versions and integrity hashes without registry URLs. Installs use your npm registry configuration. Preserve this format with `npm install --omit-lockfile-registry-resolved` when updating dependencies.

## Quick examples

### Discover queue managers

```sh
curl -u adminusr:adminpas \
  'http://127.0.0.1:9080/ibmmq/rest/v3/admin/qmgr?attributes=*&status=*'
```

The default fixtures contain running `QM1`, stopped `QM2`, three `DEV.QUEUE.*` local queues, alias/remote/model definitions, channels, a listener, a topic, a subscription, and representative administration objects. Message queues start empty.

### Create and inspect a queue using v3 MQSC

```sh
curl -u adminusr:adminpas -X POST \
  'http://127.0.0.1:9080/ibmmq/rest/v3/admin/action/qmgr/QM1/mqsc' \
  -H 'Content-Type: application/json' -H 'ibm-mq-rest-csrf-token: demo' \
  -d '{"type":"runCommandJSON","command":"define","qualifier":"qlocal","name":"APP.IN","parameters":{"maxdepth":100,"descr":"Application input"}}'

curl -u adminusr:adminpas -X POST \
  'http://127.0.0.1:9080/ibmmq/rest/v3/admin/action/qmgr/QM1/mqsc' \
  -H 'Content-Type: application/json' -H 'ibm-mq-rest-csrf-token: demo' \
  -d '{"type":"runCommandJSON","command":"display","qualifier":"qlocal","name":"APP.*","responseParameters":["maxdepth","curdepth"]}'
```

Both plain and JSON MQSC requests use a JSON HTTP body. Plain commands use `{"type":"runCommand","parameters":{"command":"DISPLAY QLOCAL(APP.IN) ALL"}}`; their response contains `commandResponse[].text`. JSON commands return `parameters` or `message` arrays. Inspect `overallCompletionCode` and `overallReasonCode`: an HTTP 200 can contain an MQSC execution failure.

### Put, browse, and consume a message

```sh
curl -i -u adminusr:adminpas -X POST \
  'http://127.0.0.1:9080/ibmmq/rest/v3/messaging/qmgr/QM1/queue/APP.IN/message' \
  -H 'Content-Type: text/plain;charset=utf-8' \
  -H 'ibm-mq-rest-csrf-token: demo' -H 'ibm-mq-md-persistence: persistent' \
  --data 'Hello MQ'

curl -u adminusr:adminpas \
  'http://127.0.0.1:9080/ibmmq/rest/v3/messaging/qmgr/QM1/queue/APP.IN/message' \
  -H 'ibm-mq-rest-csrf-token: demo'

curl -u adminusr:adminpas -X DELETE \
  'http://127.0.0.1:9080/ibmmq/rest/v3/messaging/qmgr/QM1/queue/APP.IN/message?wait=1000' \
  -H 'ibm-mq-rest-csrf-token: demo'
```

POST returns 201 with an empty body and an `ibm-mq-md-messageId` header. GET browses without removing the message. DELETE returns and removes the message. Reads return UTF-8 `text/plain`; an empty queue returns 204. `messagelist?limit=10` returns `{"messages":[...]}` metadata without bodies or removal.

Message IDs are 48 hexadecimal characters. V3 prefixes them with `ID:` in response headers and selection parameters; v1/v2 omit the prefix. V3 correlation IDs may also be application strings. The mock limits these strings to 256 printable ASCII characters so they can round trip in HTTP headers.

Messaging accepts `text/plain`, `text/html`, `text/xml`, `application/xml`, and `application/json` as UTF-8 text. JSON messaging bodies are opaque text and are not parsed as administration requests. Metadata headers support correlation ID, expiry in milliseconds, persistence, reply-to destination, and v3 priority/user properties. V1/v2 puts use priority 4; v3 defaults to the queue's `applicationDefaults.messagePriority`. Persistence defaults to `nonPersistent`, independently of queue defaults.

### Login and reuse a cookie

```sh
curl -c /tmp/mq-cookies -X POST \
  'http://127.0.0.1:9080/ibmmq/rest/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"adminusr","password":"adminpas"}'

curl -b /tmp/mq-cookies 'http://127.0.0.1:9080/ibmmq/rest/v3/login'

curl -b /tmp/mq-cookies -c /tmp/mq-cookies -X DELETE \
  'http://127.0.0.1:9080/ibmmq/rest/v3/login' \
  -H 'ibm-mq-rest-csrf-token: demo'
```

POST login returns 204 and an HttpOnly, SameSite=Lax `LtpaToken2` cookie. GET login returns `{"user":[{"name":"adminusr","role":[...]}]}`. Sessions expire eight hours after creation; repeated Basic logins reuse the live session. Cookie authentication and the mock `LtpaToken2` header share expiry. Logout and administrative session cleanup revoke the mock token immediately. These tokens are random test tokens, not IBM-signed LTPA tokens.

The `ibm-mq-rest-csrf-token` header must be present for messaging operations, including GET, and administrative mutations. Any value, including an empty value, is accepted. Login POST and administrative GET do not require it.

## Supported HTTP resources

Prefix all IBM-style paths with `/ibmmq/rest/v1`, `/ibmmq/rest/v2`, or `/ibmmq/rest/v3` as listed below. Paths, object names, and query parameters are case-sensitive; HTTP header names follow normal case-insensitive behavior.

| Path after version prefix | Methods | Versions | Behavior |
| --- | --- | --- | --- |
| `/login` | POST, GET, DELETE | 1, 2, 3 | Login, inspect roles, revoke session |
| `/admin/installation[/name]` | GET | 1, 2, 3 | Basic or extended installation attributes |
| `/admin/qmgr[/name]` | GET | 1, 2, 3 | Basic, extended, and status attributes; state filter |
| `/admin/action/qmgr/name/mqsc` | POST | 1, 2, 3 | Supported plain or JSON MQSC commands |
| `/admin/qmgr/name/queue[/name]` | GET; POST on collection; PATCH/DELETE on object | 1 | Queue definitions, create/replace, modify, delete |
| `/admin/qmgr/name/channel[/name]` | GET | 1 | TCP sender/receiver/server/requester/cluster channels |
| `/admin/qmgr/name/subscription[/name]` | GET | 1 | Subscription metadata, name or ID selection |
| `/messaging/qmgr/name/queue/name/message` | POST, GET, DELETE | 1, 2, 3 | Put, browse, consume; DELETE supports waiting |
| `/messaging/qmgr/name/queue/name/messagelist` | GET | 1, 2, 3 | Select and limit message metadata |
| `/messaging/qmgr/name/topic/topicString/message` | POST | 2, 3 | Publish to exact-topic subscriptions with local destinations |

Queue/channel/subscription REST resources are v1-only. V2/v3 return 404 for those paths; use MQSC. V1 channel GET omits server-connection and client-connection channels, matching IBM's documented restriction. Retrieve those definitions with `DISPLAY CHANNEL` through MQSC.

`GET /openapi.json` serves the implemented mock contract for inspection or import into API tools. It is separate from IBM's complete Swagger definition. `GET /health` provides public liveness and aggregate state counts.

### Stateful administration and filtering

V1 queue POST replaces an existing definition by default and retains its messages. `?noReplace` rejects duplicates, and `?like=EXISTING.Q` copies a definition. PATCH merges supplied attributes. Queue type and name cannot change in place. DELETE rejects nonempty queues unless `?purge` is present. Queue manager creation/deletion are not published REST resources and are not fabricated here.

Without `like`, alias creation requires `alias.targetName`, remote creation requires `remote.qmgrName`, and model creation requires `model.type`.

Supported queue groups and fields are defined in [src/resources.js](src/resources.js): `general`, `storage`, `applicationDefaults`, `extended`, `alias`, `remote`, `model`, `cluster`, and `trigger`. This is an attribute subset; unsupported fields fail explicitly. Trigger and cluster attributes are stored as configuration metadata; trigger processes and cluster routing are not simulated.

`attributes=storage,general` requests groups; `attributes=storage.maximumDepth` requests individual fields. `attributes=*` requests all implemented configuration attributes. Queue status is requested separately with `status=*` or `status=status.currentDepth`. Queue-manager status is returned only while running.

Queue `name=DEV.*` filters wildcard names. Queue `type` supports `all`, `local`, `alias`, `remote`, and `model`. `filter=general.inhibitPut:equalTo:false` filters scalars; numeric comparisons support `lessThan`, `greaterThan`, `lessThanOrEqualTo`, and `greaterThanOrEqualTo`, alongside `equalTo` and `notEqualTo`. Status filters require the `status` parameter. Subscription filters use the same format and can select `id`. V1 channel GET supports name/type filtering and the implemented configuration attributes; retrieve channel runtime status through MQSC.

Mock-only `mockOrderBy=name/A` or `/D`, `mockOffset=0`, and `mockLimit=20` enable sorting and pagination on administration lists. Pagination returns `X-Mock-Total-Count`. These are live lists; no retained CMCI cache or IBM pagination protocol is implied. Sorting happens before pagination. Duplicate query parameters, unknown fields, invalid numbers, and unsupported methods produce explicit errors.

### MQSC subset

| Object/qualifier | Supported operations |
| --- | --- |
| `QLOCAL`, `QALIAS`, `QREMOTE`, `QMODEL` | DEFINE, ALTER, DISPLAY, DELETE; CLEAR for local queues |
| `QUEUE` | DISPLAY; DEFINE with `parameters.type` |
| `CHANNEL`, `LISTENER`, `SERVICE` | DEFINE, ALTER, DISPLAY, DELETE, START, STOP; PING for channels |
| `TOPIC`, `SUB`, `PROCESS`, `NAMELIST`, `AUTHINFO` | DEFINE, ALTER, DISPLAY, DELETE |
| `QMGR` | DISPLAY, PING; ALTER `descr`, `deadq`, `maxmsgl` |
| `QMSTATUS`, `QSTATUS`, `CHSTATUS`, `LSSTATUS`, `SVSTATUS` | DISPLAY |

DISPLAY accepts wildcard names, `responseParameters`, and a simple `WHERE ATTRIBUTE OPERATOR VALUE`. Operators are `EQ`, `NE`, `GT`, `LT`, `GE`, `LE`, `LK`, and `NL`. `LIKE` and `REPLACE` are supported for DEFINE. Plain commands support quoted names and doubled apostrophes. Only one command is accepted per request; no shell commands execute.

MQSC flags use `"replace":"yes"`, `"purge":"yes"`, `"share":"yes"`, or their opposite flags such as `"noreplace":"yes"` and `"noshare":"yes"`. Queue attributes map to their REST representations. Other object definitions accept scalar/string-list MQSC fixture attributes and return them on DISPLAY; this does not provide IBM's complete schema or parameter semantics. Unknown operations are rejected.

### Messaging behavior

Local queues and queue aliases share stored messages. Both alias and target inhibition are enforced. Queues deliver by priority or FIFO according to `storage.messageDeliverySequence`; equal priorities retain arrival order. Concurrent consumers cannot remove the same stored message twice. `wait` applies to DELETE, is bounded by `MAX_WAIT_MS`, and releases listeners/timers on timeout, cancellation, session revocation, or queue manager stop.

Expired messages are removed on requests. Queue status and MQSC QSTATUS report current depth and oldest message age. The mock queue-manager stop/start control drops nonpersistent messages on restart and retains persistent messages in memory. Process restart drops all state.

Topic publication routes only to exact matching subscriptions with local queue destinations. Delivery checks all destination capacities before mutation. Remote queue delivery, topic wildcards, selectors, retained publications, transactional messaging, binary MQ payloads, and RFH2 serialization are not implemented. V3 user properties are represented as validated HTTP metadata for text-message workflows. Integer `long` properties are limited to JavaScript's safe integer range; property headers are limited to 8 KiB printable ASCII.

## Authentication and authorization

| User | Credential | Roles | Access |
| --- | --- | --- | --- |
| `adminusr` | `adminpas` | MQWebAdmin, MQWebUser | Administration, messaging, mock controls |
| `reader` | `reader` | MQWebAdminRO | Read-only administration, including MQSC DISPLAY/PING |
| `app` | `app` | MQWebUser | Read administration and messaging |
| `testuser` | Generated OTP | MQWebUser | Read administration and messaging |

Messaging requires MQWebUser; MQWebAdmin alone does not grant messaging access. Custom users can supply simplified administration permissions and queue/topic rules. This models authorization decisions for tests; it does not emulate OAM, RACF, LDAP, client-certificate mapping, or AMS.

```sh
curl -X POST 'http://127.0.0.1:9080/auth/generate-otp' \
  -H 'Content-Type: application/json' -d '{"username":"testuser"}'

# Replace 123456 with the returned one-time password.
curl -u testuser:123456 'http://127.0.0.1:9080/ibmmq/rest/v3/login'
```

OTPs expire after five minutes and are consumed after successful authentication. Regenerating an unused OTP returns the existing value and remaining lifetime. `/auth/otp-status/testuser` reports presence and expiry without its value. These are public mock controls; bind to loopback for local use. Set `OTP_SINGLE_USE=false` only for workflows that need reusable OTPs.

## Fixtures and embedded use

```js
const { createApp } = require('./server');

const app = createApp({
  config: { maxMessages: 100, sessionTtlMs: 60000 },
  fixtures: {
    queueManagers: [{
      name: 'TESTQM',
      queues: [{ name: 'APP.IN', storage: { maximumDepth: 10 } }],
      channels: [{ channel: 'APP.SVRCONN', chltype: 'SVRCONN' }],
      messages: { 'APP.IN': [{ body: 'Seed message', priority: 4 }] }
    }]
  },
  users: {
    developer: {
      password: 'mock-password',
      roles: ['MQWebUser'],
      permissions: {
        admin: 'read',
        queues: [{ qmgr: 'TESTQM', name: 'APP.*', operations: ['put', 'get', 'browse'] }]
      }
    }
  }
});

const server = app.listen(0, '127.0.0.1');
// Close the server when your client tests finish.
```

Each app clones fixtures and users and owns separate resources, messages, sessions, OTPs, failures, and diagnostics. Importing `server.js` starts no listener or background timer. The default export is an Express app; `createApp()` and `startServer()` are named exports. Embedded apps use stable defaults; pass `env: process.env` explicitly to read environment settings. Inject `now: () => milliseconds` for deterministic expiry and `logger` for unexpected error reporting.

Fixture `queueManagers` replaces the default managers. Managers may contain `queues`, `channels`, `listeners`, `topics`, `subscriptions`, `processes`, `namelists`, `authinfos`, `services`, `parameters`, `extended`, `status`, and `messages`. Queues use REST attribute groups; other object definitions use MQSC attributes. Message fixtures support body, hexadecimal message ID, correlation ID, priority, persistence, expiryMs, format, replyTo, and the string-form properties header. Subscription IDs are deterministic hashes of manager/name; message IDs are generated when omitted. `/admin/reset` reloads the original cloned fixtures.

## Mock controls and repeatable failures

All `/admin/*` controls require MQWebAdmin; mutations also require the CSRF header. These paths are mock extensions, separate from `/ibmmq/rest/*`.

| Path | Methods | Purpose |
| --- | --- | --- |
| `/admin/state` | GET | Counts and queue definitions by manager |
| `/admin/reset` | POST | Restore fixtures and clear scenarios, OTPs, and previous audit entries |
| `/admin/qmgr/name/state` | PATCH | Set `{ "state": "running" }` or `"ended"` |
| `/admin/sessions` | GET, DELETE | Session expiry metadata; revoke sessions |
| `/admin/otps` | GET, DELETE | OTP expiry metadata; remove active OTPs |
| `/admin/scenarios` | GET, POST, DELETE | Inspect, replace, or clear response sequences |
| `/admin/metrics` | GET | Request/status counters, put/get/browse counts, state counts |
| `/admin/audit` | GET | Bounded request metadata without headers, query strings, bodies, passwords, or token values |

```sh
curl -u adminusr:adminpas -X POST 'http://127.0.0.1:9080/admin/scenarios' \
  -H 'Content-Type: application/json' -H 'ibm-mq-rest-csrf-token: demo' \
  -d '{"scenarios":[{"method":"POST","path":"/ibmmq/rest/v3/messaging/*","steps":[{"status":503,"reasonCode":2059},{"delayMs":100},{"status":200}]}]}'
```

The first matching unconsumed rule advances once per authenticated API request. A step with status 200 continues the real operation after its delay; 204 returns an empty response; 400–599 returns an IBM-style error without changing resource/message state. Matching uses the URL path without query parameters; `*` is a wildcard. Scripts are finite, capped, and isolated per app. Validation failures leave the previous script intact. `scenarios` can also be supplied directly to `createApp()`.

The mock-only `simulate` query supports `unauthorized`, `forbidden`, `notfound`, `invalid`, `unavailable`, `error`, and `empty`. Example: `/ibmmq/rest/v3/admin/qmgr?simulate=unavailable`. Normal authentication and CSRF checks still apply.

## Configuration

`npm start` reads environment variables. Programmatic keys use camelCase.

| Environment | Config key | Default |
| --- | --- | --- |
| `HOST` | host | 127.0.0.1 |
| `PORT` | port | 9080; 0 selects an ephemeral port |
| `BODY_LIMIT` | bodyLimit | 1mb |
| `SESSION_TTL_MS` | sessionTtlMs | 28800000 |
| `OTP_TTL_MS` | otpTtlMs | 300000 |
| `OTP_SINGLE_USE` | otpSingleUse | true |
| `REQUIRE_CSRF` | requireCsrf | true |
| `MAX_QUEUE_MANAGERS` | maxQueueManagers | 100 |
| `MAX_OBJECTS` | maxObjects | 10000 across all managers |
| `MAX_MESSAGES` | maxMessages | 10000 across all queues |
| `MAX_MESSAGE_BYTES` | maxMessageBytes | 16777216 total UTF-8 body bytes |
| `MAX_SESSIONS` | maxSessions | 1000 |
| `MAX_WAIT_MS` | maxWaitMs | 30000; configurable up to 60000 |
| `MAX_WAITERS` | maxWaiters | 100 |
| `MAX_AUDIT_ENTRIES` | maxAuditEntries | 1000 |
| `MAX_SCENARIOS` | maxScenarios | 100; 100 steps per rule |
| `LATENCY_MS` | latencyMs | 0; maximum 60000 |
| `CORS_ORIGIN` | corsOrigin | empty (CORS disabled); a single origin or `*` |

Invalid configuration fails before startup. Limits reject new allocations rather than evicting existing resources/messages. Queue maximum depth and message length are enforced independently of global mock limits. Body-byte accounting excludes metadata and JavaScript object overhead. CORS credentials are enabled only for a concrete configured origin. The CLI starts on loopback and handles SIGINT/SIGTERM; request IDs and aggregate diagnostics help inspect test failures.

## Examples and containers

```sh
node examples/test-client.js       # run with the mock already started
node examples/embedded-client.js   # creates and closes an isolated mock

docker build -t mq-rest-mock-server .
docker run --rm -p 127.0.0.1:9080:9080 mq-rest-mock-server
```

The container runs as the Node user, binds internally to `0.0.0.0`, and has a health check. The standalone CLI serves HTTP; an embedded Express app can be mounted behind your test HTTPS server or proxy when testing TLS clients.

## Compatibility limits

This is a test double, with representative Unix MQ 9.4 responses and explicitly bounded behavior. The complete IBM MQ Console, MQI/PCF wire protocols, all MQSC commands and object attributes, gateway routing, distributed channel transport, z/OS queue sharing groups, appliance HA/DR, MFT APIs, authorization-record management, durable disk storage, and full broker transactions are outside this implementation. Unimplemented paths and operations fail explicitly. Generic object attributes represent test data and may not implement their real MQ semantics.

HTTP tests validate the documented request/response contracts. No live IBM MQ installation or external SDK was used for differential validation. Sanitized captures from real clients are the next useful compatibility check.

## License

Apache-2.0; see [LICENSE](LICENSE).
