/**
 * Where a Jira delivery's output goes, saved before the callback runs so a later attempt or a remote
 * worker can reach the same issue. The delivery core stores it as opaque JSON; only Jira reads it.
 */
import type { DeliveryOperationKind } from '@humanlayer/channels-delivery'
import { Schema } from 'effect'

import { JiraIssueRef } from './JiraCallbackEvents'

/**
 * The version of {@link JiraDeliveryDestination}. Bump when it changes shape incompatibly. Adding the
 * optional `replyTo` did not bump it: destinations saved without it still decode.
 */
export const jiraPresentationVersion = 1

/** The person a reply mentions: the author of the comment that started the delivery, from the signed webhook. */
export const JiraReplyTo = Schema.Struct({ accountId: Schema.String, displayName: Schema.String })
export type JiraReplyTo = typeof JiraReplyTo.Type

/**
 * The issue a delivery replies on. `replyTo` is the requester replies start by mentioning; it is optional
 * so destinations saved before it existed still decode (their replies mention no one).
 */
export const JiraDeliveryDestination = Schema.TaggedUnion({
	JiraIssue: { issue: JiraIssueRef, replyTo: Schema.optionalKey(JiraReplyTo) },
})
export type JiraDeliveryDestination = typeof JiraDeliveryDestination.Type

/** JSON codec for storing the destination. */
export const JiraDeliveryDestinationJson = Schema.toCodecJson(JiraDeliveryDestination)

/** The output operations a Jira issue supports: new comments only: no edits, deletes, reactions, or activity. */
export const jiraSupportedOperations: ReadonlyArray<DeliveryOperationKind> = ['PresentOutcome', 'CreateMessage']
