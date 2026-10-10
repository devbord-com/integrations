# Writing a devbord integration

This page describes what an integration sends to devbord, so you can write one for a game or engine we do not cover.
The existing integrations are working examples: [fivem](https://github.com/devbord-com/fivem) for errors, a heartbeat
and bug reports, and [minecraft](https://github.com/devbord-com/minecraft), [roblox](https://github.com/devbord-com/roblox)
and [unity](https://github.com/devbord-com/unity) for bug reports from players.

An integration can do three things, each on its own:

| What | Becomes | Key |
|---|---|---|
| [Errors](#errors) | An issue under Errors, grouped with equal errors | DSN |
| [Heartbeat](#heartbeat) | A monitor that raises an issue when the server stops reporting | DSN |
| [Bug reports](#bug-reports) | A card on a board | API key with the "Report only" scope |

If an official Sentry SDK exists for your platform, use it with a devbord DSN: devbord speaks the protocol of those
SDKs. Write an integration only where no SDK fits, such as scripting inside a game server.

## The DSN

```
https://<key>@<host>/<project>
```

`<key>` is the public key and `<project>` a number. Errors and check-ins go to:

```
POST https://<host>/api/<project>/store/      one event as JSON
POST https://<host>/api/<project>/envelope/   one or more items, see below
```

Pass the key in one of these ways:

- in the address: `?sentry_key=<key>`
- in a header: `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<key>`
- in the envelope header: `{"dsn":"https://<key>@<host>/<project>"}`

The key can only send; it reads nothing. Still, keep it on the game server and let clients report through the server.
A key that players can read lets anyone fill your quota.

## Errors

The smallest useful event, sent to `/store/`:

```json
{
  "platform": "fivem",
  "level": "error",
  "environment": "production",
  "release": "my-server@1.4.0",
  "server_name": "RP 1",
  "exception": {
    "values": [
      {
        "type": "ScriptError",
        "value": "attempt to index a nil value (local 'player')",
        "stacktrace": {
          "frames": [
            { "filename": "shops/server/main.lua", "function": "handler", "lineno": 12, "in_app": true },
            { "filename": "shops/server/buy.lua", "function": "buyItem", "lineno": 48, "in_app": true }
          ]
        }
      }
    ]
  },
  "tags": { "side": "server", "resource": "shops", "framework": "qbox" },
  "contexts": { "server": { "players": 42, "max_players": 64 } },
  "user": { "id": "license:0123456789abcdef", "username": "Sam" },
  "sdk": { "name": "devbord.fivem", "version": "1.1.0" }
}
```

| Field | Rules |
|---|---|
| `exception.values[]` or `message` | One of both is required. An exception needs a `type` or a `value`. |
| `stacktrace.frames[]` | **Oldest call first, the place of the error last.** Each frame needs a `filename`, `function` or `module`. Send paths relative to the project (`shops/server/buy.lua`), not paths on one machine. |
| `in_app` | `true` for the code of the user, `false` for the engine and libraries. Grouping looks at in-app frames first. |
| `level` | `debug`, `info`, `warning`, `error` or `fatal`. Default `error`. |
| `platform` | A Sentry platform name (`java`, `csharp`, `javascript`, …), needed where devbord has to read the stack of that language. Where none fits, name the game: `fivem`, `redm`, `roblox`, `gmod`. devbord shows it as a badge on the issue. |
| `release` | The version of the code. Needed for "resolved in the next release" and for regressions. |
| `environment` | `production`, `staging`, … |
| `event_id` | Optional, 32 hexadecimal characters. Send it when you retry: the same ID counts once. |
| `timestamp` | Optional, seconds since 1970 or ISO 8601. More than a minute ahead or 30 days back becomes the time of receipt. |
| `tags` | Up to 50. Keys: 1 to 32 characters from `A-Z a-z 0-9 _ . : -`. Values: text up to 200 characters. Issues can be filtered on tags, so use them for facts with few different values. |
| `contexts` | Up to 20 named objects for facts with many values, such as the number of players. |
| `extra` | Free-form data. Values under keys that look like secrets (`password`, `token`, `api_key`, …) are replaced. |
| `user` | `id`, `username`, `name`, `email`. Do not send the IP address of a player. |
| `sdk` | `name` and `version` of the integration. Use `devbord.<platform>` for the name. |

One event is at most 1 MB; a larger one is dropped.

### Answers

| Status | Meaning | What to do |
|---|---|---|
| `200` | Accepted. The body is `{"id":"…"}`. | |
| `400` | The body could not be read. | Fix the integration; do not retry. |
| `401`, `403` | Unknown or disabled key, or error tracking is not in the plan. | Stop sending and tell the server owner once. |
| `413` | Larger than 12 MB. | Do not retry. |
| `429` | Too many events. `Retry-After` holds the seconds to wait: 60 for the limit per minute of the key, 3600 when the monthly total is used up. | Send nothing until then. |

A refusal carries the reason in the header `X-Sentry-Error` and as `detail` in the body. Print it to the server console
once; never raise an error from the integration itself.

### Rules every integration follows

A broken script in a loop produces thousands of errors per minute. The integration, not devbord, has to stop that:

1. **Send the same error once.** Remember each message for about 10 seconds and drop repeats.
2. **Cap what you send**, by default 60 events per minute in total and 5 per minute per player.
3. **Never report your own failures as errors.** A failed request to devbord that is reported as an error loops forever.
4. **Keep the DSN on the server.** Clients send their errors to the game server, which checks the limits and forwards.
5. **Send no IP addresses** and let the server owner choose which player identifier goes along, or none.
6. **Do not block the game.** Send in the background and drop the event when the request fails.

### Context worth sending

These tags make issues of a game server filterable. Use the same names where they apply:

| Tag | Example | |
|---|---|---|
| `side` | `server`, `client` | Where the error happened. |
| `resource` | `shops` | The script, plugin or mod the error came from (`plugin` on Minecraft). |
| `resource.version` | `2.1.0` | Its version. |
| `framework` | `qbox`, `esx` | The framework the server runs. |
| `game` | `gta5`, `rdr3` | When one integration serves more than one game. |
| `game_build`, `artifact` | `3095`, `7290` | Version of the game and of the server software. |

Put counts in the context `server`: `players`, `max_players`, `uptime_minutes`.

## Heartbeat

A check-in tells a monitor that the server is alive. When no check-in arrives within the interval plus the margin,
devbord opens an issue; the next check-in resolves it. Send an envelope with one `check_in` item to `/envelope/`:

```
{}
{"type":"check_in"}
{"monitor_slug":"fivem-server","status":"ok","monitor_config":{"schedule":{"type":"interval","value":1,"unit":"minute"},"checkin_margin":5,"timezone":"UTC","heartbeat":true}}
```

An envelope is lines of JSON separated by a newline: a header (may be `{}`), then for each item a header with its
`type` and the payload. Give the item header a `length` in bytes when the payload itself contains newlines.

| Field | Rules |
|---|---|
| `monitor_slug` | Name of the monitor. Becomes lower case with dashes. Let the server owner set it, so two servers on one project each have their own. |
| `status` | `ok`, `error`, or `in_progress` for a task that has started and reports again when it is done. |
| `duration` | Optional, seconds the task took. |
| `monitor_config` | Creates the monitor on the first check-in. `schedule` is `{"type":"interval","value":1,"unit":"minute"}` (units: `minute`, `hour`, `day`, `week`, `month`, `year`) or `{"type":"crontab","value":"0 3 * * *"}`. `checkin_margin` and `max_runtime` are minutes. `heartbeat: true` marks the monitor as a server that reports in instead of a scheduled job: a missed check-in then reads "Server stopped reporting". After that the owner changes the monitor in devbord, and `monitor_config` is ignored. |

Check-ins do not count towards the monthly total. Choose a margin that covers a restart of the server (5 minutes by
default), or every scheduled restart raises an issue. A project has at most 50 monitors.

A monitor that exists already can also be reported to without an envelope:

```
GET https://<host>/api/<project>/cron/<monitor>/<key>/?status=ok
```

## Bug reports

A report from a player becomes a card. It uses the REST API with an API key with the scope "Report only": such a key
can submit reports and nothing else, and belongs to one list.

```
POST https://<host>/api/v1/reports
Authorization: Bearer db_…
Idempotency-Key: <a random value per report>
```

```json
{
  "description": "The shop door does not open",
  "fingerprint": "shop:door",
  "reporter": { "ref": "license:0123456789abcdef", "name": "Sam" },
  "fields": { "Level": "Docks", "Version": "1.4.2" },
  "logs": "…",
  "priority": "high",
  "labels": ["Bug"],
  "lang": "en"
}
```

| Field | Rules |
|---|---|
| `description` or `title` | One of both is required. Without a title, the first line of the description is used. |
| `fingerprint` | Reports with the same value are collected on one open card instead of making a new one each time. |
| `reporter` | `ref` is your own reference to the player, `name` is shown on the card. |
| `fields` | Extra facts on the card, up to 30. |
| `logs` | Output or a stack trace, shown as a code block. |
| `screenshot` | A JPEG, PNG or WebP image as a base64 data URI; it becomes the cover of the card. |
| `priority` | `low`, `normal`, `high` or `urgent`. |

The answer is `201` for a new card and `200` when the report joined an existing one, with `number`, `duplicate` and a
`receipt`. Keep the receipt: `GET /api/v1/reports/<receipt>` or `POST /api/v1/reports/status` with
`{"receipts":[…]}` (up to 100) returns the state of each, so the game can tell a player that their bug was fixed.

Errors carry a stable `code`: `report_limit` (429, the limit per hour of the key), `report_quota` (402, the reports of
this month are used up), `list_gone` (409, the list of the key no longer exists). Add a cooldown per player on your
side; the examples use 120 seconds.

## Checking your integration

`conformance/` holds a stand-in for devbord that checks every request against this page. It needs Node 18 or later
and nothing else.

```bash
node conformance/server.js
```

It prints a DSN. Configure your integration with it, then trigger an error, the same error in a loop, an error on a
client, and wait for a heartbeat. Each request is printed with what is wrong (`error`: devbord would refuse or drop it)
or weak (`warning`: accepted, but the issue will be less useful). Stop with Ctrl-C for a summary, which also says
whether the integration sent too many events or repeated the same one. The exit code is 1 when a request broke the
protocol.

Run it with `--status 429` to answer every request with a refusal, and check that the integration keeps the game
running, prints the problem once and does not report its own failure as an error.

`conformance/fixtures/` holds the example requests of this page as files, for tests of your own, and
`conformance/check.js` is the checker as a module:

```js
const { checkRequest } = require('./conformance/check');
const result = checkRequest({ method: 'POST', path: '/api/1/store/', query: { sentry_key: 'abc' }, body });
// result.ok, result.problems, result.items[].problems
```

Before you publish: the conformance server prints no errors, the README says which data about players is sent, and the
integration has run on a real server, not only against the stand-in.
