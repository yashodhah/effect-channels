import { Schema } from 'effect'

import { JiraIssueId } from './JiraIdentity'

/** The issue a delivery is about. `mailboxKey` names the delivery mailbox for that issue. */
export const JiraIssueRef = Schema.Struct({
	id: JiraIssueId,
	key: Schema.String,
	mailboxKey: Schema.String,
})
export type JiraIssueRef = typeof JiraIssueRef.Type

/**
 * A comment that mentions the bot. `body` is the whole comment as plain text; `afterMention` is the text
 * after the bot's first mention, for the application to parse (the package knows nothing of commands).
 */
export const JiraMentioned = Schema.TaggedStruct('JiraMentioned', {
	issue: JiraIssueRef,
	comment: Schema.Struct({
		id: Schema.String,
		body: Schema.String,
		afterMention: Schema.String,
		author: Schema.Struct({ accountId: Schema.String, displayName: Schema.String }),
	}),
	eventId: Schema.String,
})
export type JiraMentioned = typeof JiraMentioned.Type
