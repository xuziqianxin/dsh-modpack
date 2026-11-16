import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');
const SOURCE = fs.readFileSync(CLIENT, 'utf8');

// 用 new Function 在同一个 realm 里求值：vm 沙箱会给数组/对象不同的原型，
// 之后每个断言都得跨 realm 比较，反而更难读。
const loadCalls = [];
const windowStub = { __ModuleLoader__: { load(spec) { loadCalls.push(spec); } } };

// fetch / location 只在模块的函数内部被调用，用一趟转发让每个用例都能换桩。
let fetchImpl = () => { throw new Error('fetch stub not installed'); };
const fetchStub = (...args) => fetchImpl(...args);

const evaluate = new Function('window', 'fetch', 'location', 'setTimeout', 'clearTimeout', SOURCE);
evaluate(windowStub, fetchStub, undefined, setTimeout, clearTimeout);

const spec = loadCalls[0];
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  throw new Error('客户端只允许 require(react)，实际收到：' + name);
});
const I = mod.__internals;

// ---------- CONTRACT.md 的 StatePayload 样例 ----------

function samplePayload(over) {
  const base = {
    seeded: false,
    mode: 'ready',
    state: {
      version: 1,
      commonEnabled: true,
      activePackId: 'p1',
      packs: [
        {
          id: 'common', name: '公共插件', always: true, bundles: ['dsh-token-effi'], note: '',
          createdAt: '2024-05-01T00:00:00.000Z', updatedAt: '2024-05-01T00:00:00.000Z',
        },
        {
          id: 'p1', name: '编程整合包', always: false, bundles: ['dsh-token-effi', 'dsh-idle'], note: '',
          createdAt: '2024-05-02T00:00:00.000Z', updatedAt: '2024-05-02T00:00:00.000Z',
        },
      ],
      lastApplied: null,
    },
    bundles: [
      { name: 'dsh-token-effi', label: '效费比洞察', enabled: true, installed: true, protected: false, togglable: true },
      { name: 'dsh-idle', label: '闲置插件', enabled: false, installed: true, protected: false, togglable: true },
      { name: 'dsh-broken', label: '加载失败插件', enabled: false, installed: true, protected: false, togglable: false, error: '入口解析失败' },
      { name: 'dsh-base', label: 'DSH 基座', enabled: true, installed: true, protected: true, togglable: false, reason: 'DSH 基座，始终开启' },
      { name: 'dsh-modpack', label: '整合包', enabled: true, installed: true, protected: true, togglable: false, reason: '本插件自身，始终开启' },
    ],
    effective: {
      desiredEnabled: ['dsh-token-effi'],
      currentlyEnabled: ['dsh-token-effi'],
      drift: false,
      protected: ['dsh-base', 'dsh-modpack'],
    },
  };
  return Object.assign({}, base, over || {});
}

function render(node) {
  return renderToStaticMarkup(node);
}

// ---------- 1. 模块形态与注册块 ----------

test('模块只注册 1 个 plugins.tab，且 id/order/label/inject 符合 CONTRACT', () => {
  assert.equal(loadCalls.length, 1, 'load 只应被调用一次');
  assert.equal(spec.id, 'dsh-modpack');
  assert.deepEqual(mod.inject, ['slots']);

  const injected = [];
  const registered = [];
  const ctx = {
    slots: {
      inject(name, cb) { injected.push(name); cb(); },
      register(entry, Component) { registered.push({ entry, Component }); },
    },
  };
  mod.apply(ctx);

  assert.deepEqual(injected, ['plugins.tab']);
  assert.equal(registered.length, 1, '只允许注册一个槽位');
  assert.equal(registered[0].entry.name, 'plugins.tab');
  assert.equal(registered[0].entry.id, 'modpack');
  assert.equal(registered[0].entry.order, 20);
  assert.equal(typeof registered[0].entry.label, 'function', 'label 用函数形式，插件页 tab 台账会解析它');
  assert.equal(registered[0].entry.label(), '整合包');
  assert.equal(typeof registered[0].Component, 'function', '注册的必须是组件函数');
});

test('客户端只用 react，不出现 JSX 构建语法', () => {
  assert.ok(!/\brequire\((['"])(?!react\1)/.test(SOURCE), '不得 require react 以外的包');
  assert.ok(!/<[A-Z][A-Za-z]*\s+[a-zA-Z]+=/.test(SOURCE), '不应出现 JSX 标签');
});

// ---------- 2. fetch 路由与外壳 ----------

test('6 条路由与 CONTRACT 完全一致', () => {
  const rel = new Set();
  const re = /API \+ '([^']+)'/g;
  let m;
  while ((m = re.exec(SOURCE))) rel.add(m[1]);
  const actual = [...rel].map((p) => '/api/dsh-modpack' + p).sort();
  assert.deepEqual(actual, [
    '/api/dsh-modpack/common',
    '/api/dsh-modpack/pack/adopt',
    '/api/dsh-modpack/pack/delete',
    '/api/dsh-modpack/pack/save',
    '/api/dsh-modpack/state',
    '/api/dsh-modpack/switch',
  ]);
});

test('{ok,value} / {ok,error} 外壳被统一处理', async () => {
  const payload = samplePayload();
  const calls = [];
  fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { json: async () => ({ ok: true, value: payload }) };
  };
  const value = await I.request('/api/dsh-modpack/state', { method: 'GET' });
  assert.deepEqual(value, payload);
  assert.equal(calls[0].url, '/api/dsh-modpack/state');

  fetchImpl = async () => ({ json: async () => ({ ok: false, error: { code: 'protected-pack', message: 'common 不能删除' } }) });
  await assert.rejects(
    () => I.request('/api/dsh-modpack/pack/delete', { method: 'POST' }),
    (e) => e.message.includes('受保护的整合包不能这样操作') && e.message.includes('common 不能删除'),
  );

  fetchImpl = async () => ({ json: async () => { throw new Error('not json'); } });
  await assert.rejects(() => I.request('/api/dsh-modpack/state', {}), /无法解析的响应/);

  fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => I.request('/api/dsh-modpack/state', {}), /连不上 DSH 服务/);
});

// ---------- 3. SSR 渲染 ----------

test('SSR：空 props 不抛，显示读取中', () => {
  const html = render(React.createElement(I.ModpackView, {}));
  assert.match(html, /正在读取整合包状态/);

  // 容器层同样必须能在空 props 下渲染（effect 在 SSR 里不跑）。
  const tab = render(React.createElement(I.ModpackTab, {}));
  assert.match(tab, /正在读取整合包状态/);
});

test('SSR：ready 状态渲染整合包名、插件名、受保护原因、分组', () => {
  const html = render(React.createElement(I.ModpackView, { data: samplePayload() }));

  assert.match(html, /编程整合包/, '应出现整合包名');
  assert.match(html, /公共插件/);
  assert.match(html, /效费比洞察/, '应出现插件 label');
  assert.match(html, /闲置插件/);
  assert.match(html, /DSH 基座，始终开启/, '应出现受保护原因');
  assert.match(html, /加载失败插件/);
  assert.match(html, /入口解析失败/, '不可切换插件应展示 error 作为原因');
  assert.match(html, /已启用（1）/);
  assert.match(html, /未启用（1）/);
  assert.match(html, /受保护 \/ 不可切换（3）/);
  assert.match(html, /当前整合包：编程整合包/);
  assert.match(html, /公共整合包（常开白名单）/);
  assert.match(html, /aria-pressed="true"/, '选中的整合包行要带 aria-pressed');
  assert.match(html, /<button[^>]*>切换<\/button>/, '切换必须是真 button');
});

test('SSR：切换报告显示 启用 n / 关闭 m / 需重启 k', () => {
  const report = {
    packId: 'p1',
    enabled: ['a', 'b'],
    disabled: ['c'],
    skipped: [],
    failed: [],
    restartRequired: [],
    applied: 'applied',
  };
  const html = render(React.createElement(I.ModpackView, { data: samplePayload(), report }));
  assert.match(html, /启用 2 \/ 关闭 1 \/ 需重启 0/);
  assert.match(html, /已生效/);
  assert.match(html, /800 毫秒后自动刷新页面/);
});

test('SSR：applied=noop 显示无需变更、且不承诺自动刷新', () => {
  const report = {
    packId: 'p1', enabled: [], disabled: [], skipped: [],
    failed: [], restartRequired: [], applied: 'noop',
  };
  const html = render(React.createElement(I.ModpackView, { data: samplePayload(), report }));
  assert.match(html, /启用 0 \/ 关闭 0 \/ 需重启 0/);
  assert.match(html, /无需变更/);
  assert.ok(!html.includes('800 毫秒后自动刷新页面'), 'noop 不得提示自动刷新');
  assert.ok(!html.includes('重试'), 'noop 不是失败，不该出现重试');
});

test('SSR：applied=applied 仍提示自动刷新', () => {
  const report = {
    packId: 'p1', enabled: ['a'], disabled: [], skipped: [],
    failed: [], restartRequired: [], applied: 'applied',
  };
  const html = render(React.createElement(I.ModpackView, { data: samplePayload(), report }));
  assert.match(html, /800 毫秒后自动刷新页面/);
});

test('SSR：有 failed 项时显示错误与重试，不提示自动刷新', () => {
  const report = {
    packId: 'p1', enabled: [], disabled: [], skipped: [],
    failed: [{ name: 'dsh-idle', message: '入口报错' }],
    restartRequired: [], applied: 'partial',
  };
  const html = render(React.createElement(I.ModpackView, { data: samplePayload(), report }));
  assert.match(html, /失败 1 项：dsh-idle（入口报错）/);
  assert.match(html, /重试/);
  assert.match(html, /部分失败/);
  assert.ok(!html.includes('800 毫秒后自动刷新页面'), '有失败项不得提示自动刷新');
});

test('SSR：readonly 分支只读并说明原因、按钮禁用', () => {
  const html = render(React.createElement(I.ModpackView, { data: samplePayload({ mode: 'readonly' }) }));
  assert.match(html, /只读模式/);
  assert.match(html, /插件管理服务/);
  assert.ok((html.match(/disabled=""/g) || []).length >= 6, 'readonly 时控件应全部禁用');
  assert.match(html, /编程整合包/, '只读仍然要能看到内容');
});

test('SSR：seeded 分支给出「从当前配置另存为整合包」引导', () => {
  const seeded = samplePayload({
    seeded: true,
    state: {
      version: 1,
      commonEnabled: true,
      activePackId: null,
      packs: [{
        id: 'common', name: '公共插件', always: true, bundles: [], note: '',
        createdAt: '2024-05-01T00:00:00.000Z', updatedAt: '2024-05-01T00:00:00.000Z',
      }],
      lastApplied: null,
    },
  });
  const html = render(React.createElement(I.ModpackView, { data: seeded }));
  assert.match(html, /首次使用/);
  assert.match(html, /从当前配置另存为整合包/);
  assert.match(html, /当前整合包：未选择（只保留公共白名单）/);
});

test('SSR：warning 与错误条也渲染', () => {
  const html = render(React.createElement(I.ModpackView, {
    data: samplePayload({ warning: 'state.json 已损坏，备份为 state.json.bak-1' }),
    error: '插件管理服务不可用：超时',
  }));
  assert.match(html, /state\.json 已损坏/);
  assert.match(html, /操作失败：插件管理服务不可用：超时/);
});

test('SSR：三种分支都不漏 undefined / NaN / [object Object]', () => {
  const seeded = samplePayload({
    seeded: true,
    state: {
      version: 1, commonEnabled: true, activePackId: null, packs: [],
      lastApplied: { at: '2024-05-03T01:02:03.000Z', packId: null, enabled: [], disabled: [], failed: [], restartRequired: [] },
    },
  });
  for (const data of [samplePayload(), samplePayload({ mode: 'readonly' }), seeded]) {
    const html = render(React.createElement(I.ModpackView, { data }));
    assert.ok(!html.includes('undefined'), '渲染结果里漏了 undefined：' + html.slice(0, 200));
    assert.ok(!html.includes('NaN'), '渲染结果里出现 NaN');
    assert.ok(!html.includes('[object Object]'), '渲染结果里出现 [object Object]');
  }
});

// ---------- 4. __internals 纯函数 ----------

test('groupBundles 分成 已启用 / 未启用 / 不可切换 三组', () => {
  const g = I.groupBundles(samplePayload().bundles);
  assert.deepEqual(g.enabled.map((b) => b.name), ['dsh-token-effi']);
  assert.deepEqual(g.disabled.map((b) => b.name), ['dsh-idle']);
  assert.deepEqual(g.locked.map((b) => b.name), ['dsh-broken', 'dsh-base', 'dsh-modpack']);
  assert.deepEqual(I.groupBundles(null), { enabled: [], disabled: [], locked: [] });
});

test('diffText 描述漂移', () => {
  assert.equal(I.diffText({ desiredEnabled: ['a'], currentlyEnabled: ['a'] }), '当前启用状态与整合包预期一致');
  assert.equal(
    I.diffText({ desiredEnabled: ['a', 'b'], currentlyEnabled: ['a', 'c'] }),
    '与预期不一致：待启用 1 个、待关闭 1 个',
  );
  assert.equal(I.diffText(null), '启用状态未知');
});

test('reportText / appliedText 文案', () => {
  assert.equal(I.reportText({ enabled: ['a', 'b'], disabled: ['c'], restartRequired: ['d'] }), '启用 2 / 关闭 1 / 需重启 1');
  assert.equal(I.reportText(null), '');
  assert.equal(I.appliedText('applied'), '已生效');
  assert.equal(I.appliedText('restart-required'), '重启后生效');
  assert.equal(I.appliedText('partial'), '部分失败');
  assert.equal(I.appliedText('noop'), '无需变更');
  assert.equal(I.appliedText('???'), '已提交');
});

test('errorText 覆盖 CONTRACT 的 5 个错误码', () => {
  assert.equal(I.errorText({ code: 'no-plugin-manager' }), '插件管理服务不可用');
  assert.equal(I.errorText({ code: 'unknown-pack', message: 'xyz' }), '找不到这个整合包：xyz');
  assert.equal(I.errorText({ code: 'invalid-input' }), '参数不合法');
  assert.equal(I.errorText({ code: 'protected-pack' }), '受保护的整合包不能这样操作');
  assert.equal(I.errorText({ code: 'internal' }), '服务端内部错误');
  assert.equal(I.errorText({ code: 'weird' }), '操作失败');
  assert.equal(I.errorText(null), '未知错误');
});

test('readEnvelope 两个方向', () => {
  assert.deepEqual(I.readEnvelope({ ok: true, value: { a: 1 } }), { ok: true, value: { a: 1 } });
  assert.deepEqual(I.readEnvelope({ ok: false, error: { code: 'internal', message: 'x' } }),
    { ok: false, error: { code: 'internal', message: 'x' } });
  assert.deepEqual(I.readEnvelope({ ok: false }), { ok: false, error: { code: 'internal', message: '' } });
  assert.equal(I.readEnvelope(null).ok, false);
});

test('shouldAutoReload：只有真改了插件才自动刷新', () => {
  assert.equal(I.shouldAutoReload(null), false);
  assert.equal(I.shouldAutoReload({ failed: [], applied: 'applied' }), true);
  assert.equal(I.shouldAutoReload({ failed: [], applied: 'restart-required' }), true);
  assert.equal(I.shouldAutoReload({ failed: [], applied: 'noop' }), false, 'noop 不该刷新页面');
  assert.equal(I.shouldAutoReload({ applied: 'noop' }), false);
  assert.equal(I.shouldAutoReload({ failed: [{ name: 'x', message: 'y' }], applied: 'partial' }), false);
});

test('toggleMember / sameMembers', () => {
  assert.deepEqual(I.toggleMember([], 'a'), ['a']);
  assert.deepEqual(I.toggleMember(['a', 'b'], 'a'), ['b']);
  const base = ['a'];
  I.toggleMember(base, 'c');
  assert.deepEqual(base, ['a'], '不应就地修改入参');
  assert.equal(I.sameMembers(['a', 'b'], ['b', 'a']), true);
  assert.equal(I.sameMembers(['a'], ['a', 'b']), false);
  assert.equal(I.sameMembers(['a', 'c'], ['a', 'b']), false);
});

test('newestPack 取最近保存的包，currentlyEnabledTogglable 只取可切换且启用的', () => {
  assert.equal(I.newestPack(samplePayload().state.packs).id, 'p1');
  assert.equal(I.newestPack([]), null);
  assert.deepEqual(I.currentlyEnabledTogglable(samplePayload()), ['dsh-token-effi']);
});
