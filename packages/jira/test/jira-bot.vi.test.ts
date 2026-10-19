import { describe, it } from '@effect/vitest'
import { QueueDeliveryMode } from '@humanlayer/channels-delivery'
import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect'

import { JiraAccountId, JiraBot } from '../src'

const noConfiguration = ConfigProvider.layer(ConfigProvider.fromUnknown({}))

describe('JiraBot.make', () => {
	it.effect('names the provider jira and has an output processor', ({ expect }) =>
		Effect.gen(function* () {
			const provider = JiraBot.make({
				webhookSecret: Config.succeed(Redacted.make('secret')),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: { accountId: Schema.decodeSync(JiraAccountId)('5b10') },
				site: Config.succeed('example.atlassian.net'),
				handlers: {},
			})
			expect(provider.providerName).toBe('jira')
			const output = yield* (
				provider.outputProcessor?.({ namespace: 'jira-bot-test' }) ?? Effect.die('no output processor')
			).pipe(Effect.scoped)
			expect(output.providerName).toBe('jira')
		}),
	)

	it.effect('builds the webhook half with only webhookSecret, bot and site configuration', ({ expect }) =>
		Effect.gen(function* () {
			const provider = JiraBot.make({
				webhookSecret: Config.String('JIRA_WEBHOOK_SECRET').pipe(Config.map(Redacted.make)),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: Config.schema(Schema.Struct({ accountId: JiraAccountId }), 'JIRA_BOT'),
				site: Config.String('JIRA_SITE'),
				handlers: {},
			})
			const provided = ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					JIRA_WEBHOOK_SECRET: 's',
					JIRA_BOT: { accountId: '5b10' },
					JIRA_SITE: 'example.atlassian.net',
				}),
			)
			const webhook = yield* provider
				.webhookProvider({ namespace: 'jira-bot-test' })
				.pipe(Effect.scoped, Effect.provide(provided))
			expect(webhook.providerName).toBe('jira')
		}),
	)

	it.effect('reads the bot configuration while building the webhook half', ({ expect }) =>
		Effect.gen(function* () {
			const provider = JiraBot.make({
				webhookSecret: Config.succeed(Redacted.make('s')),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: Config.schema(Schema.Struct({ accountId: JiraAccountId }), 'JIRA_BOT'),
				site: Config.succeed('example.atlassian.net'),
				handlers: {},
			})
			const error = yield* provider
				.webhookProvider({ namespace: 'jira-bot-test' })
				.pipe(Effect.scoped, Effect.provide(noConfiguration), Effect.flip)
			expect(error).toBeInstanceOf(Config.ConfigError)
		}),
	)

	it.effect('builds the event processor from a literal bot without configuration', ({ expect }) =>
		Effect.gen(function* () {
			const provider = JiraBot.make({
				webhookSecret: Config.succeed(Redacted.make('s')),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: { accountId: Schema.decodeSync(JiraAccountId)('5b10') },
				site: Config.succeed('example.atlassian.net'),
				handlers: {},
			})
			const events = yield* provider
				.eventProcessor({ namespace: 'jira-bot-test' })
				.pipe(Effect.scoped, Effect.provide(noConfiguration))
			expect(events.providerName).toBe('jira')
		}),
	)
})
