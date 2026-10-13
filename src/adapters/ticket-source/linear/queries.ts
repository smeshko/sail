// The GraphQL documents the Linear ticket source sends. Only this adapter knows GraphQL (ADR-0007). Each document is named
// by its operation, which is what the transport and its tests route by.

/** The fields of one issue, as FetchIssue and ListIssues both answer it. No e-mail address is asked for. */
const ISSUE_FIELDS = `id identifier title description url priority
      state { id name type position }
      labels { nodes { name } }
      assignee { name }
      comments(first: 100) { nodes { id body createdAt user { name } } pageInfo { hasNextPage endCursor } }
      relations { nodes { type relatedIssue { identifier title url } } }
      attachments { nodes { title url } }`;

/** Reads one ticket by team key and number, with its first page of comments. */
export const FETCH_ISSUE = `query FetchIssue($team: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {
    nodes {
      ${ISSUE_FIELDS}
    }
  }
}`;

/** The next page of one ticket's comments, from a cursor. */
export const FETCH_MORE_COMMENTS = `query FetchMoreComments($id: String!, $after: String!) {
  issue(id: $id) {
    comments(first: 100, after: $after) { nodes { id body createdAt user { name } } pageInfo { hasNextPage endCursor } }
  }
}`;

/** The designated tickets of the team that are in a backlog or unstarted state, a page at a time. */
export const LIST_ISSUES = `query ListIssues($team: String!, $label: String!, $first: Int!, $after: String) {
  issues(
    filter: {
      team: { key: { eq: $team } }
      labels: { name: { eq: $label } }
      state: { type: { in: ["backlog", "unstarted"] } }
    }
    first: $first
    after: $after
  ) {
    nodes {
      ${ISSUE_FIELDS}
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** The team's states, with their types and positions. */
export const TEAM_WORKFLOW_STATES = `query TeamWorkflowStates($team: String!) {
  teams(filter: { key: { eq: $team } }) {
    nodes { states { nodes { id name type position } } }
  }
}`;

/** Moves one ticket to a state. */
export const UPDATE_ISSUE = `mutation UpdateIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { state { id name type position } }
  }
}`;

/** Posts one comment on one ticket. */
export const CREATE_COMMENT = `mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url }
  }
}`;

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

export interface CommentNode {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  /** Null for a comment with no user. */
  readonly user: { readonly name: string } | null;
}

/** A Linear issue node, as FetchIssue and ListIssues answer it. */
export interface IssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly priority: number;
  readonly state: { readonly id: string; readonly name: string; readonly type: string; readonly position: number };
  readonly labels: { readonly nodes: readonly { readonly name: string }[] };
  readonly assignee: { readonly name: string } | null;
  readonly comments: { readonly nodes: readonly CommentNode[]; readonly pageInfo: PageInfo };
  readonly relations: {
    readonly nodes: readonly {
      readonly type: string;
      readonly relatedIssue: { readonly identifier: string; readonly title: string; readonly url: string };
    }[];
  };
  readonly attachments: { readonly nodes: readonly { readonly title: string; readonly url: string }[] };
}

export interface FetchIssueData {
  readonly issues: { readonly nodes: readonly IssueNode[] };
}

export interface ListIssuesData {
  readonly issues: { readonly nodes: readonly IssueNode[]; readonly pageInfo: PageInfo };
}

export interface UpdateIssueData {
  readonly issueUpdate: {
    readonly success: boolean;
    readonly issue: { readonly state: { readonly id: string; readonly name: string; readonly type: string } } | null;
  };
}

export interface CreateCommentData {
  readonly commentCreate: {
    readonly success: boolean;
    readonly comment: { readonly id: string; readonly url: string } | null;
  };
}

export interface FetchMoreCommentsData {
  readonly issue: { readonly comments: { readonly nodes: readonly CommentNode[]; readonly pageInfo: PageInfo } } | null;
}
