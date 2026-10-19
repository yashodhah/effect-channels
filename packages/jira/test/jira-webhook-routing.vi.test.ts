import { NodeCrypto } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import {
	ProviderWebhookIgnored,
	type ProviderWebhookOutcome,
	WebhookAuthenticationError,
	WebhookPayloadInvalidError,
} from '@humanlayer/channels-delivery'
import { Effect, Match, Redacted } from 'effect'
import { Headers } from 'effect/http'

import { JiraIssueId, jiraIssueResourceId } from '../src/JiraIdentity'
import { makeJiraWebhookProvider } from '../src/JiraWebhookProvider'
import { jiraTestKey, readJiraFixture, signedJiraBody, signedJiraInput } from './fixtures'

const provider = makeJiraWebhookProvider({
	namespace: 'jira-test',
	webhookSecret: Redacted.make(jiraTestKey),
	site: 'example.atlassian.net',
})
const handle = (input: Parameters<typeof provider.handle>[0]) =>
	provider.handle(input).pipe(Effect.provide(NodeCrypto.layer))

const admitted = (outcome: ProviderWebhookOutcome) =>
	Match.value(outcome).pipe(
		Match.tag('Event', ({ event }) => event),
		Match.orElse(() => {
			throw new Error('Expected the webhook to be admitted')
		}),
	)

describe('Jira webhook routing', () => {
	it('serves under the jira provider name', ({ expect }) => {
		expect(provider.providerName).toBe('jira')
	})

	it.effect('admits comment_created with the issue resource and the delivery header as event id', ({ expect }) =>
		Effect.gen(function* () {
			const input = () =>
				signedJiraInput('comment-created-mention.json', jiraTestKey, {
					'x-atlassian-webhook-identifier': 'delivery-abc',
				})
			const first = admitted(yield* handle(input()))
			const second = admitted(yield* handle(input()))
			expect(first.provider).toBe('jira')
			expect(first.namespace).toBe('jira-test')
			expect(first.installationId).toBe('example.atlassian.net')
			expect(first.resourceId).toBe(jiraIssueResourceId({ issueId: JiraIssueId.make('10042') }))
			expect(first.resourceId).toBe('jira:v1:issue:10042')
			expect(first.eventId).toBe('delivery-abc')
			expect(second.eventId).toBe(first.eventId)
		}),
	)

	it.effect('falls back to the comment id when the delivery header is absent', ({ expect }) =>
		Effect.gen(function* () {
			const first = admitted(yield* handle(signedJiraInput('comment-created-mention.json', jiraTestKey)))
			const second = admitted(yield* handle(signedJiraInput('comment-created-mention.json', jiraTestKey)))
			expect(first.eventId).toBe('10100')
			expect(second.eventId).toBe(first.eventId)
		}),
	)

	it.effect('ignores comment_updated', ({ expect }) =>
		Effect.gen(function* () {
			expect(yield* handle(signedJiraInput('comment-updated.json', jiraTestKey))).toEqual(
				ProviderWebhookIgnored.make({}),
			)
		}),
	)

	it.effect('ignores an unsupported webhookEvent', ({ expect }) =>
		Effect.gen(function* () {
			const body = new TextEncoder().encode(JSON.stringify({ webhookEvent: 'jira:issue_updated', timestamp: 1 }))
			expect(yield* handle(signedJiraBody(body, jiraTestKey))).toEqual(ProviderWebhookIgnored.make({}))
		}),
	)

	it.effect('rejects invalid JSON', ({ expect }) =>
		Effect.gen(function* () {
			const error = yield* handle(signedJiraBody(new TextEncoder().encode('{nope'), jiraTestKey)).pipe(
				Effect.flip,
			)
			expect(error).toEqual(WebhookPayloadInvalidError.make({ reason: 'invalid_json' }))
		}),
	)

	it.effect('rejects a bad signature and a missing signature header', ({ expect }) =>
		Effect.gen(function* () {
			const bad = yield* handle(signedJiraInput('comment-created-mention.json', 'other')).pipe(Effect.flip)
			expect(bad).toEqual(WebhookAuthenticationError.make({ reason: 'invalid_signature' }))
			const missing = yield* handle({
				headers: Headers.empty,
				body: new Uint8Array(readJiraFixture('comment-updated.json')),
			}).pipe(Effect.flip)
			expect(missing).toBeInstanceOf(WebhookAuthenticationError)
		}),
	)
})
