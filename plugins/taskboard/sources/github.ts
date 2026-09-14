import { execFile } from 'node:child_process';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {
  CREATE_OUTCOME_UNCERTAIN_MARKER,
  type WorkStateCategory
} from '../contract.js';
import type {
  ExternalWorkItemCreateInput,
  ExternalWorkItemDetail,
  ExternalWorkStatusOption,
  WorkSourceAdapter
} from './types.js';
import { TaskboardError, withoutComments } from './types.js';

const githubItemSchema = z
  .object({
    repo: z.string(),
    number: z.number().int().positive(),
    kind: z.enum(['issue', 'pr']),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string()
  })
  .passthrough();

const listOutputSchema = z
  .object({ items: z.array(githubItemSchema) })
  .passthrough();

const detailOutputSchema = z
  .object({
    issue: githubItemSchema
      .omit({ kind: true })
      .extend({
        comments: z.array(
          z
            .object({
              author: z.string(),
              body: z.string(),
              createdAt: z.string()
            })
            .strict()
        )
      })
      .passthrough()
  })
  .passthrough();

export const githubStatusOutputSchema = z
  .object({
    ghOk: z.boolean(),
    ghError: z.string().nullable(),
    repos: z.array(
      z.object({ repo: z.string(), projectId: z.string().nullable() }).strict()
    ),
    lastSyncedAt: z.string().nullable()
  })
  .passthrough();

const refreshOutputSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative()
  })
  .passthrough();

const okOutputSchema = z.object({ ok: z.literal(true) }).strict();

const githubAssigneeSchema = z
  .object({ login: z.string().min(1) })
  .passthrough();
const paginatedGithubAssigneesSchema = z.array(
  z.array(githubAssigneeSchema)
);
const githubLabelSchema = z
  .object({ name: z.string().min(1) })
  .passthrough();
const paginatedGithubLabelsSchema = z.array(z.array(githubLabelSchema));
const githubMilestoneSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    due_on: z.string().nullable().optional()
  })
  .passthrough();
const paginatedGithubMilestonesSchema = z.array(
  z.array(githubMilestoneSchema)
);
const createdGithubIssueSchema = z
  .object({
    number: z.number().int().positive(),
    html_url: z.string().min(1),
    assignees: z
      .array(z.object({ login: z.string().min(1) }).passthrough()),
    labels: z
      .array(
        z.union([
          z.string(),
          z.object({ name: z.string().min(1) }).passthrough()
        ])
      )
      .default([]),
    milestone: z
      .object({ number: z.number().int().positive() })
      .passthrough()
      .nullable()
      .default(null)
  })
  .passthrough();

interface ActiveGithubRefresh {
  mutationRevision: number;
  promise: Promise<void>;
}

const githubMutationRevisions = new WeakMap<BbPluginApi, number>();
const activeRefreshes = new WeakMap<BbPluginApi, ActiveGithubRefresh>();
let resolvedGhPath: string | null = null;

function runFile(
  file: string,
  args: string[],
  timeoutMs = 20_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

async function resolveGhPath(): Promise<string> {
  if (resolvedGhPath !== null) return resolvedGhPath;
  for (const candidate of [
    'gh',
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh'
  ]) {
    try {
      await runFile(candidate, ['--version'], 5_000);
      resolvedGhPath = candidate;
      return candidate;
    } catch {
      // Try the next common GitHub CLI location.
    }
  }
  throw new Error('GitHub CLI is not available');
}

async function runGh(args: string[], timeoutMs?: number): Promise<string> {
  return runFile(await resolveGhPath(), args, timeoutMs);
}

function milestoneLabel(milestone: z.infer<typeof githubMilestoneSchema>) {
  const dueDate = milestone.due_on?.slice(0, 10);
  return dueDate ? `${milestone.title} · ${dueDate}` : milestone.title;
}

function uniqueByIdentity<T>(
  values: readonly T[],
  identity: (value: T) => string
): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = identity(value).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function markGithubCacheStale(bb: BbPluginApi): void {
  githubMutationRevisions.set(
    bb,
    (githubMutationRevisions.get(bb) ?? 0) + 1
  );
}

function refreshGithubCache(bb: BbPluginApi): Promise<void> {
  const mutationRevision = githubMutationRevisions.get(bb) ?? 0;
  const active = activeRefreshes.get(bb);
  if (active && active.mutationRevision >= mutationRevision) {
    return active.promise;
  }
  const run = () =>
    bb.sdk.plugins
      .callRpc({
        pluginId: 'github',
        method: 'refresh',
        input: null,
        outputSchema: refreshOutputSchema
      })
      .then(() => undefined);
  const pending = active
    ? active.promise.then(run, run)
    : run();
  const promise = pending.finally(() => {
    if (activeRefreshes.get(bb)?.promise === promise) {
      activeRefreshes.delete(bb);
    }
  });
  activeRefreshes.set(bb, { mutationRevision, promise });
  return promise;
}

export function loadGithubStatus(bb: BbPluginApi) {
  return bb.sdk.plugins.callRpc({
    pluginId: 'github',
    method: 'status',
    input: null,
    outputSchema: githubStatusOutputSchema
  });
}

export type GithubStatus = z.infer<typeof githubStatusOutputSchema>;

export function githubReposForProject(
  status: GithubStatus,
  projectId: string
): string[] {
  return [
    ...new Set(
      status.repos
        .filter(repo => repo.projectId === projectId)
        .map(repo => repo.repo)
    )
  ];
}

// ---- GitHub Projects (v2) status enrichment ----
// BB's builtin github plugin only syncs issue open/closed. To surface real
// board columns (Backlog / Ready / In progress / …) we read each issue's
// Project v2 Status field directly via the gh CLI and map it onto the item.
const projectStatusItemSchema = z
  .object({
    id: z.string().optional(),
    content: z
      .object({
        type: z.string().optional(),
        number: z.number().int().optional(),
        repository: z.string().optional()
      })
      .passthrough()
      .optional(),
    repository: z.string().optional(),
    // `gh project item-list` emits `null` (not merely absent) for an unset
    // Status/Priority field — `.optional()` alone rejects that with a Zod
    // parse error, which the caller's catch then swallows as a fetch
    // failure, silently dropping every affected item from the map.
    status: z.string().nullish(),
    priority: z.string().nullish()
  })
  .passthrough();

const projectItemListSchema = z
  .object({ items: z.array(projectStatusItemSchema) })
  .passthrough();

const projectListEntrySchema = z
  .object({ number: z.number().int(), id: z.string().optional() })
  .passthrough();

const projectListSchema = z
  .object({ projects: z.array(projectListEntrySchema) })
  .passthrough();

interface ProjectStatus {
  status: string;
  priority: string | null;
  // Which of the owner's boards this issue actually sits on, and the item's
  // own node id on that board — both needed to write a real status change,
  // since option names are deduped across an owner's projects for display
  // (see ProjectStatusOption) and are otherwise ambiguous.
  projectNumber: number;
  itemId: string;
}

function projectStateCategory(name: string): WorkStateCategory | null {
  const value = name.trim().toLowerCase();
  if (!value) return null;
  if (/\b(backlog|icebox|triage)\b/u.test(value)) return 'backlog';
  if (/\b(ready|to ?do|up next|planned|new|open|selected)\b/u.test(value)) {
    return 'todo';
  }
  if (
    /\b(in ?progress|in ?review|doing|started|active|building|qa|review)\b/u.test(
      value
    )
  ) {
    return 'in_progress';
  }
  if (
    /\b(done|shipped|closed|complete|completed|merged|released)\b/u.test(value)
  ) {
    return 'done';
  }
  if (
    /\b(cancell?ed|wont ?do|won.?t ?do|dropped|abandoned|duplicate|invalid)\b/u.test(
      value
    )
  ) {
    return 'canceled';
  }
  return null;
}

// One map covering every issue on any of the owner's project boards, keyed by
// "owner/repo#number". Best-effort: any gh failure degrades to open/closed —
// callers use `hadFailure` to avoid caching that degraded state as if it were
// a real "this repo has no board" result.
async function loadProjectStatusMap(
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string>,
  repos: readonly string[]
): Promise<{ map: Map<string, ProjectStatus>; hadFailure: boolean }> {
  const map = new Map<string, ProjectStatus>();
  let hadFailure = false;
  const repoSet = new Set(repos);
  const owners = [
    ...new Set(repos.map(repo => repo.split('/')[0]).filter(Boolean))
  ];
  for (const owner of owners) {
    const projects = await getProjects(runGithubCli, owner);
    for (const { number } of projects) {
      let items: z.infer<typeof projectStatusItemSchema>[] = [];
      try {
        const itemsOut = await runGithubCli(
          [
            'project',
            'item-list',
            String(number),
            '--owner',
            owner,
            '--limit',
            '2000',
            '--format',
            'json'
          ],
          30_000
        );
        items = projectItemListSchema.parse(JSON.parse(itemsOut)).items;
      } catch {
        hadFailure = true;
        continue;
      }
      for (const item of items) {
        const status = item.status?.trim();
        if (!status || !item.id) continue;
        const repo = item.content?.repository ?? item.repository;
        const num = item.content?.number;
        if (!repo || typeof num !== 'number' || !repoSet.has(repo)) continue;
        const key = `${repo}#${num}`;
        if (map.has(key)) continue;
        map.set(key, {
          status,
          priority: item.priority?.trim() || null,
          projectNumber: number,
          itemId: item.id
        });
      }
    }
  }
  return { map, hadFailure };
}

// Status field option metadata from a Project v2 board.
const projectFieldSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    options: z
      .array(
        z.object({ id: z.string().optional(), name: z.string() }).passthrough()
      )
      .optional()
  })
  .passthrough();

const projectFieldListSchema = z
  .object({ fields: z.array(projectFieldSchema) })
  .passthrough();

interface ProjectStatusOption {
  name: string;
  category: WorkStateCategory;
}

// The GraphQL ids a real Status-field write needs, per project board. Not
// deduped across an owner's projects the way ProjectStatusOption is — a
// write always targets one specific board, resolved via ProjectStatus's
// projectNumber, never by option name alone (two boards can reuse a name
// like "In Progress" with different option ids).
interface ProjectFieldInfo {
  projectNodeId: string;
  fieldId: string;
  optionIdByName: Map<string, string>;
}

// Keyed by `${owner}/${projectNumber}`. Populated as a side effect of
// loadProjectStatusOptions, which already fetches `project field-list` for
// every board it lists options for — no extra GraphQL call to keep this
// warm.
const projectFieldInfoCache = new Map<string, ProjectFieldInfo>();

// gh project calls are GraphQL under the hood and their cost is charged
// against GitHub's 5,000 pts/hour budget before the query even runs, so we
// cache per owner for several minutes (board structure rarely changes
// second-to-second) to collapse the fan-out from the Kanban preloading
// statuses for every visible item at once.
const STATUS_CACHE_TTL_MS = 5 * 60_000;
// A failed fetch (rate limit, timeout, transient gh error) must not be
// remembered as "this owner/repo has no board" for the full TTL — that's what
// strands the Kanban on the synthetic Open/Closed fallback for minutes at a
// time. Failures get this much shorter window so the next view retries soon.
const FAILURE_CACHE_TTL_MS = 10_000;
const statusMapCache = new Map<
  string,
  { expires: number; value: Promise<Map<string, ProjectStatus>> }
>();
const statusOptionsCache = new Map<
  string,
  { expires: number; value: Promise<ProjectStatusOption[]> }
>();
interface ProjectListEntry {
  number: number;
  // Absent on gh CLI versions that don't emit it for `project list`; a board
  // whose node id we never learned can be read but never written to.
  id: string | null;
}

// `gh project list` is itself a GraphQL call — loadProjectStatusMap and
// loadProjectStatusOptions both need the owner's project numbers, so share
// one cache instead of each fetching it independently.
const projectListCache = new Map<
  string,
  { expires: number; value: Promise<ProjectListEntry[]> }
>();

function getProjects(
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string>,
  owner: string
): Promise<ProjectListEntry[]> {
  const now = Date.now();
  const cached = projectListCache.get(owner);
  if (cached && cached.expires > now) return cached.value;
  const raw = runGithubCli(
    ['project', 'list', '--owner', owner, '--limit', '100', '--format', 'json'],
    20_000
  ).then(listOut =>
    projectListSchema.parse(JSON.parse(listOut)).projects.map(project => ({
      number: project.number,
      id: project.id ?? null
    }))
  );
  const value = raw.catch(() => [] as ProjectListEntry[]);
  projectListCache.set(owner, { expires: now + STATUS_CACHE_TTL_MS, value });
  raw.catch(() => {
    const entry = projectListCache.get(owner);
    if (entry && entry.value === value) {
      projectListCache.set(owner, {
        expires: Date.now() + FAILURE_CACHE_TTL_MS,
        value
      });
    }
  });
  return value;
}

function getProjectStatusMap(
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string>,
  repos: readonly string[]
): Promise<Map<string, ProjectStatus>> {
  const key = [...new Set(repos)].sort().join(',');
  const now = Date.now();
  const cached = statusMapCache.get(key);
  if (cached && cached.expires > now) return cached.value;
  const loaded = loadProjectStatusMap(runGithubCli, repos);
  const value = loaded.then(result => result.map);
  statusMapCache.set(key, { expires: now + STATUS_CACHE_TTL_MS, value });
  loaded.then(result => {
    if (!result.hadFailure) return;
    const entry = statusMapCache.get(key);
    if (entry && entry.value === value) {
      statusMapCache.set(key, {
        expires: Date.now() + FAILURE_CACHE_TTL_MS,
        value
      });
    }
  });
  return value;
}

async function loadProjectStatusOptions(
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string>,
  owner: string
): Promise<{ options: ProjectStatusOption[]; hadFailure: boolean }> {
  const options: ProjectStatusOption[] = [];
  const seen = new Set<string>();
  let hadFailure = false;
  const projects = await getProjects(runGithubCli, owner);
  for (const project of projects) {
    try {
      const fieldsOut = await runGithubCli(
        [
          'project',
          'field-list',
          String(project.number),
          '--owner',
          owner,
          '--limit',
          '100',
          '--format',
          'json'
        ],
        20_000
      );
      const fields = projectFieldListSchema.parse(JSON.parse(fieldsOut)).fields;
      const statusField = fields.find(
        field => field.name?.trim().toLowerCase() === 'status' && field.options
      );
      if (statusField?.id && project.id) {
        const optionIdByName = new Map<string, string>();
        for (const option of statusField.options ?? []) {
          if (option.id) optionIdByName.set(option.name.trim().toLowerCase(), option.id);
        }
        projectFieldInfoCache.set(`${owner}/${project.number}`, {
          projectNodeId: project.id,
          fieldId: statusField.id,
          optionIdByName
        });
      }
      for (const option of statusField?.options ?? []) {
        const name = option.name.trim();
        const identity = name.toLowerCase();
        if (!name || seen.has(identity)) continue;
        seen.add(identity);
        options.push({ name, category: projectStateCategory(name) ?? 'todo' });
      }
    } catch {
      hadFailure = true;
      continue;
    }
  }
  return { options, hadFailure };
}

function getProjectStatusOptions(
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string>,
  owner: string
): Promise<ProjectStatusOption[]> {
  const now = Date.now();
  const cached = statusOptionsCache.get(owner);
  if (cached && cached.expires > now) return cached.value;
  const loaded = loadProjectStatusOptions(runGithubCli, owner).catch(() => ({
    options: [] as ProjectStatusOption[],
    hadFailure: true
  }));
  const value = loaded.then(result => result.options);
  statusOptionsCache.set(owner, { expires: now + STATUS_CACHE_TTL_MS, value });
  loaded.then(result => {
    if (!result.hadFailure) return;
    const entry = statusOptionsCache.get(owner);
    if (entry && entry.value === value) {
      statusOptionsCache.set(owner, {
        expires: Date.now() + FAILURE_CACHE_TTL_MS,
        value
      });
    }
  });
  return value;
}

function toItem(
  value: z.infer<typeof githubItemSchema>,
  comments: ExternalWorkItemDetail['comments'] = [],
  projectStatus?: ProjectStatus
): ExternalWorkItemDetail {
  const open = value.state.toLowerCase() === 'open';
  const category = projectStatus
    ? projectStateCategory(projectStatus.status)
    : null;
  return {
    source: 'github',
    locator: `${value.repo}#${value.number}`,
    key: `${value.repo}#${value.number}`,
    title: value.title,
    description: value.body,
    url: value.url,
    status: projectStatus?.status ?? value.state,
    stateCategory: category ?? (open ? 'todo' : 'done'),
    priority: projectStatus?.priority ?? null,
    assignee: value.assignees.join(', ') || null,
    project: value.repo,
    labels: value.labels,
    updatedAt: value.updatedAt,
    comments
  };
}

function parseLocator(locator: string): { repo: string; number: number } {
  const match = /^(?<repo>[^#]+)#(?<number>[1-9]\d*)$/u.exec(locator);
  if (!match?.groups)
    throw new Error(`Invalid GitHub issue locator: ${locator}`);
  return { repo: match.groups.repo!, number: Number(match.groups.number) };
}

export function createGithubAdapter(
  bb: BbPluginApi,
  enabled: boolean,
  projectId: string,
  runGithubCli: (args: string[], timeoutMs?: number) => Promise<string> = runGh
): WorkSourceAdapter {
  async function scopedIssue(locator: string): Promise<ExternalWorkItemDetail> {
    const { repo, number } = parseLocator(locator);
    const status = await loadGithubStatus(bb);
    if (!status.ghOk) {
      throw new Error(status.ghError ?? 'GitHub is not authenticated');
    }
    if (!githubReposForProject(status, projectId).includes(repo)) {
      throw new TaskboardError(
        'out_of_scope',
        `GitHub repository ${repo} is not mapped to BB project ${projectId}`
      );
    }
    const result = await bb.sdk.plugins.callRpc({
      pluginId: 'github',
      method: 'getIssue',
      input: { repo, number },
      outputSchema: detailOutputSchema
    });
    if (result.issue.repo !== repo || result.issue.number !== number) {
      throw new Error(`GitHub returned the wrong issue for ${locator}`);
    }
    const projectStatusMap = await getProjectStatusMap(runGithubCli, [repo]);
    return toItem(
      { ...result.issue, kind: 'issue' },
      result.issue.comments,
      projectStatusMap.get(`${repo}#${number}`)
    );
  }

  async function statusOptions(
    locator: string
  ): Promise<ExternalWorkStatusOption[]> {
    const { repo } = parseLocator(locator);
    const owner = repo.split('/')[0] ?? '';
    const [issue, projectOptions] = await Promise.all([
      scopedIssue(locator),
      getProjectStatusOptions(runGithubCli, owner)
    ]);
    // Prefer the board's real Status options so the Kanban lanes mirror the
    // GitHub Project instead of a synthetic Open/Closed pair.
    if (projectOptions.length > 0) {
      const currentName = issue.status.trim().toLowerCase();
      return projectOptions.map(option => ({
        id: option.name,
        name: option.name,
        stateCategory: option.category,
        current: option.name.toLowerCase() === currentName
      }));
    }
    const current = issue.status.toLowerCase() === 'open' ? 'open' : 'closed';
    return [
      {
        id: 'open',
        name: 'Open',
        stateCategory: 'todo',
        current: current === 'open'
      },
      {
        id: 'closed',
        name: 'Closed',
        stateCategory: 'done',
        current: current === 'closed'
      }
    ];
  }

  async function assertMappedRepository(repo: string): Promise<void> {
    const status = await loadGithubStatus(bb);
    if (!status.ghOk) {
      throw new Error(status.ghError ?? 'GitHub is not authenticated');
    }
    if (!githubReposForProject(status, projectId).includes(repo)) {
      throw new Error(
        `GitHub repository ${repo} is not mapped to this BB project`
      );
    }
  }

  return {
    source: 'github',
    configured: () => enabled,
    configurationMessage: () =>
      enabled ? null : 'Enable GitHub in Taskboard settings.',
    async list(options) {
      if (!enabled) throw new Error('GitHub is disabled');
      if (options?.refresh) await refreshGithubCache(bb);
      const status = await loadGithubStatus(bb);
      if (!status.ghOk) {
        throw new Error(status.ghError ?? 'GitHub is not authenticated');
      }
      const repos = githubReposForProject(status, projectId);
      const [projectStatusMap, results] = await Promise.all([
        getProjectStatusMap(runGithubCli, repos),
        Promise.all(
          repos.map(async repo => ({
            repo,
            result: await bb.sdk.plugins.callRpc({
              pluginId: 'github',
              method: 'listItems',
              input: { kind: 'issue', repo },
              outputSchema: listOutputSchema
            })
          }))
        )
      ]);
      // When board data is available, mirror the GitHub Project exactly: only
      // issues placed on a board appear, so no synthetic Open/Closed lanes leak
      // in. If the board fetch failed (empty map), fall back to every issue.
      const boardScoped = projectStatusMap.size > 0;
      return results.flatMap(({ repo, result }) =>
        result.items.flatMap(item => {
          if (item.repo !== repo || item.kind !== 'issue') {
            throw new Error(
              `GitHub returned an item outside requested repository ${repo}`
            );
          }
          const projectStatus = projectStatusMap.get(
            `${item.repo}#${item.number}`
          );
          if (boardScoped && !projectStatus) return [];
          return [withoutComments(toItem(item, [], projectStatus))];
        })
      );
    },
    async get(locator) {
      if (!enabled) throw new Error('GitHub is disabled');
      return scopedIssue(locator);
    },
    async statusOptions(locator) {
      if (!enabled) throw new Error('GitHub is disabled');
      return statusOptions(locator);
    },
    async createMetadata(input) {
      if (!enabled) throw new Error('GitHub is disabled');
      await assertMappedRepository(input.destinationId);
      const [users, labels, milestones] = await Promise.all([
        runGithubCli(
          [
            'api',
            '--paginate',
            '--slurp',
            `repos/${input.destinationId}/assignees?per_page=100`
          ],
          30_000
        ).then(output =>
          uniqueByIdentity(
            paginatedGithubAssigneesSchema
              .parse(JSON.parse(output))
              .flat(),
            user => user.login
          )
        ),
        runGithubCli(
          [
            'api',
            '--paginate',
            '--slurp',
            `repos/${input.destinationId}/labels?per_page=100`
          ],
          30_000
        ).then(output =>
          uniqueByIdentity(
            paginatedGithubLabelsSchema.parse(JSON.parse(output)).flat(),
            label => label.name
          )
        ),
        runGithubCli(
          [
            'api',
            '--paginate',
            '--slurp',
            `repos/${input.destinationId}/milestones?state=open&per_page=100`
          ],
          30_000
        )
          .then(output =>
            uniqueByIdentity(
              paginatedGithubMilestonesSchema
                .parse(JSON.parse(output))
                .flat(),
              milestone => String(milestone.number)
            )
          )
          .catch(() => [])
      ]);
      return {
        statusOptions: [],
        assigneeOptions: users.map(user => ({
          id: user.login,
          label: `@${user.login}`
        })),
        priorityOptions: [],
        labelOptions: labels.map(label => ({
          id: label.name,
          label: label.name
        })),
        milestoneOptions: milestones.map(milestone => ({
          id: String(milestone.number),
          label: milestoneLabel(milestone)
        })),
        issueTypeOptions: [],
        defaultStatusId: null,
        defaultIssueTypeId: null,
        supportsDueDate: false
      };
    },
    async create(input: ExternalWorkItemCreateInput) {
      if (!enabled) throw new Error('GitHub is disabled');
      await assertMappedRepository(input.destinationId);
      if (input.dueDate !== null || input.priorityId !== null) {
        throw new Error(
          'GitHub issues use milestones instead of direct due dates or priorities'
        );
      }
      if (input.statusId !== null && input.statusId !== 'open') {
        throw new Error('GitHub issues are created open');
      }
      const milestone =
        input.milestoneId === null ? null : Number(input.milestoneId);
      if (
        milestone !== null &&
        (!Number.isSafeInteger(milestone) || milestone < 1)
      ) {
        throw new Error('GitHub milestone is invalid');
      }
      const args = [
        'api',
        '--method',
        'POST',
        `repos/${input.destinationId}/issues`,
        '--raw-field',
        `title=${input.title}`,
        '--raw-field',
        `body=${input.description}`,
        ...input.assigneeId
          ? ['--raw-field', `assignees[]=${input.assigneeId}`]
          : [],
        ...input.labelIds.flatMap(label => [
          '--raw-field',
          `labels[]=${label}`
        ]),
        ...(milestone !== null
          ? ['--field', `milestone=${milestone}`]
          : [])
      ];
      // The write may commit even when the response is lost or malformed.
      // Advance before attempting it so reconciliation never reuses a refresh
      // that began before this possibly-committed mutation.
      markGithubCacheStale(bb);
      let created: z.infer<typeof createdGithubIssueSchema>;
      try {
        created = createdGithubIssueSchema.parse(
          JSON.parse(await runGithubCli(args, 30_000))
        );
      } catch {
        throw new Error(
          `${CREATE_OUTCOME_UNCERTAIN_MARKER} GitHub may have created the issue, but Taskboard could not confirm the response. Refresh the board and check for it before trying again.`
        );
      }
      const createdAssignees = created.assignees.map(assignee => assignee.login);
      const createdLabels = created.labels.map(label =>
        typeof label === 'string' ? label : label.name
      );
      const returnedAssignees = new Set(
        createdAssignees
      );
      const returnedLabels = new Set(createdLabels);
      const confirmedId =
        (input.assigneeId && returnedAssignees.has(input.assigneeId)
          ? input.assigneeId
          : createdAssignees[0]) ?? null;
      const warnings: string[] = [];
      if (input.assigneeId && !returnedAssignees.has(input.assigneeId)) {
        warnings.push(
          `GitHub created the issue but could not assign @${input.assigneeId}.`
        );
      }
      const missingLabels = input.labelIds.filter(
        label => !returnedLabels.has(label)
      );
      if (missingLabels.length > 0) {
        warnings.push(
          `GitHub created the issue without ${missingLabels.join(', ')}.`
        );
      }
      if (milestone !== null && created.milestone?.number !== milestone) {
        warnings.push(
          'GitHub created the issue but could not attach the selected milestone.'
        );
      }
      return {
        item: {
          source: 'github',
          locator: `${input.destinationId}#${created.number}`,
          key: `${input.destinationId}#${created.number}`,
          title: input.title,
          description: input.description,
          url: created.html_url,
          status: 'OPEN',
          stateCategory: 'todo',
          priority: null,
          assignee: createdAssignees.join(', ') || null,
          project: input.destinationId,
          labels: createdLabels,
          updatedAt: new Date().toISOString(),
          comments: []
        },
        warnings,
        assigneeConfirmation: {
          confirmed: true,
          id: confirmedId
        }
      };
    },
    async updateStatus(locator, statusId) {
      if (!enabled) throw new Error('GitHub is disabled');
      const available = await statusOptions(locator);
      const target = available.find(option => option.id === statusId);
      if (!target) {
        throw new TaskboardError(
          'unsupported_transition',
          'GitHub status is not available for this issue'
        );
      }
      if (target.current) return scopedIssue(locator);
      const { repo, number } = parseLocator(locator);
      if (statusId === 'open' || statusId === 'closed') {
        await bb.sdk.plugins.callRpc({
          pluginId: 'github',
          method: 'setIssueState',
          input: { repo, number, state: statusId },
          outputSchema: okOutputSchema
        });
        return scopedIssue(locator);
      }
      // A real board-column move: resolve which of the owner's boards this
      // issue is actually on (never by option name alone — two boards can
      // reuse a name like "In Progress" with different option ids), then
      // write the Status single-select field via that board's own ids.
      const owner = repo.split('/')[0] ?? '';
      const projectStatusMap = await getProjectStatusMap(runGithubCli, [repo]);
      const current = projectStatusMap.get(`${repo}#${number}`);
      if (!current) {
        throw new TaskboardError(
          'not_on_board',
          `${locator} is not on any GitHub Project board`
        );
      }
      const fieldInfo = projectFieldInfoCache.get(
        `${owner}/${current.projectNumber}`
      );
      if (!fieldInfo) {
        throw new TaskboardError(
          'not_cached',
          'GitHub Project board field metadata is not loaded yet; try again'
        );
      }
      const optionId = fieldInfo.optionIdByName.get(statusId.toLowerCase());
      if (!optionId) {
        throw new TaskboardError(
          'unsupported_transition',
          `GitHub Project board has no "${statusId}" status option`
        );
      }
      await runGithubCli(
        [
          'project',
          'item-edit',
          '--id',
          current.itemId,
          '--project-id',
          fieldInfo.projectNodeId,
          '--field-id',
          fieldInfo.fieldId,
          '--single-select-option-id',
          optionId
        ],
        20_000
      );
      // Patch the shared cache in place rather than invalidating it: the
      // status map is cached up to STATUS_CACHE_TTL_MS (5 min), and without
      // this the write would succeed while every reader — including the
      // scopedIssue() call below — kept serving the pre-write status until
      // the cache expired.
      projectStatusMap.set(`${repo}#${number}`, {
        ...current,
        status: target.name
      });
      return scopedIssue(locator);
    }
  };
}
