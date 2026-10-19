import { Schema } from 'effect'

import { JiraAccountId, JiraIssueId } from './JiraIdentity'

export const JiraWebhookHeaders = Schema.Struct({
	'x-hub-signature': Schema.NonEmptyString,
	'x-atlassian-webhook-identifier': Schema.optionalKey(Schema.NonEmptyString),
})

export const JiraWebhookEnvelope = Schema.Struct({ webhookEvent: Schema.NonEmptyString })

export const JiraUser = Schema.Struct({
	accountId: JiraAccountId,
	displayName: Schema.optionalKey(Schema.String),
	accountType: Schema.optionalKey(Schema.String),
})
export type JiraUser = typeof JiraUser.Type

/** `body` is an ADF document in Jira Cloud payloads and a plain string otherwise; callers parse it. */
export const JiraComment = Schema.Struct({
	id: Schema.NonEmptyString,
	author: JiraUser,
	body: Schema.Unknown,
})
export type JiraComment = typeof JiraComment.Type

export const JiraIssue = Schema.Struct({
	id: JiraIssueId,
	key: Schema.NonEmptyString,
	fields: Schema.optionalKey(Schema.Struct({ summary: Schema.optionalKey(Schema.String) })),
})
export type JiraIssue = typeof JiraIssue.Type

export const JiraCommentCreatedWebhook = Schema.Struct({
	webhookEvent: Schema.Literal('comment_created'),
	timestamp: Schema.optionalKey(Schema.Finite),
	comment: JiraComment,
	issue: JiraIssue,
})
export type JiraCommentCreatedWebhook = typeof JiraCommentCreatedWebhook.Type
