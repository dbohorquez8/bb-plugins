import type {
  AssigneeConfirmation,
  CreateIssueMetadata,
  WorkItem,
  WorkItemDetail,
  WorkSource,
  WorkStatusOption
} from '../contract.js';

export type ExternalWorkItem = Omit<WorkItem, 'bbProjectId'>;
export type ExternalWorkItemDetail = Omit<WorkItemDetail, 'bbProjectId'>;
export type ExternalWorkStatusOption = WorkStatusOption;

export interface ExternalWorkItemCreateInput {
  title: string;
  description: string;
  destinationId: string;
  issueType: string | null;
  statusId: string | null;
  assigneeId: string | null;
  priorityId: string | null;
  labelIds: string[];
  dueDate: string | null;
  milestoneId: string | null;
}

export interface ExternalWorkItemCreateMetadataInput {
  destinationId: string;
  issueType: string | null;
}

export interface ExternalWorkItemCreateResult {
  item: ExternalWorkItemDetail;
  warnings: string[];
  assigneeConfirmation: AssigneeConfirmation;
}

export function withoutComments(
  item: ExternalWorkItemDetail
): ExternalWorkItem {
  const { comments: _comments, ...summary } = item;
  return summary;
}

// Adapters throw this instead of a plain Error for rejections a caller can
// reasonably act on (skip, retry, or surface as-is) rather than treat as an
// opaque upstream failure. `server.ts` matches on `code`, not on message
// text, so adapter wording can change without silently breaking that match.
export type TaskboardErrorCode =
  | 'not_cached'
  | 'not_configured'
  | 'unsupported_transition'
  | 'not_on_board'
  | 'out_of_scope'
  | 'upstream_failed';

export class TaskboardError extends Error {
  readonly code: TaskboardErrorCode;
  constructor(code: TaskboardErrorCode, message: string) {
    super(message);
    this.name = 'TaskboardError';
    this.code = code;
  }
}

export interface WorkSourceAdapter {
  readonly source: WorkSource;
  configured(): boolean;
  configurationMessage(): string | null;
  list(options?: { refresh?: boolean }): Promise<ExternalWorkItem[]>;
  get(locator: string): Promise<ExternalWorkItemDetail>;
  statusOptions(locator: string): Promise<ExternalWorkStatusOption[]>;
  createMetadata(
    input: ExternalWorkItemCreateMetadataInput
  ): Promise<CreateIssueMetadata>;
  create(
    input: ExternalWorkItemCreateInput
  ): Promise<ExternalWorkItemCreateResult>;
  updateStatus(
    locator: string,
    statusId: string
  ): Promise<ExternalWorkItemDetail>;
}
