import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const sourceUrl = new URL(
        `${specifier.slice(0, -'.js'.length)}.ts`,
        context.parentURL
      );
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { createGithubAdapter } = await import('../sources/github.ts');

const OWNER = 'acme-write';
const REPO = `${OWNER}/repo`;

// The project-board caches (`projectListCache`, `statusMapCache`, …) in
// github.ts are module-level singletons keyed by owner, deliberately shared
// across every caller for the full TTL — that's the point of the rate-limit
// fix they exist for. Each test below therefore needs its own owner so its
// mocked `gh` responses can't be served from a different test's warm cache.
function githubBoardBb(repo: string) {
  return {
    sdk: {
      plugins: {
        async callRpc(input: { method: string }) {
          if (input.method === 'status') {
            return {
              ghOk: true,
              ghError: null,
              repos: [{ repo, projectId: 'proj_taskboard' }],
              lastSyncedAt: null
            };
          }
          if (input.method === 'getIssue') {
            return {
              issue: {
                repo,
                number: 42,
                title: 'Ship it',
                state: 'OPEN',
                author: 'mateo',
                labels: [],
                assignees: [],
                url: `https://github.com/${repo}/issues/42`,
                body: '',
                updatedAt: '2026-09-14T00:00:00.000Z',
                comments: []
              }
            };
          }
          throw new Error(`Unexpected GitHub RPC: ${input.method}`);
        }
      }
    }
  };
}

test('GitHub updateStatus writes a real Project v2 board-column move and patches the shared status cache', async () => {
  const cliCalls: string[][] = [];
  const runGithubCli = async (args: string[]) => {
    cliCalls.push(args);
    if (args[0] === 'project' && args[1] === 'list') {
      return JSON.stringify({ projects: [{ number: 7, id: 'PVT_project7' }] });
    }
    if (args[0] === 'project' && args[1] === 'item-list') {
      return JSON.stringify({
        items: [
          {
            id: 'PVTI_item42',
            content: { number: 42, repository: REPO },
            status: 'In Progress',
            priority: null
          }
        ]
      });
    }
    if (args[0] === 'project' && args[1] === 'field-list') {
      return JSON.stringify({
        fields: [
          {
            id: 'PVTF_status',
            name: 'Status',
            type: 'ProjectV2SingleSelectField',
            options: [
              { id: 'OPT_todo', name: 'Todo' },
              { id: 'OPT_progress', name: 'In Progress' },
              { id: 'OPT_review', name: 'In Review' }
            ]
          }
        ]
      });
    }
    if (args[0] === 'project' && args[1] === 'item-edit') {
      return JSON.stringify({ ok: true });
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };

  const adapter = createGithubAdapter(
    githubBoardBb(REPO) as never,
    true,
    'proj_taskboard',
    runGithubCli
  );
  const locator = `${REPO}#42`;

  const updated = await adapter.updateStatus(locator, 'In Review');
  assert.equal(updated.status, 'In Review');

  const editCall = cliCalls.find(args => args[1] === 'item-edit');
  assert.deepEqual(editCall, [
    'project',
    'item-edit',
    '--id',
    'PVTI_item42',
    '--project-id',
    'PVT_project7',
    '--field-id',
    'PVTF_status',
    '--single-select-option-id',
    'OPT_review'
  ]);

  // The status map is cached for minutes; without an in-place patch on
  // write, this re-read would keep reporting the pre-write status until the
  // cache expired.
  const itemListCallsBefore = cliCalls.filter(
    args => args[1] === 'item-list'
  ).length;
  const reread = await adapter.get(locator);
  assert.equal(reread.status, 'In Review');
  assert.equal(
    cliCalls.filter(args => args[1] === 'item-list').length,
    itemListCallsBefore
  );
});

test('GitHub updateStatus rejects a board-column move for an issue that is not on any board', async () => {
  const owner = 'acme-noboard';
  const repo = `${owner}/repo`;
  const runGithubCli = async (args: string[]) => {
    if (args[0] === 'project' && args[1] === 'list') {
      return JSON.stringify({ projects: [{ number: 7, id: 'PVT_project7' }] });
    }
    if (args[0] === 'project' && args[1] === 'item-list') {
      return JSON.stringify({ items: [] });
    }
    if (args[0] === 'project' && args[1] === 'field-list') {
      return JSON.stringify({
        fields: [
          {
            id: 'PVTF_status',
            name: 'Status',
            options: [{ id: 'OPT_review', name: 'In Review' }]
          }
        ]
      });
    }
    throw new Error(`Unexpected gh call: ${args.join(' ')}`);
  };

  const adapter = createGithubAdapter(
    githubBoardBb(repo) as never,
    true,
    'proj_taskboard',
    runGithubCli
  );

  // The owner's board options exist project-wide, so "In Review" is an
  // offered target — but this specific issue has no entry in the status map
  // (it was never added to any board), which the write must catch.
  await assert.rejects(
    adapter.updateStatus(`${repo}#42`, 'In Review'),
    /not on any GitHub Project board/
  );
});
