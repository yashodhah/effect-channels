import { describe, it } from '@effect/vitest'
import { Option, Schema } from 'effect'

import {
	commentPlainText,
	type JiraAdfNode,
	JiraCommentBody,
	mentionedAccountIds,
	textAfterMention,
} from '../src/JiraComment'
import { readJiraFixture } from './fixtures'

const botAccountId = '5b10ac8d82e05b22cc7d4ef5'
const otherAccountId = '6c21bd9e93f16c33dd8e5fa6'

const mention = (id: string, text = '@slopcodebot'): JiraAdfNode => ({ type: 'mention', attrs: { id, text } })
const text = (value: string): JiraAdfNode => ({ type: 'text', text: value })
const paragraph = (...content: ReadonlyArray<JiraAdfNode>): JiraAdfNode => ({ type: 'paragraph', content })
const doc = (...content: ReadonlyArray<JiraAdfNode>): JiraAdfNode => ({ type: 'doc', content })

const fixtureBody = (fixture: string): JiraCommentBody =>
	Schema.decodeUnknownSync(JiraCommentBody)(JSON.parse(readJiraFixture(fixture).toString('utf8')).comment.body)

describe('Jira comment parsing', () => {
	it('finds a mention in a top-level paragraph', ({ expect }) => {
		expect(mentionedAccountIds(doc(paragraph(mention(botAccountId), text(' hi'))))).toEqual([botAccountId])
		expect(mentionedAccountIds(fixtureBody('comment-created-mention.json'))).toEqual([botAccountId])
	})

	it('finds a mention inside a quote', ({ expect }) => {
		expect(
			mentionedAccountIds(doc({ type: 'blockquote', content: [paragraph(mention(botAccountId), text(' hi'))] })),
		).toEqual([botAccountId])
		expect(mentionedAccountIds(fixtureBody('comment-created-mention-nested.json'))).toEqual([botAccountId])
	})

	it('finds a mention inside a list item', ({ expect }) => {
		const body = doc({
			type: 'bulletList',
			content: [
				{ type: 'listItem', content: [paragraph(text('first'))] },
				{ type: 'listItem', content: [paragraph(mention(botAccountId), text(' /research list'))] },
			],
		})
		expect(mentionedAccountIds(body)).toEqual([botAccountId])
		expect(textAfterMention(body, botAccountId)).toBe('/research list')
	})

	it('returns the text after the first mention of the account, trimmed', ({ expect }) => {
		expect(textAfterMention(doc(paragraph(mention(botAccountId), text(' /research please'))), botAccountId)).toBe(
			'/research please',
		)
		expect(textAfterMention(fixtureBody('comment-created-mention.json'), botAccountId)).toBe(
			'/research how should we do this?',
		)
		expect(textAfterMention(fixtureBody('comment-created-mention-nested.json'), botAccountId)).toBe(
			'/research quoted\nsee above',
		)
	})

	it('returns undefined when the account is not mentioned', ({ expect }) => {
		expect(textAfterMention(fixtureBody('comment-created-plain.json'), botAccountId)).toBeUndefined()
		expect(mentionedAccountIds(fixtureBody('comment-created-plain.json'))).toEqual([])
	})

	it('does not match a mention of a different account', ({ expect }) => {
		const body = doc(paragraph(mention(otherAccountId, '@someone'), text(' /research nope')))
		expect(mentionedAccountIds(body)).toEqual([otherAccountId])
		expect(textAfterMention(body, botAccountId)).toBeUndefined()
	})

	it('renders plain text with mentions as @name', ({ expect }) => {
		expect(commentPlainText(fixtureBody('comment-created-mention.json'))).toBe(
			'@slopcodebot /research how should we do this?',
		)
		expect(commentPlainText(fixtureBody('comment-created-mention-nested.json'))).toBe(
			'@slopcodebot /research quoted\nsee above',
		)
	})

	it('tolerates a string body without wiki-markup mentions as text without mentions', ({ expect }) => {
		expect(commentPlainText('just text')).toBe('just text')
		expect(mentionedAccountIds('just text')).toEqual([])
		expect(textAfterMention('just text', botAccountId)).toBeUndefined()
	})

	it('finds a wiki-markup [~accountid:] mention of the bot in a string body', ({ expect }) => {
		const body = `[~accountid:${botAccountId}] /research how should we do this?`
		expect(mentionedAccountIds(body)).toEqual([botAccountId])
		expect(textAfterMention(body, botAccountId)).toBe('/research how should we do this?')
		expect(commentPlainText(body)).toBe(`@${botAccountId} /research how should we do this?`)
	})

	it('uses the first wiki-markup mention of the bot and lists every mentioned account once', ({ expect }) => {
		const body = `hey [~accountid:${otherAccountId}] and [~accountid:${botAccountId}] /research a [~accountid:${botAccountId}] b`
		expect(mentionedAccountIds(body)).toEqual([otherAccountId, botAccountId])
		expect(textAfterMention(body, botAccountId)).toBe(`/research a @${botAccountId} b`)
	})

	it('does not match a wiki-markup mention of another account in a string body', ({ expect }) => {
		const body = `[~accountid:${otherAccountId}] /research nope`
		expect(mentionedAccountIds(body)).toEqual([otherAccountId])
		expect(textAfterMention(body, botAccountId)).toBeUndefined()
		expect(commentPlainText(body)).toBe(`@${otherAccountId} /research nope`)
	})

	it('rejects a body that is neither ADF nor a string', ({ expect }) => {
		expect(Option.isNone(Schema.decodeUnknownOption(JiraCommentBody)(null))).toBe(true)
		expect(Option.isNone(Schema.decodeUnknownOption(JiraCommentBody)({ type: 'doc', content: 'x' }))).toBe(true)
	})
})
