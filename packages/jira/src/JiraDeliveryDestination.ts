/**
 * Where a Jira delivery's output goes, saved before the callback runs so a later attempt or a remote
 * worker can reach the same issue. The delivery core stores it as opaque JSON; only Jira reads it.
 */
import type { DeliveryOperationKind } from '@humanlayer/channels-delivery'
import { Schema } from 'effect'

import { JiraIssueRef } from './JiraCallbackEvents'

/** The version of {@link JiraDeliveryDestination}. Bump when it changes shape. */
export const jiraPresentationVersion = 1

/** The issue a delivery replies on. */
export const JiraDeliveryDestination = Schema.TaggedUnion({
	JiraIssue: { issue: JiraIssueRef },
})
export type JiraDeliveryDestination = typeof JiraDeliveryDestination.Type

/** JSON codec for storing the destination. */
export const JiraDeliveryDestinationJson = Schema.toCodecJson(JiraDeliveryDestination)

/** The output operations a Jira issue supports: comments only, no reactions or activity. */
export const jiraSupportedOperations: ReadonlyArray<DeliveryOperationKind> = [
	'PresentOutcome',
	'CreateMessage',
	'UpdateMessage',
	'DeleteMessage',
]
