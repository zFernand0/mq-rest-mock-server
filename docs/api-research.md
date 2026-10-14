<!--
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Fernando Rijo Cedeno
-->

# IBM MQ REST API research and mock contract

Research target: IBM MQ 9.4 documentation, reviewed 2026-10-13. IBM's full [MQ 9.4 Administration Reference](https://public.dhe.ibm.com/software/integration/wmq/docs/V9.4/PDFs/mq94.refadmin.pdf) was also checked for resource URLs, attribute names, version restrictions, and payload formats. Examples below use this repository's fixtures and intentionally cover the implemented subset.

## Console, administration, and messaging

The IBM MQ Console and REST services run in a Liberty server called `mqweb`. The Console provides a browser UI. The administration REST API manages objects using JSON, while the messaging REST API puts, browses, receives, and publishes text messages. These public interfaces define the mock's compatibility scope. IBM also provides Managed File Transfer REST APIs; MFT is not implemented here. [IBM architecture overview](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=overview-mq-console-rest-api)

An important installation distinction: IBM's stand-alone MQ Web Server installation does not expose the administrative REST API. The mock models the administration-capable installation and representative local queue managers. It does not claim to reproduce every deployment mode. [IBM installation options](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=overview-mq-console-rest-api)

## Version and method map

The URL version is independent of the MQ product release. MQ 9.3 introduced `/ibmmq/rest/v3`; v1 is deprecated in MQ 9.4 but remains relevant for older clients. [IBM REST versions](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=api-rest-versions), [MQ 9.4 deprecations](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=940-deprecated-stabilized-removed-features-in-mq)

| Resource | Request | Response | Mock versions |
| --- | --- | --- | --- |
| `login` | POST JSON username/password | 204 and LTPA cookie | v1/v2/v3 |
| `login` | GET credentials/cookie | 200 `user` array with name/role | v1/v2/v3 |
| `login` | DELETE cookie and CSRF header | 204 and cookie removal | v1/v2/v3 |
| `admin/installation` | GET, optional attributes | 200 `installation` array | v1/v2/v3 |
| `admin/qmgr` | GET, optional name/state/attributes/status | 200 `qmgr` array | v1/v2/v3 |
| `admin/qmgr/QM1/queue` | GET/POST; PATCH/DELETE on named queue | `queue` array; empty successful write bodies | v1 only |
| `admin/qmgr/QM1/channel` | GET | 200 `channel` array | v1 only |
| `admin/qmgr/QM1/subscription` | GET | 200 `subscription` array | v1 only |
| `admin/action/qmgr/QM1/mqsc` | POST JSON action wrapper | 200 command responses and completion/reason codes | v1/v2/v3 |
| `messaging/qmgr/QM1/queue/Q/message` | POST text | 201, message ID header, empty body | v1/v2/v3 |
| same `message` path | GET browse / DELETE consume | 200 text and MQ metadata; 204 if empty | v1/v2/v3 |
| same queue's `messagelist` | GET with selectors/limit | 200 `messages` metadata array | v1/v2/v3 |
| `messaging/qmgr/QM1/topic/topicString/message` | POST text | 201, empty body | v2/v3 |

IBM restricts queue, channel, and subscription direct resources to v1. V3 uses the MQSC action resource for those object operations. Defining invented `/v3/admin/qmgr/QM1/queue` or direct channel mutation routes would mask client compatibility problems, so the mock rejects those requests. [IBM queue resource](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=resources-adminqmgrqmgrnamequeue), [IBM channel resource](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=resources-adminqmgrqmgrnamechannel), [IBM subscription resource](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=resources-adminqmgrqmgrnamesubscription)

Queue manager create, delete, start, and stop on Multiplatforms are control-command operations, with no corresponding public REST resources. The mock's stop/start testing endpoint lives under `/admin`, outside the IBM REST namespace. [IBM queue manager command comparison](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=comparison-queue-manager-commands)

## Authentication, roles, and CSRF

The public API supports Basic, token-based, and certificate authentication. This mock implements Basic plus random LTPA-shaped sessions and adds OTPs as a test extension. It does not sign real IBM tokens or authenticate client certificates.

Example login:

```http
POST /ibmmq/rest/v3/login
Content-Type: application/json

{"username":"adminusr","password":"adminpas"}
```

Success is HTTP 204 with `Set-Cookie: LtpaToken2=...`. An authenticated GET returns:

```json
{"user":[{"name":"adminusr","role":["MQWebAdmin","MQWebUser"]}]}
```

The documented roles are MQWebAdmin, MQWebAdminRO, and MQWebUser. Messaging requires MQWebUser, so a read-only administrator cannot put or consume messages merely by having an administration role. [IBM login POST](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=login-post), [IBM login GET](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=login-get), [IBM messaging requirements](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=messagingqmgrqmgrnamequeuequeuenamemessage-post)

For mutations and messaging reads, `ibm-mq-rest-csrf-token` must be present, but its value can be empty. Administration GET and login POST do not require it. Logout clears the cookie; the mock additionally revokes its token immediately, which is stronger than IBM's signed-token reuse behavior described in the DELETE login reference. [IBM logout](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=login-delete)

## Administration payloads

Basic queue manager response:

```json
{"qmgr":[{"name":"QM1","state":"running"},{"name":"QM2","state":"ended"}]}
```

`attributes=extended` adds installation/default-manager attributes; `status=*` adds running-manager status. Named responses remain arrays. [IBM queue manager GET](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminqmgr-get)

V1 queue create example:

```json
{"name":"APP.IN","type":"local","storage":{"maximumDepth":100},"general":{"description":"Application input"}}
```

POST returns 201 with a Location header and no body. Existing definitions are replaced unless `noReplace` is present; messages are retained. `like` copies an existing definition. PATCH modifies supplied attributes and returns 204; DELETE returns 204 and requires `purge` for a nonempty queue. [IBM queue POST](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminqmgrqmgrnamequeue-post), [IBM queue PATCH](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminqmgrqmgrnamequeue-patch), [IBM queue DELETE](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminqmgrqmgrnamequeue-delete)

V1 GET `/admin/qmgr/QM1/queue/APP.IN?attributes=general,storage&status=status.currentDepth` returns configuration groups and selected status in a `queue` array. `applicationDefaults.messagePriority` and `applicationDefaults.messagePersistence` are the IBM names for queue defaults. Subscription destination queues use `destination.name`; durability uses `general.isDurable`. Full attribute tables were checked against the Administration Reference rather than inferring names from MQSC abbreviations. [IBM queue GET](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminqmgrqmgrnamequeue-get), [Administration Reference](https://public.dhe.ibm.com/software/integration/wmq/docs/V9.4/PDFs/mq94.refadmin.pdf)

The direct channel API lists only TCP sender, receiver, server, requester, cluster-sender, and cluster-receiver channels. MQSC is necessary for server-connection channels used by many developer clients. [IBM channel GET](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminqmgrqmgrnamechannel-get)

## MQSC request and response formats

JSON-form command:

```json
{"type":"runCommandJSON","command":"display","qualifier":"qlocal","name":"APP.IN","responseParameters":["maxdepth"]}
```

Representative mock result:

```json
{"commandResponse":[{"completionCode":0,"reasonCode":0,"parameters":{"queue":"APP.IN","type":"QLOCAL","maxdepth":100}}],"overallCompletionCode":0,"overallReasonCode":0}
```

Plain command wrapper:

```json
{"type":"runCommand","parameters":{"command":"DISPLAY QLOCAL(APP.IN) MAXDEPTH"}}
```

The response is still JSON, with command output inside `commandResponse[].text`. JSON-form DISPLAY uses `parameters`; successful mutations use `message` arrays. An HTTP 200 indicates successful submission and can still contain nonzero command completion codes. The mock reproduces this distinction for missing or duplicate objects. [IBM JSON MQSC](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminactionqmgrqmgrnamemqsc-post-json-formatted-command), [IBM plain MQSC](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminactionqmgrqmgrnamemqsc-post-plain-text-mqsc-command)

JSON flag mapping uses string `yes`: for example, `"replace":"yes"`. The opposite flag, such as `"noreplace":"yes"`, disables the behavior. Plain MQSC uses bare `REPLACE`, `NOREPLACE`, `SHARE`, `NOSHARE`, `TRIGGER`, and `NOTRIGGER`. This is distinct from ordinary Boolean REST queue attributes. [IBM JSON MQSC parameter mapping](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=adminactionqmgrqmgrnamemqsc-post-json-formatted-command)

The Zowe MQ plug-in's system-test example uses the `QL` synonym for QLOCAL and the `HARDENBO` and `INDXTYPE` queue attributes. The mock maps the latter attributes to `extended.hardenGetBackout` and `storage.indexType`, including IBM's `none`, `messageId`, `correlationId`, `groupId`, and `messageToken` enum values. They are stored metadata, with no simulated backout logging or physical index. [IBM DEFINE QLOCAL synonym](https://www.ibm.com/docs/en/ibm-mq/9.3.x?topic=queues-define-qlocal-define-new-local-queue), [IBM queue request body attributes](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=post-request-body-attributes-queues)

The optional `zos` MQSC response style reproduces the `CSQN205I` success header and the final `CSQ9022I` local-queue completion text expected by those tests. The processor names and the DEFINE/DELETE `QL` versus DISPLAY `QLOCAL` spelling follow the plug-in's checked-in test expectations and response examples. This client contract is tested through all three REST versions and with the plug-in's unchanged API and CLI system tests; it is not a complete z/OS response simulation or a differential test against live MQ.

## Messaging payloads and headers

POST sends the HTTP body as UTF-8 text, including when Content-Type is `application/json`. Successful POST returns no JSON message object; the assigned message ID is an HTTP response header. Persistence defaults to nonPersistent, expiry to unlimited. Expiry numbers are milliseconds. V1/v2 message priority is 4; v3 uses `asDestination` by default or an explicit 0–9 value. V3 also supports application correlation IDs and typed `ibm-mq-usr` properties. [IBM put message](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=messagingqmgrqmgrnamequeuequeuenamemessage-post)

GET browses the first matching message; DELETE consumes it. Selectors are `messageId` and `correlationId`; DELETE additionally supports `wait` in milliseconds. The body is text, with metadata headers including `ibm-mq-md-messageId`, correlation ID when set, persistence, remaining expiry, and replyTo when set. V3 adds priority and user properties. Incompatible message formats remain on the queue. [IBM browse message](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=messagingqmgrqmgrnamequeuequeuenamemessage-get), [IBM receive message](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=messagingqmgrqmgrnamequeuequeuenamemessage-delete)

V3 message IDs use `ID:` plus 48 hex digits; v1/v2 use just the hex digits. V3 correlation IDs may be prefixed hex or an application string. Message-list responses use an outer `messages` array, containing messageId, optional correlationId, and format. Default list limit is 10; listing an inhibited queue returns an empty list. [IBM message list](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=messagingqmgrqmgrnamequeuequeuenamemessagelist-get)

Topic publishing is available in v2/v3. Topic strings may have multiple slash-delimited levels in the path; encoded delimiters and special characters must be handled. The mock accepts both multi-level and encoded paths and routes to exact-topic local subscription queues. [IBM publish message](https://www.ibm.com/docs/en/ibm-mq/9.4.x?topic=messagingqmgrqmgrnametopictopicstringmessage-post)

## Error and compatibility strategy

REST failures use appropriate HTTP codes and an outer `error` array. Entries contain type, messageId, message, explanation, and action, with completion/reason codes when applicable. MQSC failures are separately represented in commandResponse. The mock uses representative MQWB identifiers and selected MQ reason codes, without reproducing every IBM localized message. [IBM error format](https://www.ibm.com/docs/en/ibm-mq/9.2.x?topic=SSFKSJ_9.2.0/com.ibm.mq.adm.doc/q128280_.html)

Tests exercise HTTP behavior, state transitions, validation failures, authorization, concurrency, expiry, and bounded allocations. OpenAPI documents the implemented subset at `/openapi.json`. Broader MQSC, MFT, gateway, z/OS, binary broker, and distributed transport behavior should be added only with concrete client workflows and verified response fixtures. This implementation has not been differentially tested against a live mqweb server.
