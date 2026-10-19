import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { RawWebhookInput } from '@humanlayer/channels-delivery'
import { Headers } from 'effect/http'

export const jiraTestKey = 'jira-test-key'

export const readJiraFixture = (fixture: string) => readFileSync(join(import.meta.dirname, 'fixtures', fixture))

export const signedJiraBody = (
	body: Uint8Array,
	secret: string,
	extraHeaders: Readonly<Record<string, string>> = {},
): RawWebhookInput => ({
	headers: Headers.fromInput({
		'x-hub-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
		...extraHeaders,
	}),
	body,
})

export const signedJiraInput = (
	fixture: string,
	secret: string,
	extraHeaders: Readonly<Record<string, string>> = {},
): RawWebhookInput => signedJiraBody(new Uint8Array(readJiraFixture(fixture)), secret, extraHeaders)
