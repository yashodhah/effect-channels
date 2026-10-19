import { Schema } from 'effect'

export const JiraAccountId = Schema.NonEmptyString.pipe(Schema.brand('JiraAccountId'))
export type JiraAccountId = typeof JiraAccountId.Type

export const JiraIssueId = Schema.NonEmptyString.pipe(Schema.brand('JiraIssueId'))
export type JiraIssueId = typeof JiraIssueId.Type

export const jiraIssueResourceId = (input: { readonly issueId: JiraIssueId }) =>
	['jira', 'v1', 'issue', input.issueId].map(encodeURIComponent).join(':')
