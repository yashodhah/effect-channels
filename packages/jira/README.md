# Jira

`@humanlayer/channels-jira` turns Jira Cloud `comment_created` webhooks that mention a bot account into durable issue callbacks. It verifies the `X-Hub-Signature` HMAC, stores accepted events in provider-neutral mailboxes keyed by issue, runs `onMentioned` with the text after the mention, and posts replies as issue comments through `JiraApi`.

Status: experimental. No live Jira site has been used; the payload, signature and mention formats it relies on are listed in [ASSUMPTIONS.md](./ASSUMPTIONS.md).

## Configuration

`JiraBot.make` reads:

- `JIRA_BASE_URL`: the site, such as `https://example.atlassian.net` (https only)
- `JIRA_BOT_EMAIL` and `JIRA_API_TOKEN`: basic-auth credentials of the bot account
- the webhook secret, bot account id and site host, through the `Config` values the application passes

Register a Jira webhook for `comment_created` with a secret, pointing at `<base>/integrations/jira/webhook`.
