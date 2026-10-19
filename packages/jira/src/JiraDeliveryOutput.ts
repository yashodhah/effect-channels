/**
 * This file sends a Jira delivery's saved output to Jira.
 *
 * - `PresentOutcome` comments its Markdown on the issue, with any `awaitingInput` options listed after it.
 *   Without Markdown it makes no comment.
 * - `CreateMessage` comments. Its receipt holds the comment id.
 * - Both start the comment with a mention of the destination's saved `replyTo` (the requester), when present.
 * - Everything else (`SetActivity`, `SetMessageReaction`, `UpdateMessage`, `DeleteMessage`, `RenderPlan`,
 *   `AddExternalLink`) is not in `jiraSupportedOperations` and fails as final `unsupported_operation`.
 *
 * A comment is at-least-once: when Jira accepts it but the attempt dies before the store saves the result,
 * the next attempt comments again, and the attempt carries `hadAmbiguousAttempt` (logged). Jira offers no
 * idempotency key for comments.
 */
import {
	DeliveryOutputApplied,
	DeliveryOutputFailed,
	type DeliveryOutcome,
	type ProviderOutputAttempt,
	type ProviderOutputProcessor,
} from '@humanlayer/channels-delivery'
import { Array as Arr, Effect, Match, Predicate, Schema } from 'effect'

import { JiraApi, type JiraMention } from './JiraApi'
import { JiraDeliveryDestinationJson, jiraPresentationVersion } from './JiraDeliveryDestination'

/** What Jira made for an operation: the comment it posted. Saved by the store, read only here. */
export const JiraOutputReceipt = Schema.TaggedStruct('JiraComment', { comment: Schema.Struct({ id: Schema.String }) })
export type JiraOutputReceipt = typeof JiraOutputReceipt.Type
export const JiraOutputReceiptJson = Schema.toCodecJson(JiraOutputReceipt)

const failed = (safeCode: string, retryable: boolean, retryAfterMs?: number) =>
	new DeliveryOutputFailed(
		Predicate.isUndefined(retryAfterMs)
			? { provider: 'jira', retryable, safeCode }
			: { provider: 'jira', retryable, safeCode, retryAfterMs },
	)

const unsupported = () => failed('unsupported_operation', false)

/** The comment a result posts: its Markdown, then any options as a list. */
const outcomeMarkdown = (outcome: DeliveryOutcome, markdown: string) =>
	Match.value(outcome).pipe(
		Match.tag('AwaitingInput', ({ options }) =>
			Arr.match(options ?? [], {
				onEmpty: () => markdown,
				onNonEmpty: (listed) => `${markdown}\n\n${listed.map((option) => `- ${option}`).join('\n')}`,
			}),
		),
		Match.orElse(() => markdown),
	)

/** Comment on the issue, mentioning `mention` first when given; the receipt holds the comment id. */
const postComment = Effect.fn('jira.output.post_comment')(function* (
	issueKey: string,
	markdown: string,
	mention: JiraMention | undefined,
) {
	const api = yield* JiraApi
	const posted = yield* api
		.postComment(Predicate.isUndefined(mention) ? { issueKey, markdown } : { issueKey, markdown, mention })
		.pipe(
			Effect.tapError((error) => Effect.logWarning('Jira output comment failed', error)),
			Effect.mapError((error) => failed('jira_comment_failed', error.retryable, error.retryAfterMs)),
		)
	const receipt = yield* Schema.encodeEffect(JiraOutputReceiptJson)(
		JiraOutputReceipt.make({ comment: { id: posted.commentId } }),
	).pipe(
		Effect.tapError((error) => Effect.logWarning('Jira output receipt could not be encoded', error)),
		Effect.mapError(() => failed('receipt_unencodable', false)),
	)
	return DeliveryOutputApplied.make({ receipt })
})

/**
 * Build Jira's output half. It reads the `JiraApi` the host supplies when the half is built and sends
 * through it, so the processor itself needs nothing while it runs.
 */
export const makeJiraOutputProcessor = Effect.fn('jira.make_output_processor')(function* (input: {
	readonly namespace: string
}) {
	const jiraApi = yield* JiraApi

	const process = Effect.fn('jira.process_delivery_output')(
		function* (attempt: ProviderOutputAttempt) {
			if (attempt.prepared.presentationVersion !== jiraPresentationVersion) {
				return yield* failed('unsupported_presentation_version', false)
			}
			const destination = yield* Schema.decodeEffect(JiraDeliveryDestinationJson)(
				attempt.prepared.destination,
			).pipe(
				Effect.tapError((error) => Effect.logWarning('Jira output destination could not be read', error)),
				Effect.mapError(() => failed('destination_invalid', false)),
			)
			if (attempt.hadAmbiguousAttempt) {
				yield* Effect.logWarning('Jira output retried after an attempt that may have been applied')
			}
			const issueKey = destination.issue.key
			const mention = destination.replyTo
			yield* Effect.annotateCurrentSpan({ 'jira.issue_key': issueKey })

			return yield* Match.value(attempt.operation).pipe(
				Match.tag('PresentOutcome', (operation) =>
					Predicate.isUndefined(operation.markdown)
						? Effect.succeed(DeliveryOutputApplied.make({}))
						: postComment(issueKey, outcomeMarkdown(operation.outcome, operation.markdown), mention),
				),
				Match.tag('CreateMessage', ({ markdown }) => postComment(issueKey, markdown, mention)),
				Match.orElse(() => Effect.fail(unsupported())),
			)
		},
		(effect, attempt) =>
			effect.pipe(
				Effect.annotateLogs({ delivery_id: attempt.deliveryId, operation_id: attempt.operationId }),
				Effect.provideService(JiraApi, jiraApi),
			),
	)

	return { namespace: input.namespace, providerName: 'jira', process } satisfies ProviderOutputProcessor
})
