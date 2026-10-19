/**
 * Reading a Jira comment body: an Atlassian Document Format (ADF) tree in Jira Cloud payloads, or a
 * string otherwise. A string body is read as wiki markup, where a mention is written `[~accountid:<id>]`
 * and renders as `@<id>`; any other text is kept as it is (see ASSUMPTIONS.md). The webhook schema keeps
 * the body unparsed; decode it with {@link JiraCommentBody} before calling these functions.
 */
import { Predicate, Schema } from 'effect'

/** The parts of an ADF node these functions read. Other node fields are ignored. */
export interface JiraAdfNode {
	readonly type: string
	readonly text?: string
	readonly attrs?: { readonly id?: string; readonly text?: string }
	readonly content?: ReadonlyArray<JiraAdfNode>
}

export const JiraAdfNode: Schema.Codec<JiraAdfNode> = Schema.Struct({
	type: Schema.String,
	text: Schema.optionalKey(Schema.String),
	attrs: Schema.optionalKey(
		Schema.Struct({ id: Schema.optionalKey(Schema.String), text: Schema.optionalKey(Schema.String) }),
	),
	content: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<JiraAdfNode> => JiraAdfNode))),
})

export const JiraCommentBody = Schema.Union([Schema.String, JiraAdfNode])
export type JiraCommentBody = typeof JiraCommentBody.Type

const inlineNodeTypes: ReadonlySet<string> = new Set([
	'text',
	'mention',
	'hardBreak',
	'emoji',
	'inlineCard',
	'date',
	'status',
])

const isInline = (node: JiraAdfNode) => inlineNodeTypes.has(node.type)

const mentionLabel = (node: JiraAdfNode) => {
	const text = node.attrs?.text
	if (text !== undefined && text.length > 0) return text.startsWith('@') ? text : `@${text}`
	return `@${node.attrs?.id ?? ''}`
}

type Rendering = { text: string; mentionOffset: number | undefined }

/** Append `node` as plain text; block siblings are separated by a newline, inline siblings are joined. */
const renderNode = (node: JiraAdfNode, rendering: Rendering, accountId: string | undefined) => {
	if (node.type === 'text') {
		rendering.text += node.text ?? ''
		return
	}
	if (node.type === 'hardBreak') {
		rendering.text += '\n'
		return
	}
	if (node.type === 'mention') {
		rendering.text += mentionLabel(node)
		if (rendering.mentionOffset === undefined && accountId !== undefined && node.attrs?.id === accountId) {
			rendering.mentionOffset = rendering.text.length
		}
		return
	}
	;(node.content ?? []).forEach((child, index) => {
		if (index > 0 && !isInline(child)) rendering.text += '\n'
		renderNode(child, rendering, accountId)
	})
}

/** A wiki-markup user mention, `[~accountid:<id>]`; group 1 is the account id. */
const wikiMention = /\[~accountid:([^\]\s]+)\]/g

/** Render a wiki-markup string body, replacing each mention token with `@<id>`. */
const renderWikiMarkup = (body: string, rendering: Rendering, accountId: string | undefined) => {
	let last = 0
	for (const match of body.matchAll(wikiMention)) {
		const id = match[1] ?? ''
		rendering.text += `${body.slice(last, match.index)}@${id}`
		if (rendering.mentionOffset === undefined && accountId !== undefined && id === accountId) {
			rendering.mentionOffset = rendering.text.length
		}
		last = match.index + match[0].length
	}
	rendering.text += body.slice(last)
}

const render = (body: JiraCommentBody, accountId?: string): Rendering => {
	const rendering: Rendering = { text: '', mentionOffset: undefined }
	if (Predicate.isString(body)) renderWikiMarkup(body, rendering, accountId)
	else renderNode(body, rendering, accountId)
	return rendering
}

/** The comment as plain text, with each ADF mention rendered as `@<displayName>` and each wiki-markup one as `@<id>`. */
export const commentPlainText = (body: JiraCommentBody): string => render(body).text

/** The account ids mentioned anywhere in the body, nested blocks included, in document order without repeats. */
export const mentionedAccountIds = (body: JiraCommentBody): ReadonlyArray<string> => {
	const ids: Array<string> = []
	const walk = (node: JiraAdfNode) => {
		const id = node.attrs?.id
		if (node.type === 'mention' && id !== undefined && !ids.includes(id)) ids.push(id)
		node.content?.forEach(walk)
	}
	if (!Predicate.isString(body)) walk(body)
	else {
		for (const match of body.matchAll(wikiMention)) {
			const id = match[1]
			if (id !== undefined && !ids.includes(id)) ids.push(id)
		}
	}
	return ids
}

/**
 * The plain text after the first mention of `accountId`, through the end of the comment, trimmed; or
 * `undefined` when the comment does not mention that account.
 */
export const textAfterMention = (body: JiraCommentBody, accountId: string): string | undefined => {
	const rendering = render(body, accountId)
	return rendering.mentionOffset === undefined ? undefined : rendering.text.slice(rendering.mentionOffset).trim()
}
