/** Jira's output half over a recording `JiraApi`: comments become Jira calls, the rest is unsupported. */
import { describe, it } from '@effect/vitest'
import {
	BatchId,
	CreateMessage,
	ProviderDeleteMessage,
	DeliveryActivity,
	DeliveryOperationId,
	DeliveryOutcome,
	MessageId,
	PreparedDeliveryInvocation,
	ProviderOutputAttempt,
	ProviderPresentOutcome,
	SetActivity,
	makeDeliveryId,
	type ProviderOutputOperation,
} from '@humanlayer/channels-delivery'
import { Effect, Layer, Ref, Result, Schema } from 'effect'

import {
	JiraApi,
	JiraApiError,
	JiraDeliveryDestination,
	JiraIssueId,
	JiraDeliveryDestinationJson,
	jiraPresentationVersion,
	jiraSupportedOperations,
	makeJiraOutputProcessor,
} from '../src'

const destination = JiraDeliveryDestination.cases.JiraIssue.make({
	issue: { id: Schema.decodeSync(JiraIssueId)('10042'), key: 'ABC-7', mailboxKey: 'jira:v1:mailbox' },
})

const prepared = PreparedDeliveryInvocation.make({
	callback: 'onMentioned',
	presentationVersion: jiraPresentationVersion,
	destination: Schema.encodeSync(JiraDeliveryDestinationJson)(destination),
	supportedOperations: jiraSupportedOperations,
	reactionTargets: [],
})

const attempt = (operation: ProviderOutputOperation, hadAmbiguousAttempt = false) =>
	ProviderOutputAttempt.make({
		deliveryId: makeDeliveryId({ mailboxKey: 'jira:v1:mailbox', batchId: BatchId.make('batch-1') }),
		operationId: DeliveryOperationId.make('outcome'),
		attempt: 1,
		hadAmbiguousAttempt,
		idempotencyKey: '00000000-0000-4000-8000-000000000001',
		prepared,
		operation,
	})

const run = (operation: ProviderOutputOperation, fail?: JiraApiError) =>
	Effect.gen(function* () {
		const calls = yield* Ref.make<ReadonlyArray<string>>([])
		const api = Layer.mock(JiraApi, {
			postComment: ({ issueKey, markdown }) =>
				Ref.update(calls, (all) => [...all, `${issueKey}: ${markdown}`]).pipe(
					Effect.andThen(fail === undefined ? Effect.succeed({ commentId: '900' }) : Effect.fail(fail)),
				),
		})
		const processor = yield* makeJiraOutputProcessor({ namespace: 'jira-output-test' }).pipe(Effect.provide(api))
		const result = yield* processor.process(attempt(operation)).pipe(Effect.result)
		return { result, calls: yield* Ref.get(calls) }
	})

const completed = DeliveryOutcome.cases.Completed.make({})

describe('Jira delivery output', () => {
	it.effect('PresentOutcome posts one comment on the destination issue and returns a receipt', ({ expect }) =>
		Effect.gen(function* () {
			const { result, calls } = yield* run(
				ProviderPresentOutcome.make({ clearActivity: true, outcome: completed, markdown: 'Done.' }),
			)
			expect(calls).toEqual(['ABC-7: Done.'])
			expect(Result.isSuccess(result)).toBe(true)
			expect(Result.getOrThrow(result)).toMatchObject({
				_tag: 'DeliveryOutputApplied',
				receipt: { comment: { id: '900' } },
			})
		}),
	)

	it.effect('PresentOutcome and CreateMessage mention the saved requester', ({ expect }) =>
		Effect.gen(function* () {
			const replyTo = { accountId: '557058a1b2c3d4e5f6a7b8c9', displayName: 'Alex Example' }
			const withReplyTo = PreparedDeliveryInvocation.make({
				...prepared,
				destination: yield* Schema.encodeEffect(JiraDeliveryDestinationJson)(
					JiraDeliveryDestination.cases.JiraIssue.make({ issue: destination.issue, replyTo }),
				),
			})
			const inputs = yield* Ref.make<ReadonlyArray<unknown>>([])
			const api = Layer.mock(JiraApi, {
				postComment: (input) =>
					Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as({ commentId: '901' })),
			})
			const processor = yield* makeJiraOutputProcessor({ namespace: 'jira-output-test' }).pipe(
				Effect.provide(api),
			)
			for (const operation of [
				ProviderPresentOutcome.make({ clearActivity: true, outcome: completed, markdown: 'Done.' }),
				CreateMessage.make({ messageId: MessageId.make('m'), markdown: 'Hi' }),
			]) {
				const result = yield* processor
					.process(ProviderOutputAttempt.make({ ...attempt(operation), prepared: withReplyTo }))
					.pipe(Effect.result)
				expect(Result.isSuccess(result)).toBe(true)
			}
			expect(yield* Ref.get(inputs)).toEqual([
				{ issueKey: 'ABC-7', markdown: 'Done.', mention: replyTo },
				{ issueKey: 'ABC-7', markdown: 'Hi', mention: replyTo },
			])
		}),
	)

	it.effect('posts without a mention when the saved destination has no requester', ({ expect }) =>
		Effect.gen(function* () {
			const inputs = yield* Ref.make<ReadonlyArray<unknown>>([])
			const api = Layer.mock(JiraApi, {
				postComment: (input) =>
					Ref.update(inputs, (all) => [...all, input]).pipe(Effect.as({ commentId: '902' })),
			})
			const processor = yield* makeJiraOutputProcessor({ namespace: 'jira-output-test' }).pipe(
				Effect.provide(api),
			)
			yield* processor.process(attempt(CreateMessage.make({ messageId: MessageId.make('m'), markdown: 'Hi' })))
			expect(yield* Ref.get(inputs)).toEqual([{ issueKey: 'ABC-7', markdown: 'Hi' }])
		}),
	)

	it.effect('PresentOutcome without markdown posts nothing', ({ expect }) =>
		Effect.gen(function* () {
			const { result, calls } = yield* run(
				ProviderPresentOutcome.make({ clearActivity: false, outcome: completed }),
			)
			expect(calls).toEqual([])
			expect(Result.isSuccess(result)).toBe(true)
		}),
	)

	it.effect('CreateMessage posts a comment', ({ expect }) =>
		Effect.gen(function* () {
			const { result, calls } = yield* run(CreateMessage.make({ messageId: MessageId.make('m'), markdown: 'Hi' }))
			expect(calls).toEqual(['ABC-7: Hi'])
			expect(Result.isSuccess(result)).toBe(true)
		}),
	)

	it.effect('rejects activity and delete as unsupported and not retryable', ({ expect }) =>
		Effect.gen(function* () {
			for (const operation of [
				SetActivity.make({ activity: DeliveryActivity.cases.Idle.make({}) }),
				ProviderDeleteMessage.make({ messageId: MessageId.make('m'), reference: {} }),
			]) {
				const { result, calls } = yield* run(operation)
				expect(calls).toEqual([])
				expect(Result.getOrThrow(Result.flip(result))).toMatchObject({
					provider: 'jira',
					retryable: false,
					safeCode: 'unsupported_operation',
				})
			}
		}),
	)

	it.effect('maps API failures to retryable or final, with Retry-After', ({ expect }) =>
		Effect.gen(function* () {
			const operation = ProviderPresentOutcome.make({ clearActivity: false, outcome: completed, markdown: 'x' })
			const retry = yield* run(
				operation,
				JiraApiError.make({ operation: 'post_comment', retryable: true, status: 503, retryAfterMs: 5_000 }),
			)
			expect(Result.getOrThrow(Result.flip(retry.result))).toMatchObject({ retryable: true, retryAfterMs: 5_000 })
			const final = yield* run(
				operation,
				JiraApiError.make({ operation: 'post_comment', retryable: false, status: 403 }),
			)
			expect(Result.getOrThrow(Result.flip(final.result))).toMatchObject({ retryable: false })
		}),
	)

	it.effect('rejects a destination version it does not know', ({ expect }) =>
		Effect.gen(function* () {
			const processor = yield* makeJiraOutputProcessor({ namespace: 'jira-output-test' }).pipe(
				Effect.provide(Layer.mock(JiraApi, {})),
			)
			const old = ProviderOutputAttempt.make({
				...attempt(CreateMessage.make({ messageId: MessageId.make('m'), markdown: 'x' })),
				prepared: { ...prepared, presentationVersion: jiraPresentationVersion + 1 },
			})
			const result = yield* processor.process(old).pipe(Effect.result)
			expect(Result.getOrThrow(Result.flip(result))).toMatchObject({ retryable: false })
		}),
	)
})
