/**
 * This file defines `JiraBot.make`: the Jira provider as `Channels.make` takes it.
 */
import {
	type ChannelsProvider,
	type DeliveryAdmissionBatch,
	type DeliveryMode,
	type ProviderDeliveryExecution,
} from '@humanlayer/channels-delivery'
import { Effect, Layer, Predicate, Schema } from 'effect'
import type { Config, Redacted } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import type { JiraApi } from './JiraApi'
import { JiraApiLive } from './JiraApiLive'
import { type JiraCallbackHandlers } from './JiraCallbacks'
import { makeJiraOutputProcessor } from './JiraDeliveryOutput'
import { JiraBotConfiguration, makeJiraEventProcessor } from './JiraEventProcessor'
import { makeJiraWebhookProvider } from './JiraWebhookProvider'

/** `JiraApiLive` over the standard Fetch transport: the default `jiraApi` of `JiraBot.make`. */
const JiraApiFetchLive = JiraApiLive.pipe(Layer.provide(FetchHttpClient.layer))

/**
 * @property webhookSecret - read when the bot is built, so the bot itself can be declared at the top of a module
 * @property deliveryMode - when an issue's mailbox runs and what each batch holds
 * @property bot - the account id of this bot, whose mentions start a delivery
 * @property site - the Jira site host, used as the installation id
 * @property handlers - the callbacks; the bot supplies `JiraApi` to them, the storage supplies
 * `MailboxSubscriptions`, and anything else they need comes from the application
 * @property jiraApi - how the bot talks to Jira; defaults to `JiraApiLive` over Fetch, which reads
 * `JIRA_BASE_URL`, `JIRA_BOT_EMAIL` and `JIRA_API_TOKEN` from the configuration
 */
export type MakeOptions<E, R, ApiError, ApiRequirements> = {
	readonly webhookSecret: Config.Config<Redacted.Redacted<string>>
	readonly deliveryMode: DeliveryMode
	readonly bot: JiraBotConfiguration | Config.Config<JiraBotConfiguration>
	readonly site: Config.Config<string>
	readonly handlers: JiraCallbackHandlers<E, R>
	readonly jiraApi?: Layer.Layer<JiraApi, ApiError, ApiRequirements>
}

export const make = <E, R, ApiError = never, ApiRequirements = never>(
	options: MakeOptions<E, R, ApiError, ApiRequirements>,
): ChannelsProvider<{
	readonly build: ApiRequirements
	readonly process: Exclude<R, JiraApi>
	readonly error: Config.ConfigError | ApiError
}> => {
	const readBotConfiguration = Schema.is(JiraBotConfiguration)(options.bot)
		? Effect.succeed(options.bot)
		: options.bot
	const buildJiraApi = Predicate.isUndefined(options.jiraApi)
		? Layer.build(JiraApiFetchLive)
		: Layer.build(options.jiraApi)

	return {
		providerName: 'jira',
		deliveryMode: options.deliveryMode,
		webhookProvider: Effect.fn('jira.bot.build_webhook_provider')(function* ({ namespace }) {
			const webhookSecret = yield* options.webhookSecret
			const site = yield* options.site
			/**
			 * Split hosts build only this half in the Worker construction phase. Resolve the callback half's
			 * configuration here too, so it can be discovered and bound for the runtime that runs callbacks.
			 */
			yield* readBotConfiguration
			yield* buildJiraApi
			return makeJiraWebhookProvider({ namespace, webhookSecret, site })
		}),
		eventProcessor: Effect.fn('jira.bot.build_event_processor')(function* ({ namespace }) {
			const bot = yield* readBotConfiguration
			const jiraApi = yield* buildJiraApi
			const eventProcessor = makeJiraEventProcessor({ namespace, bot, handlers: options.handlers })
			return {
				namespace: eventProcessor.namespace,
				providerName: eventProcessor.providerName,
				process: (admissions: DeliveryAdmissionBatch, execution: ProviderDeliveryExecution) =>
					eventProcessor.process(admissions, execution).pipe(Effect.provide(jiraApi)),
			}
		}),
		/** Sends a handed-off delivery's output: the comments it posts. */
		outputProcessor: Effect.fn('jira.bot.build_output_processor')(function* ({ namespace }) {
			const jiraApi = yield* buildJiraApi
			return yield* makeJiraOutputProcessor({ namespace }).pipe(Effect.provide(jiraApi))
		}),
	}
}
