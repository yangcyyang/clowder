import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('POST /api/workspace/resolve-local-markdown-path', () => {
  let app;
  let foreignWorkspaceRoot;
  let linkedRoot;
  let unlinkedRoot;
  let previousLinkedRoots;

  before(async () => {
    foreignWorkspaceRoot = mkdtempSync('/tmp/cat-cafe-local-markdown-foreign-workspace-');
    linkedRoot = mkdtempSync('/tmp/cat-cafe-local-markdown-linked-');
    unlinkedRoot = mkdtempSync('/tmp/cat-cafe-local-markdown-unlinked-');
    mkdirSync(join(linkedRoot, 'docs'), { recursive: true });
    writeFileSync(join(linkedRoot, 'docs', 'guide.md'), '# Guide\n', 'utf8');
    writeFileSync(join(linkedRoot, 'docs', 'notes.txt'), 'not markdown\n', 'utf8');
    writeFileSync(join(unlinkedRoot, 'outside.md'), '# Outside\n', 'utf8');
    symlinkSync(join(unlinkedRoot, 'outside.md'), join(linkedRoot, 'docs', 'outside-link.md'));
    writeFileSync(join(foreignWorkspaceRoot, 'README.MD'), '# Foreign workspace\n', 'utf8');

    previousLinkedRoots = process.env.WORKSPACE_LINKED_ROOTS;
    process.env.WORKSPACE_LINKED_ROOTS = `local-markdown:${linkedRoot}`;
    const { registerWorktrees } = await import('../dist/domains/workspace/workspace-security.js');
    registerWorktrees([{ id: 'foreign_workspace', root: foreignWorkspaceRoot, branch: 'main', head: 'foreign' }]);
    const { workspaceRoutes } = await import('../dist/routes/workspace.js');
    app = Fastify();
    await app.register(workspaceRoutes);
    await app.ready();
  });

  after(async () => {
    if (previousLinkedRoots == null) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = previousLinkedRoots;
    await app?.close();
    rmSync(foreignWorkspaceRoot, { recursive: true, force: true });
    rmSync(linkedRoot, { recursive: true, force: true });
    rmSync(unlinkedRoot, { recursive: true, force: true });
  });

  it('maps an authorized absolute Markdown path to its workspace-relative target', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-local-markdown-path',
      payload: { path: join(linkedRoot, 'docs', 'guide.md') },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      worktreeId: 'linked_local-markdown',
      path: 'docs/guide.md',
    });
  });

  it('maps a Markdown path from a previously registered foreign workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-local-markdown-path',
      payload: { path: join(foreignWorkspaceRoot, 'README.MD') },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { worktreeId: 'foreign_workspace', path: 'README.MD' });
  });

  it('refuses a Markdown path outside the registered workspace roots', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-local-markdown-path',
      payload: { path: join(unlinkedRoot, 'outside.md') },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).code, 'PATH_NOT_AUTHORIZED');
  });

  it('rejects a non-Markdown file before it is opened', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-local-markdown-path',
      payload: { path: join(linkedRoot, 'docs', 'notes.txt') },
    });

    assert.equal(res.statusCode, 400);
  });

  it('rejects dot segments even when the final file would be inside an authorized root', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-local-markdown-path',
      payload: { path: `${linkedRoot}/docs/../docs/guide.md` },
    });

    assert.equal(res.statusCode, 400);
  });

  it('refuses an authorized-root symlink that escapes to an unlinked Markdown file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspace/resolve-local-markdown-path',
      payload: { path: join(linkedRoot, 'docs', 'outside-link.md') },
    });

    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).code, 'TRAVERSAL');
  });
});
