/** Jira post-admission batch identity validation, mention detection, and callback routing. */
import {
	deliveryMailboxKey,
	type DeliveryAdmission,
	type DeliveryAdmissionBatch,
	type DeliveryContext,
	PreparedDeliveryInvocation,
	type ProviderDeliveryExecution,
	ProviderEventExecutionFailed,
	ProviderEventHandled,
	ProviderEventIgnored,
	ProviderEventInvalid,
	type ProviderEventProcessor,
} from '@humanlayer/channels-delivery'
import { Array as Arr, Effect, Option, Predicate, Schema } from 'effect'

import { JiraIssueRef, JiraMentioned } from './JiraCallbackEvents'
import {
	JiraCallbackName,
	type JiraCallbackHandlers,
	type JiraCallbackOperations,
	makeJiraCallbacks,
} from './JiraCallbacks'
import { commentPlainText, JiraCommentBody, textAfterMention } from './JiraComment'
import {
	JiraDeliveryDestination,
	JiraDeliveryDestinationJson,
	jiraPresentationVersion,
	jiraSupportedOperations,
} from './JiraDeliveryDestination'
import { JiraAccountId, jiraIssueResourceId } from './JiraIdentity'
import { JiraCommentCreatedWebhook } from './JiraWebhookSchemas'

export const JiraBotConfiguration = Schema.Struct({ accountId: JiraAccountId })
export interface JiraBotConfiguration extends Schema.Schema.Type<typeof JiraBotConfiguration> {}

export type JiraEventProcessorOptions = {
	readonly namespace: string
	readonly bot: JiraBotConfiguration
}

const invalidPayload = () => ProviderEventInvalid.make({ provider: 'jira', reason: 'invalid_payload' })
const identityMismatch = () => ProviderEventInvalid.make({ provider: 'jira', reason: 'identity_mismatch' })
const providerFailure = (safeCode: string) =>
	ProviderEventExecutionFailed.make({ provider: 'jira', retryable: true, safeCode })
const nonRetryableFailure = (safeCode: string) =>
	ProviderEventExecutionFailed.make({ provider: 'jira', retryable: false, safeCode })

/** A stored comment webhook with its body parsed, or `None` when the body is neither ADF nor a string. */
type JiraBatchComment = {
	readonly admission: DeliveryAdmission
	readonly webhook: JiraCommentCreatedWebhook
	readonly body: Option.Option<JiraCommentBody>
}

const decodeJiraComment = Effect.fn('jira.decode_comment')(function* (admission: DeliveryAdmission) {
	const webhook = yield* Schema.decodeUnknownEffect(JiraCommentCreatedWebhook)(admission.payload).pipe(
		Effect.tapError((error) => Effect.logError('Stored Jira webhook could not be decoded', error)),
		Effect.mapError(invalidPayload),
	)
	const body = Schema.decodeUnknownOption(JiraCommentBody)(webhook.comment.body)
	/** Warn, so a payload mismatch is visible in production; log the body format only, never the content. */
	const annotations = (bodyFormat: 'unrecognized' | 'wiki_markup') => ({
		eventId: admission.eventId,
		commentId: webhook.comment.id,
		bodyFormat,
	})
	if (Option.isNone(body)) {
		yield* Effect.logWarning('Jira comment body is neither ADF nor text; treating it as no mention').pipe(
			Effect.annotateLogs(annotations('unrecognized')),
		)
	} else if (Predicate.isString(body.value)) {
		yield* Effect.logWarning('Jira comment body is a string, not ADF; reading it as wiki markup').pipe(
			Effect.annotateLogs(annotations('wiki_markup')),
		)
	}
	return { admission, webhook, body }
})

/** Decode every admission and check that the whole batch is about one issue in this namespace. */
const decodeJiraBatch = Effect.fn('jira.decode_event_batch')(function* (
	options: JiraEventProcessorOptions,
	admissions: DeliveryAdmissionBatch,
) {
	const first = admissions[0]
	const comments: ReadonlyArray<JiraBatchComment> = yield* Effect.forEach(admissions, decodeJiraComment)
	const mismatched = comments.some(
		({ admission, webhook }) =>
			admission.namespace !== options.namespace ||
			admission.provider !== 'jira' ||
			admission.installationId !== first.installationId ||
			admission.resourceId !== first.resourceId ||
			jiraIssueResourceId({ issueId: webhook.issue.id }) !== admission.resourceId,
	)
	if (mismatched) return yield* identityMismatch()
	return { first, comments }
})

/** A batch's comments not written by the bot, with the mentions of the bot among them, in mailbox order. */
type JiraBatchEvents = {
	readonly relevant: number
	readonly mentions: ReadonlyArray<JiraMentioned>
}

const toMention = (comment: JiraBatchComment, mailboxKey: string, bot: JiraBotConfiguration) =>
	Option.flatMap(comment.body, (body) => {
		const afterMention = textAfterMention(body, bot.accountId)
		if (afterMention === undefined) return Option.none<JiraMentioned>()
		const { admission, webhook } = comment
		return Option.some(
			JiraMentioned.make({
				issue: JiraIssueRef.make({ id: webhook.issue.id, key: webhook.issue.key, mailboxKey }),
				comment: {
					id: webhook.comment.id,
					body: commentPlainText(body),
					afterMention,
					author: {
						accountId: webhook.comment.author.accountId,
						displayName: webhook.comment.author.displayName ?? webhook.comment.author.accountId,
					},
				},
				eventId: admission.eventId,
			}),
		)
	})

/**
 * Loop prevention: comments written by the bot's account never count, even when they mention the bot.
 * Of the rest, those that mention the bot become `JiraMentioned` events.
 */
const normalizeBatch = (
	first: DeliveryAdmission,
	comments: ReadonlyArray<JiraBatchComment>,
	bot: JiraBotConfiguration,
): JiraBatchEvents => {
	const mailboxKey = deliveryMailboxKey(first)
	const relevant = comments.filter(({ webhook }) => webhook.comment.author.accountId !== bot.accountId)
	return {
		relevant: relevant.length,
		mentions: Arr.getSomes(relevant.map((comment) => toMention(comment, mailboxKey, bot))),
	}
}

/**
 * The mention a batch delivers. When one delivery batches several mentions of the bot, `onMentioned` runs
 * once, for the last: it is the newest request on the issue, and running one callback per delivery keeps
 * a retry's saved choice simple. Earlier mentions in the batch are not delivered separately; they remain
 * comments on the issue for the application to read.
 */
const buildMention = (batch: JiraBatchEvents): Option.Option<JiraMentioned> => Arr.last(batch.mentions)

/** Save the callback choice before any application code runs, so every retry runs the same callback. */
const prepareInvocation = Effect.fn('jira.prepare_delivery')(function* (
	execution: ProviderDeliveryExecution,
	event: JiraMentioned,
) {
	const destination = yield* Schema.encodeEffect(JiraDeliveryDestinationJson)(
		JiraDeliveryDestination.cases.JiraIssue.make({ issue: event.issue }),
	).pipe(
		Effect.tapError((error) => Effect.logError('Jira delivery destination could not be encoded', error)),
		Effect.mapError(() => nonRetryableFailure('delivery_destination_unencodable')),
	)
	const prepared = PreparedDeliveryInvocation.make({
		callback: 'onMentioned',
		presentationVersion: jiraPresentationVersion,
		destination,
		supportedOperations: jiraSupportedOperations,
		reactionTargets: [],
	})
	return yield* execution.prepare(prepared).pipe(
		Effect.tapError((error) =>
			Effect.logError('Jira delivery preparation failed', error).pipe(
				Effect.annotateLogs({ deliveryId: execution.deliveryId, callback: prepared.callback }),
			),
		),
		Effect.catchTags({
			DeliveryPreparationUnavailable: () => Effect.fail(providerFailure('delivery_prepare_unavailable')),
			DeliveryPreparationConflict: () => Effect.fail(nonRetryableFailure('delivery_prepare_conflict')),
		}),
	)
})

/** Run the callback an earlier attempt saved, without choosing again. */
const runPreparedInvocation = Effect.fn('jira.run_prepared_invocation')(function* <R>(input: {
	readonly callbacks: JiraCallbackOperations<R>
	readonly prepared: PreparedDeliveryInvocation
	readonly batch: JiraBatchEvents
	readonly delivery: DeliveryContext
}) {
	const annotations = { deliveryId: input.delivery.deliveryId, callback: input.prepared.callback }
	yield* Schema.decodeUnknownEffect(JiraCallbackName)(input.prepared.callback).pipe(
		Effect.tapError((error) =>
			Effect.logError('Prepared Jira callback is unknown', error).pipe(Effect.annotateLogs(annotations)),
		),
		Effect.mapError(() => nonRetryableFailure('prepared_callback_missing')),
	)
	const onMentioned = input.callbacks.onMentioned
	if (Predicate.isUndefined(onMentioned)) {
		yield* Effect.logError('Prepared Jira callback is no longer configured').pipe(Effect.annotateLogs(annotations))
		return yield* nonRetryableFailure('prepared_callback_missing')
	}
	const event = buildMention(input.batch)
	if (Option.isNone(event)) {
		yield* Effect.logError('Prepared Jira callback cannot be rebuilt from its batch').pipe(
			Effect.annotateLogs(annotations),
		)
		return yield* nonRetryableFailure('prepared_callback_unbuildable')
	}
	return yield* onMentioned(event.value, input.delivery).pipe(
		Effect.mapError((error) =>
			ProviderEventExecutionFailed.make({
				provider: 'jira',
				retryable: error.retryable,
				safeCode: 'callback_failed',
			}),
		),
		Effect.as(ProviderEventHandled.make({})),
	)
})

const processJiraBatch = <R>(options: JiraEventProcessorOptions, callbacks: JiraCallbackOperations<R>) =>
	Effect.fn('jira.process_event_batch')(function* (
		admissions: DeliveryAdmissionBatch,
		execution: ProviderDeliveryExecution,
	) {
		const { first, comments } = yield* decodeJiraBatch(options, admissions)
		const batch = normalizeBatch(first, comments, options.bot)
		const run = (prepared: PreparedDeliveryInvocation) =>
			runPreparedInvocation({
				callbacks,
				prepared,
				batch,
				delivery: execution.context,
			})

		if (Option.isSome(execution.prepared)) return yield* run(execution.prepared.value)
		if (batch.relevant === 0) return ProviderEventIgnored.make({ reason: 'no_relevant_event' })
		const event = buildMention(batch)
		if (Option.isNone(event)) return ProviderEventIgnored.make({ reason: 'no_activation_event' })
		if (Predicate.isUndefined(callbacks.onMentioned)) {
			return ProviderEventIgnored.make({ reason: 'callback_not_configured' })
		}
		return yield* Effect.flatMap(prepareInvocation(execution, event.value), run)
	})

/**
 * Jira's callback half: runs the application's `onMentioned` for each batch. What the handler needs stays
 * in its requirements, for the host to supply.
 */
export const makeJiraEventProcessor = <E, R>(
	options: JiraEventProcessorOptions & { readonly handlers: JiraCallbackHandlers<E, R> },
): ProviderEventProcessor<R> => ({
	namespace: options.namespace,
	providerName: 'jira',
	process: processJiraBatch(options, makeJiraCallbacks(options.handlers)),
})
