/** The Jira operations the channel needs. Transport, credentials, and decoding stay behind this service. */
import { Context, type Effect, Schema } from 'effect'

export const JiraApiOperation = Schema.Literals(['post_comment', 'fetch_issue', 'myself'])
export type JiraApiOperation = typeof JiraApiOperation.Type

/**
 * A failed Jira call. `retryable` is true for transport failures, 429, and 5xx; `retryAfterMs` comes from
 * `Retry-After`. It never carries credentials or response bodies.
 */
export class JiraApiError extends Schema.TaggedError<JiraApiError>()('JiraApiError', {
	operation: JiraApiOperation,
	retryable: Schema.Boolean,
	status: Schema.optionalKey(Schema.Int),
	retryAfterMs: Schema.optionalKey(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
	),
}) {}

/** An account a comment mentions. */
export type JiraMention = {
	readonly accountId: string
	readonly displayName: string
}

export type JiraIssueInfo = {
	readonly key: string
	readonly title: string
	readonly description: string | null
}

export type JiraApiOperations = {
	/**
	 * Comment on an issue. Each blank-line-separated block of `markdown` becomes one plain-text paragraph;
	 * nothing in `markdown` ever becomes a mention. `mention`, when given, starts the first paragraph with an
	 * ADF mention of that account; it must come from a structural source (a webhook's author), never from text.
	 */
	readonly postComment: (input: {
		readonly issueKey: string
		readonly markdown: string
		readonly mention?: JiraMention
	}) => Effect.Effect<{ readonly commentId: string }, JiraApiError>
	readonly fetchIssue: (issueKey: string) => Effect.Effect<JiraIssueInfo, JiraApiError>
	/** The account the credentials belong to. */
	readonly myself: () => Effect.Effect<{ readonly accountId: string }, JiraApiError>
}

/** Application-wide Jira operations; `JiraApiLive` provides them. */
export class JiraApi extends Context.Service<JiraApi, JiraApiOperations>()('@humanlayer/channels-jira/JiraApi') {}
