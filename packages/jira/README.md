# Jira

`@humanlayer/channels-jira` turns Jira Cloud `comment_created` webhooks that mention a bot account into durable issue callbacks. It verifies the `X-Hub-Signature` HMAC, stores accepted events in provider-neutral mailboxes keyed by issue, runs `onMentioned` with the text after the mention, and posts replies as issue comments through `JiraApi`. A reply starts with an ADF mention of the person whose comment started the delivery (`replyTo` on the saved destination, taken from the signed webhook's comment author; never parsed from text). Jira has no comment reactions or threads, so that mention is how a reply points at its request.

Status: experimental. Only authentication and `GET /myself` through the gateway have been checked against a real site (2026-10-19); the payload, signature and mention formats, and the comment and issue calls, are unverified and listed in [ASSUMPTIONS.md](./ASSUMPTIONS.md).

## Configuration

`JiraBot.make` reads:

- `JIRA_CLOUD_ID`: the site's cloud id, a UUID, from `curl -s https://<site>.atlassian.net/_edge/tenant_info`
- `JIRA_API_TOKEN`: the API token of the bot, an Atlassian service account; sent as `Authorization: Bearer <token>` to `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`
- the webhook secret, bot account id and site host, through the `Config` values the application passes

Both halves of the bot build the API layer, so the webhook half needs `JIRA_CLOUD_ID` and `JIRA_API_TOKEN` too.

Register a Jira webhook for `comment_created` with a secret, pointing at `<base>/integrations/jira/webhook`.
