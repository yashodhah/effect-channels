import { describe, it } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer, Queue } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { JiraApi } from '../src/JiraApi'
import { JiraApiLive } from '../src/JiraApiLive'

const testCredential = 'fake-credential-value'
const config = {
	JIRA_BASE_URL: 'https://example.atlassian.net',
	JIRA_BOT_EMAIL: 'bot@example.com',
	JIRA_API_TOKEN: testCredential,
}

const makeLayer = (httpClient: HttpClient.HttpClient, overrides: Readonly<Record<string, string>> = {}) =>
	JiraApiLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(HttpClient.HttpClient, httpClient),
				ConfigProvider.layer(ConfigProvider.fromUnknown({ ...config, ...overrides })),
			),
		),
	)

const okClient = HttpClient.make((request) =>
	Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ accountId: '5b10' }))),
)

const basicAuth = `Basic ${btoa(`bot@example.com:${testCredential}`)}`

describe('JiraApiLive', () => {
	it.effect('posts a comment as an ADF document with one paragraph per block', ({ expect }) =>
		Effect.gen(function* () {
			const seen = yield* Queue.unbounded<{ method: string; url: string; auth: string | null; body: string }>()
			const httpClient = HttpClient.make((request) =>
				Effect.gen(function* () {
					const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
					yield* Queue.offer(seen, {
						method: web.method,
						url: web.url,
						auth: web.headers.get('authorization'),
						body: yield* Effect.promise(() => web.text()),
					})
					return HttpClientResponse.fromWeb(request, Response.json({ id: '10001' }, { status: 201 }))
				}),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(httpClient)))
			const posted = yield* api.postComment({ issueKey: 'ABC-1', markdown: 'a\n\nb' })
			const call = yield* Queue.take(seen)

			expect(posted).toEqual({ commentId: '10001' })
			expect(call.method).toBe('POST')
			expect(call.url).toBe('https://example.atlassian.net/rest/api/3/issue/ABC-1/comment')
			expect(call.auth).toBe(basicAuth)
			expect(JSON.parse(call.body)).toEqual({
				body: {
					version: 1,
					type: 'doc',
					content: [
						{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
						{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
					],
				},
			})
		}),
	)

	it.effect('maps an issue to key, title and plain-text description', ({ expect }) =>
		Effect.gen(function* () {
			const httpClient = HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						Response.json({
							key: 'ABC-1',
							fields: {
								summary: 'Add rate limiting',
								description: {
									version: 1,
									type: 'doc',
									content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Please' }] }],
								},
							},
						}),
					),
				),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(httpClient)))
			expect(yield* api.fetchIssue('ABC-1')).toEqual({
				key: 'ABC-1',
				title: 'Add rate limiting',
				description: 'Please',
			})
		}),
	)

	it.effect('maps a missing description to null and reads myself', ({ expect }) =>
		Effect.gen(function* () {
			const httpClient = HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						request.url.endsWith('/myself')
							? Response.json({ accountId: '5b10', displayName: 'bot' })
							: Response.json({ key: 'ABC-2', fields: { summary: 'S', description: null } }),
					),
				),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(httpClient)))
			expect((yield* api.fetchIssue('ABC-2')).description).toBeNull()
			expect(yield* api.myself()).toEqual({ accountId: '5b10' })
		}),
	)

	it.effect('maps 429 to a retryable error that honors Retry-After', ({ expect }) =>
		Effect.gen(function* () {
			const httpClient = HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
					),
				),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(httpClient)))
			const error = yield* api.postComment({ issueKey: 'ABC-1', markdown: 'x' }).pipe(Effect.flip)
			expect(error).toMatchObject({
				operation: 'post_comment',
				retryable: true,
				retryAfterMs: 7_000,
				status: 429,
			})
		}),
	)

	it.effect('maps 5xx to retryable and other 4xx to non-retryable, never leaking the token', ({ expect }) =>
		Effect.gen(function* () {
			const respond = (status: number) =>
				HttpClient.make((request) =>
					Effect.succeed(HttpClientResponse.fromWeb(request, new Response('no', { status }))),
				)
			const failure = (status: number) =>
				Effect.gen(function* () {
					const api = yield* JiraApi.pipe(Effect.provide(makeLayer(respond(status))))
					return yield* api.myself().pipe(Effect.flip)
				})
			const unavailable = yield* failure(503)
			const forbidden = yield* failure(403)
			expect(unavailable.retryable).toBe(true)
			expect(forbidden.retryable).toBe(false)
			expect(JSON.stringify(unavailable) + String(unavailable) + JSON.stringify(forbidden)).not.toContain(
				'fake-credential',
			)
		}),
	)

	it.effect('fails to build without configuration', ({ expect }) =>
		Effect.gen(function* () {
			const httpClient = HttpClient.make((request) =>
				Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({}))),
			)
			const error = yield* JiraApi.pipe(
				Effect.provide(
					JiraApiLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								Layer.succeed(HttpClient.HttpClient, httpClient),
								ConfigProvider.layer(ConfigProvider.fromUnknown({})),
							),
						),
					),
				),
				Effect.flip,
			)
			expect(error).toBeInstanceOf(Config.ConfigError)
		}),
	)

	it.effect('encodes non-Latin1 credentials as UTF-8 for basic auth', ({ expect }) =>
		Effect.gen(function* () {
			const seen = yield* Queue.unbounded<string | null>()
			const httpClient = HttpClient.make((request) =>
				Effect.gen(function* () {
					const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
					yield* Queue.offer(seen, web.headers.get('authorization'))
					return HttpClientResponse.fromWeb(request, Response.json({ accountId: '5b10' }))
				}),
			)
			const email = 'bøt@exämple.com'
			const credential = 'naïve-crédential-✓'
			const api = yield* JiraApi.pipe(
				Effect.provide(makeLayer(httpClient, { JIRA_BOT_EMAIL: email, JIRA_API_TOKEN: credential })),
			)
			expect(yield* api.myself()).toEqual({ accountId: '5b10' })
			const authorization = yield* Queue.take(seen)
			expect(authorization).toBe(`Basic ${Buffer.from(`${email}:${credential}`, 'utf8').toString('base64')}`)
		}),
	)

	it.effect('requires an https JIRA_BASE_URL', ({ expect }) =>
		Effect.gen(function* () {
			for (const baseUrl of ['http://example.atlassian.net', 'ftp://example.atlassian.net', 'not a url']) {
				const error = yield* JiraApi.pipe(
					Effect.provide(makeLayer(okClient, { JIRA_BASE_URL: baseUrl })),
					Effect.flip,
				)
				expect(error).toBeInstanceOf(Config.ConfigError)
				expect(String(error)).toContain('JIRA_BASE_URL')
			}
			const api = yield* JiraApi.pipe(
				Effect.provide(makeLayer(okClient, { JIRA_BASE_URL: 'https://example.atlassian.net/' })),
			)
			expect(yield* api.myself()).toEqual({ accountId: '5b10' })
		}),
	)
})
