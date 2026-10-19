import type { DeliveryCallbackResult, DeliveryContext } from '@humanlayer/channels-delivery'
import { Cause, Effect, Option, Predicate, Schema } from 'effect'

import type { JiraMentioned } from './JiraCallbackEvents'

export const JiraCallbackName = Schema.Literals(['onMentioned'])
export type JiraCallbackName = typeof JiraCallbackName.Type

export const JiraCallbackRetryability = Schema.Struct({
	retryability: Schema.Literals(['retryable', 'non_retryable']),
})
export interface JiraCallbackRetryability extends Schema.Schema.Type<typeof JiraCallbackRetryability> {}

const JiraCallbackRetryableFlag = Schema.Struct({ retryable: Schema.Boolean })

export class JiraCallbackError extends Schema.TaggedError<JiraCallbackError>()('JiraCallbackError', {
	callback: JiraCallbackName,
	retryable: Schema.Boolean,
	reason: Schema.Literals(['failed', 'unexpected']),
}) {}

/**
 * One application callback. `delivery` names the delivery and can hand it to a remote worker; a callback
 * that did so may return the `DeliveryHandoff`. The saved handoff, not the return value, is authoritative.
 */
export type JiraCallbackHandler<A, E, R> = (
	event: A,
	delivery: DeliveryContext,
) => Effect.Effect<DeliveryCallbackResult, E, R>

export type JiraCallbackHandlers<E, R> = {
	readonly onMentioned?: JiraCallbackHandler<JiraMentioned, E, R>
}

const retryableFromCause = (cause: Cause.Cause<unknown>): boolean =>
	Option.match(Cause.findErrorOption(cause), {
		onNone: () => true,
		onSome: (error) => {
			if (Schema.is(JiraCallbackRetryability)(error)) return error.retryability === 'retryable'
			if (Schema.is(JiraCallbackRetryableFlag)(error)) return error.retryable
			return true
		},
	})

const narrowJiraCallbackCause = (input: {
	readonly callback: JiraCallbackName
	readonly cause: Cause.Cause<unknown>
}) => {
	if (Cause.hasInterrupts(input.cause)) {
		const preservedReasons = input.cause.reasons.filter(
			(reason) => Cause.isInterruptReason(reason) || Cause.isDieReason(reason),
		)
		const preserveCause = Effect.failCause(Cause.fromReasons<never>(preservedReasons))
		if (Cause.hasInterruptsOnly(input.cause)) return preserveCause
		return Effect.logError('Jira application callback was interrupted with additional failures', input.cause).pipe(
			Effect.annotateLogs({ callback: input.callback, classification: 'interrupted_with_failure' }),
			Effect.andThen(preserveCause),
		)
	}
	const unexpected = Cause.hasDies(input.cause)
	return Effect.logError('Jira application callback failed', input.cause).pipe(
		Effect.annotateLogs({ callback: input.callback, classification: unexpected ? 'unexpected_defect' : 'failed' }),
		Effect.andThen(
			Effect.fail(
				JiraCallbackError.make({
					callback: input.callback,
					reason: unexpected ? 'unexpected' : 'failed',
					retryable: unexpected ? true : retryableFromCause(input.cause),
				}),
			),
		),
	)
}

const wrapCallback = <A, E, R>(callback: JiraCallbackName, handler: JiraCallbackHandler<A, E, R> | undefined) => {
	if (Predicate.isUndefined(handler)) return undefined
	return Effect.fn(`jira.callbacks.${callback}`)((event: A, delivery: DeliveryContext) =>
		Effect.suspend(() => handler(event, delivery)).pipe(
			Effect.catchCause((cause) => narrowJiraCallbackCause({ callback, cause })),
		),
	)
}

export type JiraCallbackOperations<R = never> = JiraCallbackHandlers<JiraCallbackError, R>

export const makeJiraCallbacks = <E, R>(handlers: JiraCallbackHandlers<E, R>): JiraCallbackOperations<R> => ({
	onMentioned: wrapCallback('onMentioned', handlers.onMentioned),
})
