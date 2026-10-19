# Jira

`@humanlayer/channels-jira` turns Jira Cloud `comment_created` webhooks that mention a bot account into durable issue callbacks. It verifies the `X-Hub-Signature` HMAC, stores accepted events in provider-neutral mailboxes keyed by issue, runs `onMentioned` with the text after the mention, and posts replies as issue comments through `JiraApi`.

Status: experimental. Only authentication and `GET /myself` through the gateway have been checked against a real site (2026-10-19); the payload, signature and mention formats, and the comment and issue calls, are unverified and listed in [ASSUMPTIONS.md](./ASSUMPTIONS.md).

## Configuration

`JiraBot.make` reads:

- `JIRA_CLOUD_ID`: the site's cloud id, a UUID, from `curl -s https://<site>.atlassian.net/_edge/tenant_info`
- `JIRA_API_TOKEN`: the API token of the bot, an Atlassian service account; sent as `Authorization: Bearer <token>` to `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`
- the webhook secret, bot account id and site host, through the `Config` values the application passes

Both halves of the bot build the API layer, so the webhook half needs `JIRA_CLOUD_ID` and `JIRA_API_TOKEN` too.

Register a Jira webhook for `comment_created` with a secret, pointing at `<base>/integrations/jira/webhook`.
