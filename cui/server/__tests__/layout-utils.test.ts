/**
 * Layout cleanup unit tests.
 *
 * Covers the zombie-tab problem first reported 2026-04-30: arch-worker.json
 * had 5 finished sessions still rendered as ghost tabs because runAutoLayout
 * never removes them.
 *
 * Run: npx tsx --test server/__tests__/layout-utils.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeSessionFromLayouts, collectLayoutSessionIds } from '../routes/shared/layout-utils.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'cui-layout-utils-'));
}

function writeLayout(dir: string, name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(body, null, 2));
  return p;
}

function fixtureLayout(tabs: Array<{ id: string; sid?: string; comp?: string }>): any {
  return {
    global: { splitterSize: 4 },
    borders: [],
    _v: 7,
    layout: {
      type: 'row',
      id: '#root',
      children: [
        {
          type: 'tabset',
          id: '#tabset-a',
          weight: 100,
          children: tabs.map(t => ({
            type: 'tab',
            id: t.id,
            name: 'Chat',
            component: t.comp ?? 'cui',
            config: t.sid ? { initialSessionId: t.sid } : {},
          })),
        },
      ],
    },
  };
}

test('removeSessionFromLayouts: drops matching CUI tab, leaves siblings', () => {
  const dir = makeTmpDir();
  try {
    const path = writeLayout(dir, 'arch-worker.json', fixtureLayout([
      { id: '#a', sid: 'live-1' },
      { id: '#b', sid: 'zombie-1' },
      { id: '#c', sid: 'live-2' },
    ]));

    const changes = removeSessionFromLayouts(dir, 'zombie-1');

    assert.equal(changes.length, 1);
    assert.equal(changes[0].projectId, 'arch-worker');
    assert.equal(changes[0].removed, 1);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    const ids = after.layout.children[0].children.map((c: any) => c.id);
    assert.deepEqual(ids, ['#a', '#c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionFromLayouts: empty tabset gets pruned when last tab removed', () => {
  const dir = makeTmpDir();
  try {
    const path = writeLayout(dir, 'devops.json', {
      global: {},
      borders: [],
      _v: 1,
      layout: {
        type: 'row',
        id: '#root',
        children: [
          {
            type: 'tabset',
            id: '#solo',
            weight: 50,
            children: [
              { type: 'tab', id: '#only', name: 'Chat', component: 'cui', config: { initialSessionId: 'doomed' } },
            ],
          },
          {
            type: 'tabset',
            id: '#keeper',
            weight: 50,
            children: [
              { type: 'tab', id: '#x', name: 'Notes', component: 'notes', config: {} },
            ],
          },
        ],
      },
    });

    const changes = removeSessionFromLayouts(dir, 'doomed');
    assert.equal(changes.length, 1);
    assert.equal(changes[0].removed, 1);

    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.layout.children.length, 1, 'empty tabset must be pruned');
    assert.equal(after.layout.children[0].id, '#keeper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionFromLayouts: bumps _v on changed files only', () => {
  const dir = makeTmpDir();
  try {
    const changedPath = writeLayout(dir, 'a.json', fixtureLayout([
      { id: '#a', sid: 'live' },
      { id: '#b', sid: 'kill-me' },
    ]));
    const untouchedPath = writeLayout(dir, 'b.json', fixtureLayout([
      { id: '#x', sid: 'unrelated' },
    ]));

    const before = JSON.parse(readFileSync(untouchedPath, 'utf8'))._v;

    const changes = removeSessionFromLayouts(dir, 'kill-me');
    assert.equal(changes.length, 1);

    const after = JSON.parse(readFileSync(changedPath, 'utf8'));
    assert.equal(after._v, 8, '_v must be bumped from 7 → 8');

    const untouchedAfter = JSON.parse(readFileSync(untouchedPath, 'utf8'))._v;
    assert.equal(untouchedAfter, before, 'unrelated layout must keep its _v');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionFromLayouts: skips backups and templates', () => {
  const dir = makeTmpDir();
  try {
    const livePath = writeLayout(dir, 'arch.json', fixtureLayout([
      { id: '#k', sid: 'kill' },
    ]));
    const bakPath = writeLayout(dir, 'arch.json.bak-zombie-cleanup', fixtureLayout([
      { id: '#k2', sid: 'kill' },
    ]));
    const tmplPath = writeLayout(dir, 'business_template.json', fixtureLayout([
      { id: '#k3', sid: 'kill' },
    ]));

    const changes = removeSessionFromLayouts(dir, 'kill');
    assert.equal(changes.length, 1, 'only the live layout must be touched');
    assert.equal(changes[0].projectId, 'arch');

    // Backup and template untouched
    const bak = JSON.parse(readFileSync(bakPath, 'utf8'));
    assert.equal(bak.layout.children[0].children.length, 1);
    const tmpl = JSON.parse(readFileSync(tmplPath, 'utf8'));
    assert.equal(tmpl.layout.children[0].children.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionFromLayouts: matches both initialSessionId and sessionId config keys', () => {
  const dir = makeTmpDir();
  try {
    const path = writeLayout(dir, 'p.json', {
      global: {}, borders: [], _v: 0,
      layout: {
        type: 'row', id: '#r',
        children: [{
          type: 'tabset', id: '#ts', weight: 100,
          children: [
            { type: 'tab', id: '#a', component: 'cui',      config: { initialSessionId: 'sid-1' } },
            { type: 'tab', id: '#b', component: 'cui-lite', config: { sessionId: 'sid-2' } },
            { type: 'tab', id: '#c', component: 'cui',      config: { initialSessionId: 'sid-3' } },
          ],
        }],
      },
    });
    const changes = removeSessionFromLayouts(dir, ['sid-1', 'sid-2']);
    assert.equal(changes[0].removed, 2);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    const ids = after.layout.children[0].children.map((c: any) => c.id);
    assert.deepEqual(ids, ['#c']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeSessionFromLayouts: noop when sid is empty / not present', () => {
  const dir = makeTmpDir();
  try {
    writeLayout(dir, 'p.json', fixtureLayout([{ id: '#a', sid: 'live' }]));
    assert.deepEqual(removeSessionFromLayouts(dir, ''), []);
    assert.deepEqual(removeSessionFromLayouts(dir, []), []);
    assert.deepEqual(removeSessionFromLayouts(dir, 'never-existed'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectLayoutSessionIds: returns every CUI sid in the tree', () => {
  const layout = fixtureLayout([
    { id: '#a', sid: 'sid-1' },
    { id: '#b', sid: 'sid-2', comp: 'cui-lite' },
    { id: '#c' }, // CUI without sid
    { id: '#d', sid: 'should-be-ignored', comp: 'notes' }, // non-CUI ignored
  ]);
  const sids = collectLayoutSessionIds(layout);
  assert.deepEqual([...sids].sort(), ['sid-1', 'sid-2']);
});
