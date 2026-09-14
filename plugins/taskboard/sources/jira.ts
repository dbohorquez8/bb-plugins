import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type WorkStateCategory
} from '../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemCreateMetadataInput,
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { TaskboardError, withoutComments } from './types.js';
import { jiraProjectKeysFromJql } from './jira-scope.js';

const jiraIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    fields: z
      .object({
        summary: z.string(),
        description: z.unknown().nullable().optional(),
        updated: z.string(),
        status: z
          .object({
            id: z.string().min(1),
            name: z.string(),
            statusCategory: z.object({ key: z.string() }).passthrough()
          })
          .passthrough(),
        priority: z.object({ name: z.string() }).passthrough().nullable(),
        assignee: z
          .object({
            accountId: z.string().min(1).optional(),
            displayName: z.string()
          })
          .passthrough()
          .nullable(),
        project: z.object({ key: z.string(), name: z.string() }).passthrough(),
        labels: z.array(z.string()),
        comment: z
          .object({
            comments: z.array(
              z
                .object({
                  body: z.unknown(),
                  created: z.string(),
                  author: z.object({ displayName: z.string() }).passthrough()
                })
                .passthrough()
            )
          })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough();

const jiraSearchPageSchema = z
  .object({
    issues: z.array(jiraIssueSchema),
    nextPageToken: z.string().nullable().optional()
  })
  .passthrough();

const jiraJqlMatchSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            matchedIssues: z.array(z.number().int().positive()),
            errors: z.array(z.string())
          })
          .passthrough()
      )
      .length(1)
  })
  .passthrough();

const jiraTransitionsSchema = z
  .object({
    transitions: z.array(
      z
        .object({
          id: z.string().min(1),
          to: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              statusCategory: z.object({ key: z.string() }).passthrough()
            })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraCreatedIssueSchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    key: z.string().min(1),
    self: z.string().optional()
  })
  .passthrough();

const jiraCreateIssueTypesSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    issueTypes: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          subtask: z.boolean().default(false)
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraCreateFieldsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    fields: z.array(
      z
        .object({
          fieldId: z.string().min(1),
          allowedValues: z.array(z.unknown()).optional()
        })
        .passthrough()
    )
  })
  .passthrough();

const jiraAssignableUserSchema = z
  .object({
    accountId: z.string().min(1),
    displayName: z.string().min(1),
    active: z.boolean().optional()
  })
  .passthrough();
const jiraAssignableUsersSchema = z.array(jiraAssignableUserSchema);

const jiraLabelsSchema = z
  .object({
    startAt: z.number().int().nonnegative(),
    maxResults: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    isLast: z.boolean(),
    values: z.array(z.string().min(1))
  })
  .passthrough();

const jiraNamedIdSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1) })
  .passthrough();
const JIRA_CREATE_METADATA_PAGE_SIZE = 200;
const JIRA_LABEL_PAGE_SIZE = 1000;

function nextJiraPageStart(
  page: {
    startAt: number;
    maxResults: number;
    total: number;
    isLast?: boolean;
  },
  requestedStart: number,
  itemCount: number
): number | null {
  if (page.startAt !== requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  if (itemCount === 0 || page.isLast === true) return null;
  const nextStart = page.startAt + page.maxResults;
  if (nextStart >= page.total) return null;
  if (nextStart <= requestedStart) {
    throw new Error('Jira returned an invalid pagination offset');
  }
  return nextStart;
}

function jiraDescription(value: string) {
  return {
    type: 'doc',
    version: 1,
    content: value.split(/\r?\n/u).map(line => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  };
}

function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  const own = typeof record.text === 'string' ? record.text : '';
  const children = Array.isArray(record.content)
    ? record.content.map(adfText).filter(Boolean)
    : [];
  const joined = [own, ...children]
    .filter(Boolean)
    .join(record.type === 'paragraph' || record.type === 'heading' ? '' : '\n');
  return record.type === 'paragraph' || record.type === 'heading'
    ? `${joined}\n`
    : joined;
}

function stateCategory(key: string): WorkStateCategory {
  if (key === 'done') return 'done';
  if (key === 'indeterminate') return 'in_progress';
  return 'todo';
}

function toItem(
  baseUrl: string,
  issue: z.infer<typeof jiraIssueSchema>
): ExternalWorkItemDetail {
  return {
    source: 'jira',
    locator: issue.key,
    key: issue.key,
    title: issue.fields.summary,
    description: adfText(issue.fields.description).trim(),
    url: `${baseUrl}/browse/${encodeURIComponent(issue.key)}`,
    status: issue.fields.status.name,
    stateCategory: stateCategory(issue.fields.status.statusCategory.key),
    priority: issue.fields.priority?.name ?? null,
    assignee: issue.fields.assignee?.displayName ?? null,
    project: issue.fields.project.name,
    labels: issue.fields.labels,
    updatedAt: issue.fields.updated,
    comments: (issue.fields.comment?.comments ?? []).map(comment => ({
      author: comment.author.displayName,
      body: adfText(comment.body).trim(),
      createdAt: comment.created
    }))
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const hasExplicitPort = /^https:\/\/[^/?#]+:\d+(?:[/?#]|$)/iu.test(trimmed);
    if (
      parsed.protocol !== 'https:' ||
      !(
        parsed.hostname === 'atlassian.net' ||
        parsed.hostname.endsWith('.atlassian.net')
      ) ||
      parsed.username ||
      parsed.password ||
      hasExplicitPort ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      return '';
    }
    return parsed.origin;
  } catch {
    return '';
  }
}

async function jiraRequest(
  options: { baseUrl: string; email: string; apiToken: string },
  path: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`,
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' })
      },
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach Jira');
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}`);
  return payload;
}

export function createJiraAdapter(options: {
  enabled: boolean;
  baseUrl: string;
  email: string;
  apiToken: string | undefined;
  jql: string;
}): WorkSourceAdapter {
  const rawBaseUrl = options.baseUrl.trim();
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const email = options.email.trim();
  const apiToken = options.apiToken?.trim() ?? '';
  const hasCredentials = Boolean(baseUrl && email && apiToken);
  const configured = options.enabled && hasCredentials;
  const auth = {
    baseUrl,
    email,
    apiToken
  };

  async function loadIssue(
    locator: string,
    flags: { comments: boolean; verifyScope: boolean }
  ): Promise<z.infer<typeof jiraIssueSchema>> {
    const fields = [
      'summary',
      'description',
      'updated',
      'status',
      'priority',
      'assignee',
      'project',
      'labels',
      ...(flags.comments ? ['comment'] : [])
    ].join(',');
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}?fields=${encodeURIComponent(fields)}`
    );
    const issue = jiraIssueSchema.parse(payload);
    if (issue.key !== locator) {
      throw new Error(`Jira returned the wrong issue for ${locator}`);
    }
    if (!flags.verifyScope) return issue;
    const issueId = Number(issue.id);
    if (!Number.isSafeInteger(issueId)) {
      throw new Error(`Jira returned an invalid issue id for ${locator}`);
    }
    const matchPayload = await jiraRequest(auth, '/rest/api/3/jql/match', {
      method: 'POST',
      body: JSON.stringify({
        issueIds: [issueId],
        jqls: [options.jql.trim()]
      })
    });
    const match = jiraJqlMatchSchema.parse(matchPayload).matches[0];
    if (!match || match.errors.length > 0) {
      throw new Error('Jira could not verify the configured scope');
    }
    if (!match.matchedIssues.includes(issueId)) {
      throw new TaskboardError(
        'out_of_scope',
        `Jira issue ${locator} is outside the configured scope`
      );
    }
    return issue;
  }

  async function transitionOptions(locator: string): Promise<{
    issue: z.infer<typeof jiraIssueSchema>;
    options: Array<ExternalWorkStatusOption & { transitionId: string | null }>;
  }> {
    const issue = await loadIssue(locator, {
      comments: false,
      verifyScope: true
    });
    const payload = await jiraRequest(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`
    );
    const transitions = jiraTransitionsSchema.parse(payload).transitions;
    const available = new Map<
      string,
      ExternalWorkStatusOption & { transitionId: string | null }
    >();
    available.set(issue.fields.status.id, {
      id: issue.fields.status.id,
      name: issue.fields.status.name,
      stateCategory: stateCategory(issue.fields.status.statusCategory.key),
      current: true,
      transitionId: null
    });
    for (const transition of transitions) {
      if (available.has(transition.to.id)) continue;
      available.set(transition.to.id, {
        id: transition.to.id,
        name: transition.to.name,
        stateCategory: stateCategory(transition.to.statusCategory.key),
        current: transition.to.id === issue.fields.status.id,
        transitionId: transition.id
      });
    }
    return { issue, options: [...available.values()] };
  }

  function assertProjectKey(destinationId: string): string {
    const projectKey = destinationId.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]*$/u.test(projectKey)) {
      throw new Error('Enter a valid Jira project key');
    }
    const configuredProjectKeys = jiraProjectKeysFromJql(options.jql);
    if (
      configuredProjectKeys.length > 0 &&
      !configuredProjectKeys.includes(projectKey)
    ) {
      throw new Error(
        `Jira project ${projectKey} is outside the configured JQL scope`
      );
    }
    return projectKey;
  }

  async function createMetadata(input: ExternalWorkItemCreateMetadataInput) {
    const projectKey = assertProjectKey(input.destinationId);
    const issueTypesById = new Map<
      string,
      z.infer<typeof jiraCreateIssueTypesSchema>['issueTypes'][number]
    >();
    let issueTypesStart = 0;
    for (;;) {
      const issueTypesPayload = await jiraRequest(
        auth,
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?startAt=${issueTypesStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
      );
      const page = jiraCreateIssueTypesSchema.parse(issueTypesPayload);
      for (const issueType of page.issueTypes) {
        issueTypesById.set(issueType.id, issueType);
      }
      const nextStart = nextJiraPageStart(
        page,
        issueTypesStart,
        page.issueTypes.length
      );
      if (nextStart === null) break;
      issueTypesStart = nextStart;
    }
    const issueTypes = [...issueTypesById.values()].filter(
      issueType => !issueType.subtask
    );
    const requestedIssueType = input.issueType?.trim() ?? '';
    const selectedIssueType =
      issueTypes.find(issueType => issueType.id === requestedIssueType) ??
      (requestedIssueType
        ? issueTypes.find(
            issueType =>
              issueType.name.toLowerCase() ===
              requestedIssueType.toLowerCase()
          )
        : undefined) ??
      issueTypes.find(issueType => issueType.name.toLowerCase() === 'task') ??
      issueTypes[0] ??
      null;
    if (!selectedIssueType) {
      throw new Error(`Jira project ${projectKey} has no available issue types`);
    }
    const fieldsById = new Map<
      string,
      z.infer<typeof jiraCreateFieldsSchema>['fields'][number]
    >();
    let fieldsStart = 0;
    for (;;) {
      const fieldsPayload = await jiraRequest(
        auth,
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(selectedIssueType.id)}?startAt=${fieldsStart}&maxResults=${JIRA_CREATE_METADATA_PAGE_SIZE}`
      );
      const page = jiraCreateFieldsSchema.parse(fieldsPayload);
      for (const field of page.fields) fieldsById.set(field.fieldId, field);
      const nextStart = nextJiraPageStart(
        page,
        fieldsStart,
        page.fields.length
      );
      if (nextStart === null) break;
      fieldsStart = nextStart;
    }
    const fields = [...fieldsById.values()];
    const byId = new Map(fields.map(field => [field.fieldId, field]));
    const assigneeField = byId.get('assignee');
    const priorityField = byId.get('priority');
    const assigneeAllowed = (assigneeField?.allowedValues ?? [])
      .map(value => jiraAssignableUserSchema.safeParse(value))
      .filter(result => result.success)
      .map(result => result.data);
    const priorityAllowed = (priorityField?.allowedValues ?? [])
      .map(value => jiraNamedIdSchema.safeParse(value))
      .filter(result => result.success)
      .map(result => result.data);
    const [fallbackAssignees, labels] = await Promise.all([
      assigneeField
        ? jiraRequest(
            auth,
            `/rest/api/3/user/assignable/search?project=${encodeURIComponent(projectKey)}&startAt=0&maxResults=1000`
          )
            .then(payload => jiraAssignableUsersSchema.parse(payload))
            .catch(() => [])
        : Promise.resolve([]),
      byId.has('labels')
        ? (async () => {
            const labels = new Set<string>();
            let labelsStart = 0;
            for (;;) {
              const payload = await jiraRequest(
                auth,
                `/rest/api/3/label?startAt=${labelsStart}&maxResults=${JIRA_LABEL_PAGE_SIZE}`
              );
              const page = jiraLabelsSchema.parse(payload);
              for (const label of page.values) labels.add(label);
              const nextStart = nextJiraPageStart(
                page,
                labelsStart,
                page.values.length
              );
              if (nextStart === null) break;
              labelsStart = nextStart;
            }
            return [...labels];
          })().catch(() => [])
        : Promise.resolve([])
    ]);
    const assignees = [
      ...new Map(
        [...assigneeAllowed, ...fallbackAssignees].map(user => [
          user.accountId,
          user
        ])
      ).values()
    ];
    return {
      statusOptions: [],
      assigneeOptions: assignees
        .filter(user => user.active !== false)
        .map(user => ({ id: user.accountId, label: user.displayName })),
      priorityOptions: priorityAllowed.map(priority => ({
        id: priority.id,
        label: priority.name
      })),
      labelOptions: labels.map(label => ({ id: label, label })),
      milestoneOptions: [],
      issueTypeOptions: issueTypes.map(issueType => ({
        id: issueType.id,
        label: issueType.name
      })),
      defaultStatusId: null,
      defaultIssueTypeId: selectedIssueType.id,
      supportsDueDate: byId.has('duedate')
    };
  }

  return {
    source: 'jira',
    configured: () => configured,
    configurationMessage: () =>
      !options.enabled
        ? 'Enable Jira for this BB project in Manage.'
        : rawBaseUrl && !baseUrl
          ? 'Jira Cloud URL must be an HTTPS atlassian.net origin.'
          : hasCredentials
            ? null
            : 'Set the Jira URL, email, and API token for this BB project in Manage.',
    async list() {
      if (!configured) throw new Error('Jira is not configured');
      const issues: z.infer<typeof jiraIssueSchema>[] = [];
      const seenPageTokens = new Set<string>();
      let nextPageToken: string | undefined;
      for (;;) {
        const payload = await jiraRequest(auth, '/rest/api/3/search/jql', {
          method: 'POST',
          body: JSON.stringify({
            jql: options.jql.trim(),
            maxResults: 100,
            fields: [
              'summary',
              'description',
              'updated',
              'status',
              'priority',
              'assignee',
              'project',
              'labels'
            ],
            ...(nextPageToken ? { nextPageToken } : {})
          })
        });
        const page = jiraSearchPageSchema.parse(payload);
        issues.push(...page.issues);
        const token = page.nextPageToken?.trim();
        if (!token) break;
        if (seenPageTokens.has(token)) {
          throw new Error('Jira returned an invalid pagination token');
        }
        seenPageTokens.add(token);
        nextPageToken = token;
      }
      return issues.map(issue => withoutComments(toItem(baseUrl, issue)));
    },
    async get(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const issue = await loadIssue(locator, {
        comments: true,
        verifyScope: true
      });
      return toItem(baseUrl, issue);
    },
    async statusOptions(locator) {
      if (!configured) throw new Error('Jira is not configured');
      const result = await transitionOptions(locator);
      return result.options.map(
        ({ transitionId: _transitionId, ...option }) => option
      );
    },
    async createMetadata(input) {
      if (!configured) throw new Error('Jira is not configured');
      return createMetadata(input);
    },
    async create(input: ExternalWorkItemCreateInput) {
      if (!configured) throw new Error('Jira is not configured');
      const projectKey = assertProjectKey(input.destinationId);
      if (input.statusId !== null) {
        throw new Error('Jira issues are created in the project default status');
      }
      if (input.milestoneId !== null) {
        throw new Error('Jira issues use a due date instead of a milestone');
      }
      if (input.issueType === null) {
        throw new Error('Choose a Jira issue type');
      }
      let created: z.infer<typeof jiraCreatedIssueSchema>;
      try {
        const payload = await jiraRequest(auth, '/rest/api/3/issue', {
          method: 'POST',
          body: JSON.stringify({
            fields: {
              project: { key: projectKey },
              summary: input.title,
              issuetype: { id: input.issueType },
              ...(input.description
                ? { description: jiraDescription(input.description) }
                : {}),
              ...(input.assigneeId
                ? { assignee: { accountId: input.assigneeId } }
                : {}),
              ...(input.priorityId
                ? { priority: { id: input.priorityId } }
                : {}),
              ...(input.labelIds.length > 0
                ? { labels: input.labelIds }
                : {}),
              ...(input.dueDate ? { duedate: input.dueDate } : {})
            }
          })
        });
        created = jiraCreatedIssueSchema.parse(payload);
      } catch {
        throw new Error(
          `${CREATE_OUTCOME_UNCERTAIN_MARKER} Jira may have created the issue, but Taskboard could not confirm the response. Refresh the board and check for it before trying again.`
        );
      }
      try {
        const issue = await loadIssue(created.key, {
          comments: false,
          verifyScope: false
        });
        if (issue.id !== created.id || issue.fields.project.key !== projectKey) {
          throw new Error('Jira returned an invalid new issue');
        }
        return {
          item: toItem(baseUrl, issue),
          warnings: [],
          assigneeConfirmation:
            issue.fields.assignee === null
              ? { confirmed: true, id: null }
              : issue.fields.assignee.accountId
                ? {
                    confirmed: true,
                    id: issue.fields.assignee.accountId
                  }
                : { confirmed: false }
        };
      } catch {
        throw new Error(
          `${CREATE_OUTCOME_UNCERTAIN_MARKER} Jira created ${created.key}, but Taskboard could not confirm its details. Refresh the board and check for it before trying again.`
        );
      }
    },
    async updateStatus(locator, statusId) {
      if (!configured) throw new Error('Jira is not configured');
      const available = await transitionOptions(locator);
      const target = available.options.find(option => option.id === statusId);
      if (!target) {
        throw new TaskboardError(
          'unsupported_transition',
          'Jira status is not available for this issue'
        );
      }
      if (!target.current) {
        if (!target.transitionId) {
          throw new Error('Jira status does not have an available transition');
        }
        await jiraRequest(
          auth,
          `/rest/api/3/issue/${encodeURIComponent(locator)}/transitions`,
          {
            method: 'POST',
            body: JSON.stringify({ transition: { id: target.transitionId } })
          }
        );
      }
      const issue = await loadIssue(locator, {
        comments: false,
        verifyScope: false
      });
      if (issue.fields.status.id !== statusId) {
        throw new Error('Jira returned an invalid status update result');
      }
      return toItem(baseUrl, issue);
    }
  };
}
