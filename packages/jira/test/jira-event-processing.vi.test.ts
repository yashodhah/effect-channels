import { describe, it } from '@effect/vitest'
import {
	DeliveryAdmission,
	deliveryMailboxKey,
	PreparedDeliveryInvocation,
	ProviderEventExecutionFailed,
	ProviderEventHandled,
	ProviderEventIgnored,
	ProviderEventInvalid,
} from '@humanlayer/channels-delivery'
import { Effect, Option, Ref, Schema } from 'effect'
import { vi } from 'vite-plus/test'

import { makeTestDeliveryExecution } from '../../delivery/test/delivery-execution'
import { JiraMentioned } from '../src/JiraCallbackEvents'
import type { JiraCallbackHandlers } from '../src/JiraCallbacks'
import { jiraSupportedOperations } from '../src/JiraDeliveryDestination'
import { JiraBotConfiguration, makeJiraEventProcessor } from '../src/JiraEventProcessor'
import { JiraAccountId, JiraIssueId, jiraIssueResourceId } from '../src/JiraIdentity'
import { readJiraFixture } from './fixtures'

type Handler = NonNullable<JiraCallbackHandlers<unknown, never>['onMentioned']>

const namespace = 'jira-processing-test'
const site = 'example.atlassian.net'
const bot = JiraBotConfiguration.make({ accountId: JiraAccountId.make('5b10ac8d82e05b22cc7d4ef5') })
const resourceId = jiraIssueResourceId({ issueId: JiraIssueId.make('10042') })

const fixturePayload = (fixture: string) => JSON.parse(readJiraFixture(fixture).toString('utf8'))

const admission = (payload: Schema.Json, eventId: string, overrides: Partial<DeliveryAdmission> = {}) =>
	DeliveryAdmission.make({
		namespace,
		provider: 'jira',
		installationId: site,
		resourceId,
		eventId,
		payload,
		...overrides,
	})

const fixtureAdmission = (fixture: string, eventId = fixture) => admission(fixturePayload(fixture), eventId)

/** The mention fixture with a different comment id and text after the mention. */
const mentionWith = (commentId: string, afterMention: string) => {
	const payload = fixturePayload('comment-created-mention.json')
	payload.comment.id = commentId
	payload.comment.body.content[0].content = [
		payload.comment.body.content[0].content[0],
		{ type: 'text', text: ` ${afterMention}` },
	]
	return payload
}

const process = <E>(
	handlers: JiraCallbackHandlers<E, never>,
	admissions: readonly [DeliveryAdmission, ...Array<DeliveryAdmission>],
) =>
	Effect.gen(function* () {
		const test = yield* makeTestDeliveryExecution()
		const result = yield* makeJiraEventProcessor({ namespace, bot, handlers }).process(admissions, test.execution)
		return { result, preparations: yield* Ref.get(test.preparations) }
	})

describe('Jira event batch processing', () => {
	it.effect('runs onMentioned once for a comment that mentions the bot, after preparing', ({ expect }) =>
		Effect.gen(function* () {
			const mention = fixtureAdmission('comment-created-mention.json', 'webhook-1')
			const mailboxKey = deliveryMailboxKey(mention)
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			const { result, preparations } = yield* process({ onMentioned }, [mention])

			expect(result).toEqual(ProviderEventHandled.make({}))
			expect(onMentioned).toHaveBeenCalledOnce()
			const event = onMentioned.mock.calls[0]?.[0]
			expect(Schema.is(JiraMentioned)(event)).toBe(true)
			expect(event?.comment.afterMention.startsWith('/research')).toBe(true)
			expect(event?.comment.afterMention).toBe('/research how should we do this?')
			expect(event?.comment.body).toBe('@slopcodebot /research how should we do this?')
			expect(event?.comment.id).toBe('10100')
			expect(event?.comment.author).toEqual({
				accountId: '557058a1b2c3d4e5f6a7b8c9',
				displayName: 'Alex Example',
			})
			expect(event?.issue).toEqual({ id: '10042', key: 'ABC-7', mailboxKey })
			expect(event?.eventId).toBe('webhook-1')
			expect(preparations).toEqual([
				PreparedDeliveryInvocation.make({
					callback: 'onMentioned',
					presentationVersion: 1,
					destination: { _tag: 'JiraIssue', issue: { id: '10042', key: 'ABC-7', mailboxKey } },
					supportedOperations: jiraSupportedOperations,
					reactionTargets: [],
				}),
			])
		}),
	)

	it.effect('finds a mention nested in a quote', ({ expect }) =>
		Effect.gen(function* () {
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			const { result } = yield* process({ onMentioned }, [
				fixtureAdmission('comment-created-mention-nested.json'),
			])
			expect(result).toEqual(ProviderEventHandled.make({}))
			expect(onMentioned.mock.calls[0]?.[0].comment.afterMention).toBe('/research quoted\nsee above')
		}),
	)

	it.effect('ignores a comment authored by the bot account', ({ expect }) =>
		Effect.gen(function* () {
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			const { result, preparations } = yield* process({ onMentioned }, [
				fixtureAdmission('comment-created-by-bot.json'),
			])
			expect(Schema.is(ProviderEventIgnored)(result)).toBe(true)
			expect(onMentioned).not.toHaveBeenCalled()
			expect(preparations).toEqual([])
		}),
	)

	it.effect('ignores a plain comment without a mention', ({ expect }) =>
		Effect.gen(function* () {
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			const { result, preparations } = yield* process({ onMentioned }, [
				fixtureAdmission('comment-created-plain.json'),
			])
			expect(result).toEqual(ProviderEventIgnored.make({ reason: 'no_activation_event' }))
			expect(onMentioned).not.toHaveBeenCalled()
			expect(preparations).toEqual([])
		}),
	)

	it.effect('ignores a plain string comment body', ({ expect }) =>
		Effect.gen(function* () {
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			const payload = fixturePayload('comment-created-plain.json')
			payload.comment.body = 'a plain string body'
			const { result } = yield* process({ onMentioned }, [admission(payload, 'string-body')])
			expect(Schema.is(ProviderEventIgnored)(result)).toBe(true)
			payload.comment.body = 42
			const unparseable = yield* process({ onMentioned }, [admission(payload, 'number-body')])
			expect(unparseable.result).toEqual(ProviderEventIgnored.make({ reason: 'no_activation_event' }))
			expect(onMentioned).not.toHaveBeenCalled()
		}),
	)

	it.effect('ignores a mention when no handler is configured', ({ expect }) =>
		Effect.gen(function* () {
			const { result, preparations } = yield* process({}, [fixtureAdmission('comment-created-mention.json')])
			expect(result).toEqual(ProviderEventIgnored.make({ reason: 'callback_not_configured' }))
			expect(preparations).toEqual([])
		}),
	)

	it.effect('calls onMentioned once, for the last mention, when a batch has two mentions', ({ expect }) =>
		Effect.gen(function* () {
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			const { result } = yield* process({ onMentioned }, [
				admission(mentionWith('20001', '/research first question'), 'first'),
				fixtureAdmission('comment-created-plain.json', 'plain'),
				admission(mentionWith('20002', '/research second question'), 'second'),
			])
			expect(result).toEqual(ProviderEventHandled.make({}))
			expect(onMentioned).toHaveBeenCalledOnce()
			const event = onMentioned.mock.calls[0]?.[0]
			expect(event?.comment.id).toBe('20002')
			expect(event?.comment.afterMention).toBe('/research second question')
			expect(event?.eventId).toBe('second')
		}),
	)

	it.effect('re-runs the saved callback on a retry without preparing again', ({ expect }) => {
		let calls = 0
		const onMentioned = (): Effect.Effect<void, { readonly retryable: boolean }> =>
			Effect.suspend(() => {
				calls += 1
				return calls === 1 ? Effect.fail({ retryable: true }) : Effect.void
			})
		return Effect.gen(function* () {
			const processor = makeJiraEventProcessor({ namespace, bot, handlers: { onMentioned } })
			const mention = fixtureAdmission('comment-created-mention.json')
			const first = yield* makeTestDeliveryExecution()
			expect(yield* processor.process([mention], first.execution).pipe(Effect.flip)).toEqual(
				ProviderEventExecutionFailed.make({ provider: 'jira', retryable: true, safeCode: 'callback_failed' }),
			)
			const second = yield* first.retry
			expect(Option.map(second.execution.prepared, ({ callback }) => callback)).toEqual(
				Option.some('onMentioned'),
			)
			expect(yield* processor.process([mention], second.execution)).toEqual(ProviderEventHandled.make({}))
			expect(yield* Ref.get(second.preparations)).toEqual([])
			expect(calls).toBe(2)
		})
	})

	it.effect('reports a non-retryable callback failure', ({ expect }) =>
		Effect.gen(function* () {
			const onMentioned = () => Effect.fail({ retryability: 'non_retryable' as const })
			const error = yield* process({ onMentioned }, [fixtureAdmission('comment-created-mention.json')]).pipe(
				Effect.flip,
			)
			expect(error).toEqual(
				ProviderEventExecutionFailed.make({ provider: 'jira', retryable: false, safeCode: 'callback_failed' }),
			)
		}),
	)

	it.effect('rejects a batch for another namespace or issue', ({ expect }) =>
		Effect.gen(function* () {
			const payload = fixturePayload('comment-created-mention.json')
			const onMentioned = vi.fn<Handler>(() => Effect.void)
			expect(
				yield* process({ onMentioned }, [admission(payload, 'x', { namespace: 'other' })]).pipe(Effect.flip),
			).toEqual(ProviderEventInvalid.make({ provider: 'jira', reason: 'identity_mismatch' }))
			expect(
				yield* process({ onMentioned }, [
					admission(payload, 'x', { resourceId: jiraIssueResourceId({ issueId: JiraIssueId.make('99') }) }),
				]).pipe(Effect.flip),
			).toEqual(ProviderEventInvalid.make({ provider: 'jira', reason: 'identity_mismatch' }))
			expect(yield* process({ onMentioned }, [admission({ nope: true }, 'x')]).pipe(Effect.flip)).toEqual(
				ProviderEventInvalid.make({ provider: 'jira', reason: 'invalid_payload' }),
			)
			expect(onMentioned).not.toHaveBeenCalled()
		}),
	)
})
