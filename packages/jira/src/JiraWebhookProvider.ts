import {
	DeliveryAdmission,
	ProviderWebhookEvent,
	ProviderWebhookIgnored,
	WebhookAuthenticationError,
	WebhookPayloadInvalidError,
	type WebhookProvider,
} from '@humanlayer/channels-delivery'
import { Crypto, Effect, Redacted, Schema } from 'effect'

import { jiraIssueResourceId } from './JiraIdentity'
import { JiraCommentCreatedWebhook, JiraWebhookEnvelope, JiraWebhookHeaders } from './JiraWebhookSchemas'
import { verifyJiraWebhookSignature } from './JiraWebhookSignature'

export type JiraWebhookProviderOptions = {
	readonly namespace: string
	readonly webhookSecret: Redacted.Redacted<string>
	/** Jira site host used as the installation id; the payload carries no cloud id. */
	readonly site: string
}

export const makeJiraWebhookProvider = (options: JiraWebhookProviderOptions): WebhookProvider<Crypto.Crypto> => ({
	providerName: 'jira',
	handle: (input) =>
		Effect.gen(function* () {
			const headers = yield* Schema.decodeUnknownEffect(JiraWebhookHeaders)(input.headers).pipe(
				Effect.mapError(() => WebhookAuthenticationError.make({ reason: 'invalid_signature_headers' })),
			)
			yield* verifyJiraWebhookSignature({
				body: input.body,
				signature: headers['x-hub-signature'],
				webhookSecret: options.webhookSecret,
			})
			const unknownPayload = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
				new TextDecoder().decode(input.body),
			).pipe(Effect.mapError(() => WebhookPayloadInvalidError.make({ reason: 'invalid_json' })))
			const envelope = yield* Schema.decodeUnknownEffect(JiraWebhookEnvelope)(unknownPayload).pipe(
				Effect.mapError(() => WebhookPayloadInvalidError.make({ reason: 'invalid_event_envelope' })),
			)
			if (envelope.webhookEvent !== 'comment_created') return ProviderWebhookIgnored.make({})
			const webhook = yield* Schema.decodeUnknownEffect(JiraCommentCreatedWebhook)(unknownPayload).pipe(
				Effect.mapError(() => WebhookPayloadInvalidError.make({ reason: 'invalid_comment_created' })),
			)
			return ProviderWebhookEvent.make({
				event: DeliveryAdmission.make({
					namespace: options.namespace,
					provider: 'jira',
					installationId: options.site,
					resourceId: jiraIssueResourceId({ issueId: webhook.issue.id }),
					eventId: headers['x-atlassian-webhook-identifier'] ?? webhook.comment.id,
					payload: webhook,
				}),
			})
		}),
})
