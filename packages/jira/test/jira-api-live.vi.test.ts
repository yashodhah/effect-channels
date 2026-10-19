import { describe, it } from '@effect/vitest'
import { Config, ConfigProvider, Effect, Layer, Queue } from 'effect'
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from 'effect/http'

import { JiraApi } from '../src/JiraApi'
import { JiraApiLive, makeJiraApiLive } from '../src/JiraApiLive'

const testCredential = 'fake-credential-value'
const cloudId = '11111111-2222-4333-8444-555555555555'
const gateway = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`
const config = {
	JIRA_CLOUD_ID: cloudId,
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

const bearerAuth = `Bearer ${testCredential}`

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
			expect(call.url).toBe(`${gateway}/issue/ABC-1/comment`)
			expect(call.auth).toBe(bearerAuth)
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

	it.effect('sends every operation to the gateway with the Bearer token', ({ expect }) =>
		Effect.gen(function* () {
			const seen = yield* Queue.unbounded<{ method: string; url: string; auth: string | null }>()
			const httpClient = HttpClient.make((request) =>
				Effect.gen(function* () {
					const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
					yield* Queue.offer(seen, {
						method: web.method,
						url: web.url,
						auth: web.headers.get('authorization'),
					})
					const body = request.url.endsWith('/myself')
						? { accountId: '712020:9a62b034-dabf-4364-b257-f4ad41e00a74' }
						: request.method === 'POST'
							? { id: '10001' }
							: { key: 'ABC/1', fields: { summary: 'S' } }
					return HttpClientResponse.fromWeb(request, Response.json(body))
				}),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(httpClient)))
			yield* api.myself()
			yield* api.fetchIssue('ABC/1')
			yield* api.postComment({ issueKey: 'ABC/1', markdown: 'x' })
			const calls = [yield* Queue.take(seen), yield* Queue.take(seen), yield* Queue.take(seen)]
			expect(calls).toEqual([
				{ method: 'GET', url: `${gateway}/myself`, auth: bearerAuth },
				{ method: 'GET', url: `${gateway}/issue/ABC%2F1?fields=summary,description`, auth: bearerAuth },
				{ method: 'POST', url: `${gateway}/issue/ABC%2F1/comment`, auth: bearerAuth },
			])
		}),
	)

	it.effect('accepts a service-account id from myself', ({ expect }) =>
		Effect.gen(function* () {
			const accountId = '712020:9a62b034-dabf-4364-b257-f4ad41e00a74'
			const httpClient = HttpClient.make((request) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						Response.json({ accountId, accountType: 'app', displayName: 'slopcodebot' }),
					),
				),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(httpClient)))
			expect(yield* api.myself()).toEqual({ accountId })
		}),
	)

	it.effect('uses an overridden gateway base', ({ expect }) =>
		Effect.gen(function* () {
			const seen = yield* Queue.unbounded<string>()
			const httpClient = HttpClient.make((request) =>
				Effect.gen(function* () {
					yield* Queue.offer(seen, request.url)
					return HttpClientResponse.fromWeb(request, Response.json({ accountId: '5b10' }))
				}),
			)
			const layer = makeJiraApiLive({ gatewayBaseUrl: 'http://127.0.0.1:9999/' }).pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(HttpClient.HttpClient, httpClient),
						ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
					),
				),
			)
			const api = yield* JiraApi.pipe(Effect.provide(layer))
			yield* api.myself()
			expect(yield* Queue.take(seen)).toBe(`http://127.0.0.1:9999/ex/jira/${cloudId}/rest/api/3/myself`)
		}),
	)

	it.effect('rejects a JIRA_CLOUD_ID that is not a UUID', ({ expect }) =>
		Effect.gen(function* () {
			for (const bad of [
				'',
				'not-a-uuid',
				`${cloudId}/../admin`,
				'../x',
				`${cloudId}?a=b`,
				'example.atlassian.net',
			]) {
				const error = yield* JiraApi.pipe(
					Effect.provide(makeLayer(okClient, { JIRA_CLOUD_ID: bad })),
					Effect.flip,
				)
				expect(error).toBeInstanceOf(Config.ConfigError)
				expect(String(error)).toContain('JIRA_CLOUD_ID')
			}
		}),
	)

	it.effect('names each missing variable in the ConfigError', ({ expect }) =>
		Effect.gen(function* () {
			for (const name of ['JIRA_CLOUD_ID', 'JIRA_API_TOKEN'] as const) {
				const { [name]: _omitted, ...rest } = config
				const error = yield* JiraApi.pipe(
					Effect.provide(
						JiraApiLive.pipe(
							Layer.provide(
								Layer.mergeAll(
									Layer.succeed(HttpClient.HttpClient, okClient),
									ConfigProvider.layer(ConfigProvider.fromUnknown(rest)),
								),
							),
						),
					),
					Effect.flip,
				)
				expect(error).toBeInstanceOf(Config.ConfigError)
				expect(String(error)).toContain(name)
			}
		}),
	)

	it.effect('does not need JIRA_BASE_URL or JIRA_BOT_EMAIL', ({ expect }) =>
		Effect.gen(function* () {
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(okClient)))
			expect(yield* api.myself()).toEqual({ accountId: '5b10' })
		}),
	)

	it.effect('never puts the token in request-error values', ({ expect }) =>
		Effect.gen(function* () {
			const failing = HttpClient.make((request) =>
				Effect.fail(
					new HttpClientError.HttpClientError({
						reason: new HttpClientError.TransportError({ request, description: 'boom' }),
					}),
				),
			)
			const api = yield* JiraApi.pipe(Effect.provide(makeLayer(failing)))
			const error = yield* api.myself().pipe(Effect.flip)
			expect(error.retryable).toBe(true)
			expect(JSON.stringify(error) + String(error)).not.toContain('fake-credential')
		}),
	)
})
