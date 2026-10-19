# Jira channel assumptions

No live Jira site was used. Every item is unverified against a real site. `documented` = stated in Atlassian docs (URL given); `assumed` = inferred, confirm before relying on it.

## (a) Signature
- Header `X-Hub-Signature`, value `method=signature`, e.g. `sha256=<hex>`; HMAC with the hash named by `method`, keyed by the webhook secret. Status: documented. https://developer.atlassian.com/cloud/jira/platform/webhooks/
- Docs examples use sha256. Assumed: HMAC input is the raw request body bytes, hex lowercase. Status: assumed (raw body not stated explicitly in what was read).
- Accept only `sha256` as method; reject others.

## (b) comment_created payload
- Fields: `webhookEvent` ("comment_created" / "comment_updated"), `timestamp` (epoch ms), `comment`, `issue`. Status: documented generically (page has no full example; comment object matches the REST comment shape). Exact `comment.*`/`issue.fields.summary` layout: assumed from REST API v3.
- `comment.body` is ADF (object, `version: 1`, `type: "doc"`) for Jira Cloud REST v3-style payloads. Status: assumed. A string body is read as wiki markup: a mention is written `[~accountid:<id>]` (assumed), counts as a mention of that account, and renders as `@<id>`; other text is kept as is. A string body or one that is neither ADF nor a string is logged at warn with the comment id and body format only.
- `comment.author` has `accountId`, `displayName`, `accountType` (`app` for bots, assumed).

## (c) ADF mention node
- `{ "type": "mention", "attrs": { "id": "<accountId>", "text": "@name", "accessLevel": "" } }` inline in a paragraph. Status: documented in ADF spec https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mention/ (not re-fetched in this task; recalled). Mentions can occur nested in blockquote, list items, etc.; walk the tree recursively.
- The text after the mention (` /research`) is a separate `text` node in the same paragraph.

## (d) Cloud id
- Payload carries no cloud id. Status: assumed (docs show none). The `site` option is the installation id supplied by configuration.

## (e) Stable event id
- Documented: every webhook carries `X-Atlassian-Webhook-Identifier`, unique per tenant and constant across retries; `X-Atlassian-Webhook-Retry` is present on retries; `X-Atlassian-Webhook-Flow` is Primary/Secondary. Source: same webhooks URL.
- Code: the event id is always `comment_created:<comment.id>`, read from the signed body. The identifier header is ignored: it is not covered by the HMAC, so a replayed body with a fresh header would otherwise be admitted as a new event and start a second run. Retries of the same comment dedupe on `comment.id`. Only `comment_created` is admitted; the prefix keeps a later event type for the same comment from colliding.

## (f) REST calls
- `GET /rest/api/3/myself` returns `accountId`, `displayName`. Status: documented (Jira Cloud REST v3), not re-fetched here.
- `POST /rest/api/3/issue/{key}/comment` with body `{ "body": <ADF doc> }`, one `paragraph` node per block; returns the created comment with `id`. Status: documented (REST v3), not re-fetched here. Basic auth (email + API token, encoded as UTF-8 before base64) assumed for the bot. `JIRA_BASE_URL` must be `https://`; anything else fails the layer build with a `ConfigError`.

## Fixtures
`test/fixtures/*.json` are hand-written. Bot: accountId `5b10ac8d82e05b22cc7d4ef5`, name `slopcodebot`. Human author: `557058a1b2c3d4e5f6a7b8c9` (fictional). Issue id `10042`, key `ABC-7`, summary `Add rate limiting`. Site `example.atlassian.net` is a placeholder.
