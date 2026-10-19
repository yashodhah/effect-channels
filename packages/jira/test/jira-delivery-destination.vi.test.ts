/** The saved Jira destination: it round-trips with and without the requester, and older saved shapes still decode. */
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'

import { JiraDeliveryDestination, JiraDeliveryDestinationJson, JiraIssueId, jiraPresentationVersion } from '../src'

const issue = { id: Schema.decodeSync(JiraIssueId)('10042'), key: 'ABC-7', mailboxKey: 'jira:v1:mailbox' }

describe('Jira delivery destination', () => {
	it.effect('round-trips a destination with replyTo', ({ expect }) =>
		Effect.gen(function* () {
			const destination = JiraDeliveryDestination.cases.JiraIssue.make({
				issue,
				replyTo: { accountId: '557058a1b2c3d4e5f6a7b8c9', displayName: 'Alex Example' },
			})
			const encoded = yield* Schema.encodeEffect(JiraDeliveryDestinationJson)(destination)
			expect(encoded).toEqual({
				_tag: 'JiraIssue',
				issue: { id: '10042', key: 'ABC-7', mailboxKey: 'jira:v1:mailbox' },
				replyTo: { accountId: '557058a1b2c3d4e5f6a7b8c9', displayName: 'Alex Example' },
			})
			expect(yield* Schema.decodeEffect(JiraDeliveryDestinationJson)(encoded)).toEqual(destination)
		}),
	)

	it.effect('round-trips a destination without replyTo', ({ expect }) =>
		Effect.gen(function* () {
			const destination = JiraDeliveryDestination.cases.JiraIssue.make({ issue })
			const encoded = yield* Schema.encodeEffect(JiraDeliveryDestinationJson)(destination)
			expect(encoded).toEqual({
				_tag: 'JiraIssue',
				issue: { id: '10042', key: 'ABC-7', mailboxKey: 'jira:v1:mailbox' },
			})
			expect(yield* Schema.decodeEffect(JiraDeliveryDestinationJson)(encoded)).toEqual(destination)
		}),
	)

	it.effect('decodes a destination saved before replyTo existed, under the same presentation version', ({ expect }) =>
		Effect.gen(function* () {
			const savedBeforeReplyTo = {
				_tag: 'JiraIssue',
				issue: { id: '10042', key: 'ABC-7', mailboxKey: 'jira:v1:mailbox' },
			}
			const decoded = yield* Schema.decodeEffect(JiraDeliveryDestinationJson)(savedBeforeReplyTo)
			expect(decoded.issue.key).toBe('ABC-7')
			expect(decoded.replyTo).toBeUndefined()
			expect(jiraPresentationVersion).toBe(1)
		}),
	)
})
