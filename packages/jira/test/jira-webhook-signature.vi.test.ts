import { NodeCrypto } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { WebhookAuthenticationError } from '@humanlayer/channels-delivery'
import { Effect, Redacted } from 'effect'

import { verifyJiraWebhookSignature } from '../src/JiraWebhookSignature'
import { signedJiraBody } from './fixtures'

const body = new TextEncoder().encode('{"webhookEvent":"comment_created"}')
const verify = (signature: string, key = 'right-key') =>
	verifyJiraWebhookSignature({ body, signature, webhookSecret: Redacted.make(key) }).pipe(
		Effect.provide(NodeCrypto.layer),
		Effect.flip,
	)
const header = (secret: string) => String(signedJiraBody(body, secret).headers['x-hub-signature'])

describe('Jira webhook signature', () => {
	it.effect('accepts a body signed with the secret', () =>
		verifyJiraWebhookSignature({
			body,
			signature: header('right-key'),
			webhookSecret: Redacted.make('right-key'),
		}).pipe(Effect.provide(NodeCrypto.layer)),
	)

	it.effect('rejects a signature made with another secret', ({ expect }) =>
		Effect.gen(function* () {
			expect(yield* verify(header('wrong-key'))).toEqual(
				WebhookAuthenticationError.make({ reason: 'invalid_signature' }),
			)
		}),
	)

	it.effect('rejects malformed or non-sha256 headers', ({ expect }) =>
		Effect.gen(function* () {
			const expected = WebhookAuthenticationError.make({ reason: 'invalid_signature' })
			expect(yield* verify('')).toEqual(expected)
			expect(yield* verify('sha256=zz')).toEqual(expected)
			expect(yield* verify(header('right-key').replace('sha256=', 'sha1='))).toEqual(expected)
		}),
	)

	it.effect('accepts a body signed with a key longer than the 64-byte HMAC block', ({ expect }) =>
		Effect.gen(function* () {
			const longKey = 'k'.repeat(65) + '-long-test-key'
			expect(new TextEncoder().encode(longKey).length).toBeGreaterThan(64)
			yield* verifyJiraWebhookSignature({
				body,
				signature: header(longKey),
				webhookSecret: Redacted.make(longKey),
			}).pipe(Effect.provide(NodeCrypto.layer))
			expect(yield* verify(header(longKey), `${longKey}x`)).toEqual(
				WebhookAuthenticationError.make({ reason: 'invalid_signature' }),
			)
		}),
	)
})
