/** `JiraApi` over Jira Cloud's REST v3, with basic auth (bot email and API token). */
import { Config, Effect, Layer, Predicate, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/http'

import { JiraApi, JiraApiError, type JiraApiOperation } from './JiraApi'
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

/** One ADF paragraph per blank-line-separated block of text; no markdown is rendered. */
export const markdownToAdf = (markdown: string) => ({
	version: 1,
	type: 'doc',
	content: markdown
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})

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

/** Base64 of the UTF-8 bytes; `btoa` on the raw string throws on characters outside Latin-1. */
const utf8Base64 = (value: string) => {
	let binary = ''
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte)
	return btoa(binary)
}

/** The base URL must be `https:` with a host: every request carries the bot's credentials. */
const JiraBaseUrl = Schema.String.check(
	Schema.isPattern(/^https:\/\/[^\s/?#]+/i, { message: 'JIRA_BASE_URL must be an https:// URL' }),
)

/** Reads `JIRA_BASE_URL` (https only), `JIRA_BOT_EMAIL`, and `JIRA_API_TOKEN` (redacted) when the layer is built. */
export const JiraApiLive: Layer.Layer<JiraApi, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
	JiraApi,
	Effect.gen(function* () {
		const baseUrl = (yield* Config.schema(JiraBaseUrl, 'JIRA_BASE_URL')).replace(/\/+$/, '')
		const email = yield* Config.String('JIRA_BOT_EMAIL')
		const token = yield* Config.Redacted('JIRA_API_TOKEN')
		const httpClient = yield* HttpClient.HttpClient
		const authorization = () => `Basic ${utf8Base64(`${email}:${Redacted.value(token)}`)}`

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
			postComment: ({ issueKey, markdown }) =>
				HttpClientRequest.post(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`).pipe(
					HttpClientRequest.bodyJson({ body: markdownToAdf(markdown) }),
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
