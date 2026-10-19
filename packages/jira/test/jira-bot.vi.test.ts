import { describe, it } from '@effect/vitest'
import {
	DeliveryAdmission,
	MailboxSubscriptions,
	ProviderEventHandled,
	QueueDeliveryMode,
} from '@humanlayer/channels-delivery'
import { Config, ConfigProvider, Effect, Layer, Redacted, Ref, Schema } from 'effect'

import { makeTestDeliveryExecution } from '../../delivery/test/delivery-execution'
import { JiraAccountId, JiraApi, JiraBot, JiraIssueId, jiraIssueResourceId } from '../src'
import { readJiraFixture } from './fixtures'

const noConfiguration = ConfigProvider.layer(ConfigProvider.fromUnknown({}))
const mockJiraApi = Layer.mock(JiraApi, {})

describe('JiraBot.make', () => {
	it.effect('names the provider jira and has an output processor', ({ expect }) =>
		Effect.gen(function* () {
			const provider = JiraBot.make({
				webhookSecret: Config.succeed(Redacted.make('secret')),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: { accountId: Schema.decodeSync(JiraAccountId)('5b10') },
				site: Config.succeed('example.atlassian.net'),
				jiraApi: mockJiraApi,
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
				jiraApi: mockJiraApi,
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
				jiraApi: mockJiraApi,
				handlers: {},
			})
			const error = yield* provider
				.webhookProvider({ namespace: 'jira-bot-test' })
				.pipe(Effect.scoped, Effect.provide(noConfiguration), Effect.flip)
			expect(error).toBeInstanceOf(Config.ConfigError)
		}),
	)

	it.effect('reads the default API configuration while building the webhook half', ({ expect }) =>
		Effect.gen(function* () {
			const provider = JiraBot.make({
				webhookSecret: Config.succeed(Redacted.make('s')),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: { accountId: Schema.decodeSync(JiraAccountId)('5b10') },
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
				jiraApi: mockJiraApi,
				handlers: {},
			})
			const events = yield* provider
				.eventProcessor({ namespace: 'jira-bot-test' })
				.pipe(Effect.scoped, Effect.provide(noConfiguration))
			expect(events.providerName).toBe('jira')
		}),
	)

	it.effect("supplies the bot's JiraApi to onMentioned", ({ expect }) =>
		Effect.gen(function* () {
			const posted = yield* Ref.make<ReadonlyArray<string>>([])
			const provider = JiraBot.make({
				webhookSecret: Config.succeed(Redacted.make('s')),
				deliveryMode: QueueDeliveryMode.make({}),
				bot: { accountId: Schema.decodeSync(JiraAccountId)('5b10ac8d82e05b22cc7d4ef5') },
				site: Config.succeed('example.atlassian.net'),
				jiraApi: Layer.mock(JiraApi, {
					postComment: ({ issueKey, markdown }) =>
						Ref.update(posted, (all) => [...all, `${issueKey}: ${markdown}`]).pipe(
							Effect.as({ commentId: '900' }),
						),
				}),
				handlers: {
					onMentioned: (event) =>
						Effect.gen(function* () {
							const api = yield* JiraApi
							yield* api.postComment({ issueKey: event.issue.key, markdown: 'On it.' })
						}),
				},
			})
			const events = yield* provider.eventProcessor({ namespace: 'jira-bot-test' }).pipe(Effect.scoped)
			const test = yield* makeTestDeliveryExecution()
			const mention = DeliveryAdmission.make({
				namespace: 'jira-bot-test',
				provider: 'jira',
				installationId: 'example.atlassian.net',
				resourceId: jiraIssueResourceId({ issueId: JiraIssueId.make('10042') }),
				eventId: 'webhook-1',
				payload: JSON.parse(readJiraFixture('comment-created-mention.json').toString('utf8')),
			})
			/** The type says a batch may need subscriptions; Jira's handlers here do not use them. */
			const result = yield* events
				.process([mention], test.execution)
				.pipe(Effect.provide(Layer.mock(MailboxSubscriptions, {})))
			expect(result).toEqual(ProviderEventHandled.make({}))
			expect(yield* Ref.get(posted)).toEqual(['ABC-7: On it.'])
		}),
	)
})
