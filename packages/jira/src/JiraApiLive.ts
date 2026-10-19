/** `JiraApi` over Jira Cloud's REST v3 through the Atlassian API gateway, with a Bearer token (service account API token). */
import { Config, Effect, Layer, Predicate, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http'

import { JiraApi, JiraApiError, type JiraApiOperation, type JiraMention } from './JiraApi'
import { commentPlainText, JiraAdfNode } from './JiraComment'

const CommentCreated = Schema.Struct({ id: Schema.NonEmptyString })
const IssueResponse = Schema.Struct({
	key: Schema.String,
	fields: Schema.Struct({
		summary: Schema.String,
		description: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, JiraAdfNode]))),
	}),
})
const MyselfResponse = Schema.Struct({ accountId: Schema.NonEmptyString })

type AdfInline =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'mention'; readonly attrs: { readonly id: string; readonly text: string } }
type AdfParagraph = { readonly type: 'paragraph'; readonly content: ReadonlyArray<AdfInline> }

/**
 * One ADF paragraph per blank-line-separated block of text; no markdown is rendered, and the text only
 * ever becomes `text` nodes (so `[~accountid:...]` or `@name` in it stays text). When `mention` is given,
 * the first paragraph starts with a mention node, then the first block's text after a single space.
 */
export const markdownToAdf = (markdown: string, mention?: JiraMention) => {
	const blocks = markdown
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
	const paragraph = (content: ReadonlyArray<AdfInline>): AdfParagraph => ({ type: 'paragraph', content })
	const text = (value: string): AdfInline => ({ type: 'text', text: value })
	if (Predicate.isUndefined(mention)) {
		return { version: 1, type: 'doc', content: blocks.map((block) => paragraph([text(block)])) }
	}
	const mentionNode: AdfInline = {
		type: 'mention',
		attrs: { id: mention.accountId, text: `@${mention.displayName}` },
	}
	const [first, ...rest] = blocks
	const lead = paragraph(Predicate.isUndefined(first) ? [mentionNode] : [mentionNode, text(` ${first}`)])
	return { version: 1, type: 'doc', content: [lead, ...rest.map((block) => paragraph([text(block)]))] }
}

const secondsPattern = /^\d+$/
const retryAfterMillis = (value: string | undefined) => {
	if (Predicate.isUndefined(value) || !secondsPattern.test(value)) return undefined
	const milliseconds = Number(value) * 1_000
	return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

const statusError = (operation: JiraApiOperation, response: HttpClientResponse.HttpClientResponse) => {
	const retryAfterMs = retryAfterMillis(response.headers['retry-after'])
	const retryable = response.status === 429 || response.status >= 500
	if (Predicate.isUndefined(retryAfterMs)) return JiraApiError.make({ operation, retryable, status: response.status })
	return JiraApiError.make({ operation, retryable, status: response.status, retryAfterMs })
}

const finalError = (operation: JiraApiOperation) => JiraApiError.make({ operation, retryable: false })

/**
 * The cloud id is interpolated into every request path, so only a UUID is accepted: anything else could
 * redirect the bot's token to another path on the gateway.
 */
const JiraCloudId = Schema.String.check(
	Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
		message: 'JIRA_CLOUD_ID must be a UUID',
	}),
)

export type MakeJiraApiLiveOptions = {
	/** The gateway origin; defaults to `https://api.atlassian.com`. Tests point it at a fake. */
	readonly gatewayBaseUrl?: string
}

/**
 * Reads `JIRA_CLOUD_ID` (a UUID) and `JIRA_API_TOKEN` (redacted) when the layer is built, and sends
 * `Authorization: Bearer <token>` to `<gateway>/ex/jira/<cloudId>/rest/api/3/...`.
 */
export const makeJiraApiLive = (
	options: MakeJiraApiLiveOptions = {},
): Layer.Layer<JiraApi, Config.ConfigError, HttpClient.HttpClient> =>
	Layer.effect(
		JiraApi,
		Effect.gen(function* () {
			const gatewayBaseUrl = (options.gatewayBaseUrl ?? 'https://api.atlassian.com').replace(/\/+$/, '')
			const cloudId = yield* Config.schema(JiraCloudId, 'JIRA_CLOUD_ID')
			const token = yield* Config.Redacted('JIRA_API_TOKEN')
			const baseUrl = `${gatewayBaseUrl}/ex/jira/${cloudId}`
			const httpClient = yield* HttpClient.HttpClient
			const authorization = () => `Bearer ${Redacted.value(token)}`

			/** Send a request and decode a 2xx JSON body; transport failures are retryable, decode failures are not. */
			const send = <A, I>(
				operation: JiraApiOperation,
				schema: Schema.Codec<A, I>,
				request: HttpClientRequest.HttpClientRequest,
			) =>
				httpClient
					.execute(
						request.pipe(
							HttpClientRequest.setHeader('authorization', authorization()),
							HttpClientRequest.setHeader('accept', 'application/json'),
						),
					)
					.pipe(
						Effect.mapError(() => JiraApiError.make({ operation, retryable: true })),
						Effect.flatMap((response) =>
							response.status >= 200 && response.status < 300
								? response.json.pipe(
										Effect.flatMap(Schema.decodeUnknownEffect(schema)),
										Effect.mapError(() => finalError(operation)),
									)
								: Effect.fail(statusError(operation, response)),
						),
					)

			return JiraApi.of({
				postComment: ({ issueKey, markdown, mention }) =>
					HttpClientRequest.post(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`).pipe(
						HttpClientRequest.bodyJson({ body: markdownToAdf(markdown, mention) }),
						Effect.mapError(() => finalError('post_comment')),
						Effect.flatMap((request) => send('post_comment', CommentCreated, request)),
						Effect.map(({ id }) => ({ commentId: id })),
						Effect.withSpan('jira.api.post_comment'),
					),
				fetchIssue: (issueKey) =>
					send(
						'fetch_issue',
						IssueResponse,
						HttpClientRequest.get(
							`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description`,
						),
					).pipe(
						Effect.map(({ key, fields }) => ({
							key,
							title: fields.summary,
							description: Predicate.isNullish(fields.description)
								? null
								: commentPlainText(fields.description),
						})),
						Effect.withSpan('jira.api.fetch_issue'),
					),
				myself: () =>
					send('myself', MyselfResponse, HttpClientRequest.get(`${baseUrl}/rest/api/3/myself`)).pipe(
						Effect.map(({ accountId }) => ({ accountId })),
						Effect.withSpan('jira.api.myself'),
					),
			})
		}),
	)

/** `makeJiraApiLive` against the public gateway. */
export const JiraApiLive: Layer.Layer<JiraApi, Config.ConfigError, HttpClient.HttpClient> = makeJiraApiLive()
