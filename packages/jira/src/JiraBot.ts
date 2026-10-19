/**
 * This file defines `JiraBot.make`: the Jira provider as `Channels.make` takes it.
 */
import { type ChannelsProvider, type DeliveryMode } from '@humanlayer/channels-delivery'
import { Effect, Schema } from 'effect'
import type { Config, Redacted } from 'effect'

import type { JiraApi } from './JiraApi'
import { type JiraCallbackHandlers } from './JiraCallbacks'
import { makeJiraOutputProcessor } from './JiraDeliveryOutput'
import { JiraBotConfiguration, makeJiraEventProcessor } from './JiraEventProcessor'
import { makeJiraWebhookProvider } from './JiraWebhookProvider'

/**
 * @property webhookSecret - read when the bot is built, so the bot itself can be declared at the top of a module
 * @property deliveryMode - when an issue's mailbox runs and what each batch holds
 * @property bot - the account id of this bot, whose mentions start a delivery
 * @property site - the Jira site host, used as the installation id
 * @property handlers - the callbacks; the application provides `JiraApi` (usually `JiraApiLive`) and anything
 * else they need, and the storage supplies `MailboxSubscriptions`
 */
export type MakeOptions<E, R> = {
	readonly webhookSecret: Config.Config<Redacted.Redacted<string>>
	readonly deliveryMode: DeliveryMode
	readonly bot: JiraBotConfiguration | Config.Config<JiraBotConfiguration>
	readonly site: Config.Config<string>
	readonly handlers: JiraCallbackHandlers<E, R>
}

export const make = <E, R>(
	options: MakeOptions<E, R>,
): ChannelsProvider<{
	readonly build: never
	readonly process: R | JiraApi
	readonly error: Config.ConfigError
}> => {
	const readBotConfiguration = Schema.is(JiraBotConfiguration)(options.bot)
		? Effect.succeed(options.bot)
		: options.bot

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
			return makeJiraWebhookProvider({ namespace, webhookSecret, site })
		}),
		eventProcessor: Effect.fn('jira.bot.build_event_processor')(function* ({ namespace }) {
			const bot = yield* readBotConfiguration
			return makeJiraEventProcessor({ namespace, bot, handlers: options.handlers })
		}),
		/** Sends a handed-off delivery's output: the comments it posts. */
		outputProcessor: ({ namespace }) => makeJiraOutputProcessor({ namespace }),
	}
}
