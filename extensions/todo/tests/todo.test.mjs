import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.PI_CODING_AGENT_DIR || join(
  execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
  '@earendil-works/pi-coding-agent',
);
const { loadExtensions } = await import(pathToFileURL(join(host, 'dist/core/extensions/loader.js')));
const requireHost = createRequire(join(host, 'package.json'));
const { Check } = await import(pathToFileURL(requireHost.resolve('typebox/value')));
const { visibleWidth } = await import(pathToFileURL(requireHost.resolve('@earendil-works/pi-tui')));

async function harness(ui) {
  const loaded = await loadExtensions([join(cwd, 'index.ts')], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const tool = extension.tools.get('todo').definition;
  let branch = [];
  const persisted = [];
  const messages = [];
  loaded.runtime.appendEntry = (customType, data) => {
    const entry = { type: 'custom', customType, data: structuredClone(data) };
    branch.push(entry);
    persisted.push(entry);
  };
  loaded.runtime.sendMessage = (message) => messages.push(message);
  const ctx = { mode: ui ? 'tui' : 'json', hasUI: !!ui, ui, sessionManager: { getBranch: () => branch } };
  async function event(name, entries) {
    if (entries) branch = structuredClone(entries);
    for (const handler of extension.handlers.get(name) || []) await handler({ type: name }, ctx);
  }
  async function call(params) {
    assert.ok(Check(tool.parameters, params), JSON.stringify(params));
    const result = await tool.execute('test', params, undefined, undefined, ctx);
    assert.ok(Check(tool.outputSchema, result.structuredContent), JSON.stringify(result.structuredContent));
    assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent)), result.structuredContent);
    const { schemaVersion, ...details } = result.details;
    assert.equal(schemaVersion, 2);
    assert.deepEqual(result.structuredContent, Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined)));
    assert.equal(result.isError, !!result.details.error);
    if (result.isError) assert.match(result.content[0].text, /^Error: /);
    branch.push({ type: 'message', message: { role: 'toolResult', toolName: 'todo', details: structuredClone(result.details) } });
    return result;
  }
  await event('session_start');
  const command = (args) => extension.commands.get('todos').handler(args, ctx);
  return { tool, call, event, command, persisted, messages };
}

const titles = ['Plan', 'Implement', 'Verify', 'Deliver'];
const statuses = (result) => result.structuredContent.items.map(({ status }) => status);

test('tool results alone restore state; command clearing remains durable', async () => {
  const h = await harness();
  await h.call({ action: 'new', items: titles });
  await h.call({ action: 'update', completedIds: [1] });
  assert.equal(h.persisted.length, 0, 'tool calls do not append duplicate snapshots');
  await h.event('session_start');
  assert.deepEqual(statuses(await h.call({ action: 'list' })), ['done', 'active', 'pending', 'pending']);
  await h.command('clear');
  assert.equal(h.persisted.length, 1);
  await h.event('session_start');
  assert.deepEqual((await h.call({ action: 'list' })).details.items, []);
});

test('returned snapshots are isolated from live state and later updates', async () => {
  const h = await harness();
  const start = await h.call({ action: 'new', items: titles });
  await h.call({ action: 'update', completedIds: [1] });
  assert.deepEqual(statuses(start), ['active', 'pending', 'pending', 'pending']);
  start.details.items[0].title = 'external mutation';
  const listed = await h.call({ action: 'list' });
  assert.equal(listed.details.items[0].title, 'Plan');
  listed.structuredContent.items[0].status = 'pending';
  assert.equal((await h.call({ action: 'list' })).details.items[0].status, 'done');
});

test('restoration skips malformed snapshots and honors the latest valid empty snapshot', async () => {
  const h = await harness();
  const start = await h.call({ action: 'new', items: titles });
  const entry = data => ({ type: 'custom', customType: 'todo_state', data });
  const valid = entry({ schemaVersion: 2, items: start.details.items });
  for (const data of [
    null,
    { schemaVersion: 1, items: [] },
    { schemaVersion: 2, items: [{ id: 1, title: ' ', status: 'active' }] },
    { schemaVersion: 2, items: [start.details.items[0], start.details.items[0]] },
    { schemaVersion: 2, items: start.details.items.map(item => ({ ...item, status: 'active' })) },
  ]) {
    await h.event('session_tree', [valid, entry(data)]);
    assert.deepEqual(statuses(await h.call({ action: 'list' })), ['active', 'pending', 'pending', 'pending']);
  }
  await h.event('session_tree', [valid, entry({ schemaVersion: 2, items: [] })]);
  assert.deepEqual((await h.call({ action: 'list' })).details.items, []);
});

test('widget keeps its layout, pulse and width limits without replacement on reads', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let widget;
  let replacements = 0;
  let renders = 0;
  const theme = {
    fg: (_color, text) => text, bold: text => text, strikethrough: text => text,
  };
  const h = await harness({
    setWidget: (_id, factory) => {
      widget?.dispose();
      widget = factory?.({ requestRender: () => renders++ }, theme);
      replacements++;
    },
  });
  t.after(() => widget?.dispose());
  await h.call({ action: 'new', items: Array.from({ length: 12 }, (_, i) => `Phase ${i + 1}`) });
  await h.call({ action: 'update', completedIds: [1, 2], activeId: 10 });
  const wide = widget.render(80).join('\n');
  assert.match(wide, /Todos 2\/12/);
  assert.match(wide, /├─ ● 10\. Phase 10/);
  assert.match(wide, /\+3 more \(1 open, 2 done\)/);
  for (const width of [20, 1, 80]) {
    assert.ok(widget.render(width).every(line => visibleWidth(line) <= width));
  }
  const count = replacements;
  await h.call({ action: 'list' });
  await h.call({ action: 'update', activeId: 10 });
  assert.equal(replacements, count);
  t.mock.timers.tick(1000);
  assert.equal(renders, 1);
  assert.match(widget.render(80).join('\n'), /├─ ○ 10\. Phase 10/);
  widget.invalidate();
  assert.match(widget.render(80).join('\n'), /Todos 2\/12/);
  await h.call({ action: 'clear' });
  assert.equal(widget, undefined);
  t.mock.timers.tick(1000);
  assert.equal(renders, 1, 'disposed widgets stop requesting renders');
});

test('activeId-only jumps independently, and no-op updates do not persist', async () => {
  const h = await harness();
  const started = await h.call({ action: 'new', items: titles });
  assert.equal(started.content[0].text, 'Started with #1 Plan.');
  assert.deepEqual(started.structuredContent.items.map(({ id }) => id), [1, 2, 3, 4]);
  const jump = await h.call({ action: 'update', activeId: 3 });
  assert.deepEqual(statuses(jump), ['pending', 'pending', 'active', 'pending']);
  assert.equal(jump.structuredContent.activatedId, 3);
  assert.equal(jump.content[0].text, 'Active: #3 Verify');
  const count = h.persisted.length;
  const repeat = await h.call({ action: 'update', activeId: 3 });
  assert.equal(repeat.isError, false);
  assert.equal(h.persisted.length, count);
});

test('batch completion auto-advances, explicit activeId overrides, all done auto-clears', async () => {
  const h = await harness();
  await h.call({ action: 'new', items: titles });
  const batch = await h.call({ action: 'update', completedIds: [1, 2] });
  assert.deepEqual(statuses(batch), ['done', 'done', 'active', 'pending']);
  assert.deepEqual(batch.structuredContent.completedIds, [1, 2]);
  await h.call({ action: 'new', items: titles });
  const override = await h.call({ action: 'update', completedIds: [1], activeId: 4 });
  assert.deepEqual(statuses(override), ['done', 'pending', 'pending', 'active']);
  const repeated = await h.call({ action: 'update', completedIds: [1] });
  assert.deepEqual(repeated.structuredContent.completedIds, []);
  assert.equal(repeated.isError, false);
  const done = await h.call({ action: 'update', completedIds: [2, 3, 4] });
  assert.deepEqual(done.structuredContent.items, []);
  assert.equal(done.structuredContent.cleared, true);
  assert.equal(done.content[0].text, 'All phases complete.');
  assert.equal((await h.call({ action: 'list' })).content[0].text, 'No active todo tracker.');
});

test('invalid requests validate every ID before mutation and preserve state/persistence', async () => {
  const h = await harness();
  await h.call({ action: 'new', items: titles });
  await h.call({ action: 'update', completedIds: [2] });
  const before = (await h.call({ action: 'list' })).structuredContent.items;
  const count = h.persisted.length;
  const invalid = [
    { action: 'update' },
    { action: 'update', completedIds: [1, 99] },
    { action: 'update', completedIds: [1], activeId: 99 },
    { action: 'update', completedIds: [1], activeId: 2 },
    { action: 'update', completedIds: [1], activeId: 1 },
    { action: 'update', activeId: 2 },
    { action: 'new', items: [' '] },
    { action: 'list', activeId: 3 },
    { action: 'clear', completedIds: [1] },
  ];
  for (const params of invalid) {
    const result = await h.call(params);
    assert.equal(result.isError, true, JSON.stringify(params));
    assert.deepEqual(result.structuredContent.items, before);
    assert.equal(h.persisted.length, count);
    assert.deepEqual((await h.call({ action: 'list' })).structuredContent.items, before);
  }
  for (const params of [
    { action: 'bogus' },
    { action: 'update', completedIds: [] },
    { action: 'update', completedIds: [], activeId: 3 },
    { action: 'update', completedIds: [1, 1] },
    { action: 'update', completedIds: [0] },
    { action: 'update', activeId: 1.5 },
  ]) assert.equal(Check(h.tool.parameters, params), false);
  assert.equal(Check(h.tool.parameters, { action: 'update', activeId: 3 }), true);
});

test('output covers empty actions/errors and clear retains existing text/details', async () => {
  const h = await harness();
  await h.call({ action: 'list' });
  const missing = await h.call({ action: 'update', activeId: 1 });
  assert.equal(missing.isError, true);
  const empty = await h.call({ action: 'clear' });
  assert.equal(empty.isError, false);
  assert.equal(h.persisted.length, 0);
  await h.call({ action: 'new', items: titles });
  const cleared = await h.call({ action: 'clear' });
  assert.equal(cleared.content[0].text, 'Cleared todo tracker.');
  assert.equal(cleared.structuredContent.cleared, true);
  assert.deepEqual(cleared.structuredContent.items, []);
});

test('branch restoration uses tool details/custom snapshots, compaction persists unchanged state', async () => {
  const h = await harness();
  const start = await h.call({ action: 'new', items: titles });
  const jump = await h.call({ action: 'update', activeId: 3 });
  const toolEntry = (result) => ({ type: 'message', message: { role: 'toolResult', toolName: 'todo', details: result.details } });
  await h.event('session_tree', [toolEntry(start)]);
  assert.deepEqual(statuses(await h.call({ action: 'list' })), ['active', 'pending', 'pending', 'pending']);
  await h.event('session_start', [toolEntry(start), toolEntry(jump)]);
  assert.deepEqual(statuses(await h.call({ action: 'list' })), ['pending', 'pending', 'active', 'pending']);
  await h.event('session_compact');
  assert.equal(h.messages.length, 1);
  const snapshot = h.persisted.at(-1);
  assert.equal(snapshot.data.schemaVersion, 2);
  await h.event('session_tree', [snapshot]);
  assert.deepEqual(statuses(await h.call({ action: 'list' })), ['pending', 'pending', 'active', 'pending']);
  await h.event('session_tree', []);
  assert.deepEqual((await h.call({ action: 'list' })).structuredContent.items, []);
});
