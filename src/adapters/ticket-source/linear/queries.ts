// The GraphQL documents the Linear ticket source sends. Only this adapter knows GraphQL (ADR-0007). Each document is named
// by its operation, which is what the transport and its tests route by.
// Stub: the documents are written in TASK-003 to TASK-005.

/** Reads one ticket by team key and number, with its first page of comments. */
export const FETCH_ISSUE = '';

/** The next page of one ticket's comments, from a cursor. */
export const FETCH_MORE_COMMENTS = '';

/** The designated tickets of the team that are in a backlog or unstarted state, a page at a time. */
export const LIST_ISSUES = '';

/** The team's states, with their types and positions. */
export const TEAM_WORKFLOW_STATES = '';

/** Moves one ticket to a state. */
export const UPDATE_ISSUE = '';

/** Posts one comment on one ticket. */
export const CREATE_COMMENT = '';
