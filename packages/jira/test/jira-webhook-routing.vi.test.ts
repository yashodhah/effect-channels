import { NodeCrypto } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import {
	DeliveryReceipt,
	MailboxDelivery,
	ProviderWebhookIgnored,
	type ProviderWebhookOutcome,
	WebhookAuthenticationError,
	WebhookPayloadInvalidError,
	webhookRoutes,
} from '@humanlayer/channels-delivery'
import { Context, Effect, Match, Redacted } from 'effect'
import { Headers, HttpRouter } from 'effect/http'

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

	it.effect(
		'admits comment_created with the issue resource and comment_created:<comment.id> as event id',
		({ expect }) =>
			Effect.gen(function* () {
				const first = admitted(yield* handle(signedJiraInput('comment-created-mention.json', jiraTestKey)))
				const second = admitted(yield* handle(signedJiraInput('comment-created-mention.json', jiraTestKey)))
				expect(first.provider).toBe('jira')
				expect(first.namespace).toBe('jira-test')
				expect(first.installationId).toBe('example.atlassian.net')
				expect(first.resourceId).toBe(jiraIssueResourceId({ issueId: JiraIssueId.make('10042') }))
				expect(first.resourceId).toBe('jira:v1:issue:10042')
				expect(first.eventId).toBe('comment_created:10100')
				expect(second.eventId).toBe(first.eventId)
			}),
	)

	it.effect('ignores the unsigned X-Atlassian-Webhook-Identifier header for the event id', ({ expect }) =>
		Effect.gen(function* () {
			const withIdentifier = (identifier: string) =>
				signedJiraInput('comment-created-mention.json', jiraTestKey, {
					'x-atlassian-webhook-identifier': identifier,
				})
			const first = admitted(yield* handle(withIdentifier('delivery-abc')))
			const replay = admitted(yield* handle(withIdentifier('delivery-xyz')))
			expect(first.eventId).toBe('comment_created:10100')
			expect(replay.eventId).toBe(first.eventId)
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
			expect(missing).toEqual(WebhookAuthenticationError.make({ reason: 'invalid_signature_headers' }))
		}),
	)

	it.effect('rejects a body altered after signing', ({ expect }) =>
		Effect.gen(function* () {
			const signed = signedJiraInput('comment-created-mention.json', jiraTestKey)
			const tampered = new TextEncoder().encode(
				new TextDecoder().decode(signed.body).replace('how should we do this?', 'delete everything'),
			)
			expect(tampered).not.toEqual(signed.body)
			const error = yield* handle({ headers: signed.headers, body: tampered }).pipe(Effect.flip)
			expect(error).toEqual(WebhookAuthenticationError.make({ reason: 'invalid_signature' }))
		}),
	)

	it.effect('checks the signature before parsing JSON', ({ expect }) =>
		Effect.gen(function* () {
			const error = yield* handle(signedJiraBody(new TextEncoder().encode('{nope'), 'other')).pipe(Effect.flip)
			expect(error).toEqual(WebhookAuthenticationError.make({ reason: 'invalid_signature' }))
		}),
	)

	it('bounds the webhook body at 1 MiB', ({ expect }) => {
		expect(provider.maxBodyBytes).toBe(1_048_576)
	})

	it.effect('answers 413 for a body over the limit through the webhook routes', ({ expect }) =>
		Effect.gen(function* () {
			const web = HttpRouter.toWebHandler(
				webhookRoutes([provider]).pipe(HttpRouter.provideRequest(NodeCrypto.layer)),
				{ disableLogger: true },
			)
			yield* Effect.addFinalizer(() => Effect.promise(web.dispose))
			const context = Context.make(
				MailboxDelivery,
				MailboxDelivery.of({
					deliver: (event) =>
						Effect.succeed(DeliveryReceipt.make({ mailboxKey: event.resourceId, accepted: true })),
				}),
			)
			const post = (input: ReturnType<typeof signedJiraBody>) =>
				Effect.promise(() =>
					web.handler(
						new Request('http://localhost/integrations/jira/webhook', {
							method: 'POST',
							headers: input.headers,
							body: new TextDecoder().decode(input.body),
						}),
						context,
					),
				)
			const payload = JSON.parse(readJiraFixture('comment-created-mention.json').toString('utf8'))
			const fits = signedJiraInput('comment-created-mention.json', jiraTestKey)
			expect((yield* post(fits)).status).toBe(200)
			const oversized = new TextEncoder().encode(JSON.stringify({ ...payload, padding: 'x'.repeat(1_048_576) }))
			expect((yield* post(signedJiraBody(oversized, jiraTestKey))).status).toBe(413)
		}),
	)
})
