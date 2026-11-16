import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const STATE_DIR = (home) => join(home, 'dsh-modpack')
const STATE_PATH = (home) => join(STATE_DIR(home), 'state.json')
const ISO = '2024-01-01T00:00:00.000Z'

const bundle = (overrides) => ({
  name: 'dsh-x',
  official: true,
  optional: true,
  installed: true,
  enabled: false,
  rows: [],
  overrides: [],
  ...overrides,
})

const commonPack = (bundles = []) => ({
  id: 'common', name: '公共插件', always: true, bundles, note: '', createdAt: ISO, updatedAt: ISO,
})

const pack = (id, bundles = [], extra = {}) => ({
  id, name: '整合包' + id, always: false, bundles, note: '', createdAt: ISO, updatedAt: ISO, ...extra,
})

const stateFixture = ({ commonEnabled = true, activePackId = null, packs, lastApplied = null } = {}) => ({
  version: 1, commonEnabled, activePackId, packs: packs ?? [commonPack()], lastApplied,
})

function writeStateFile(home, state) {
  mkdirSync(STATE_DIR(home), { recursive: true })
  writeFileSync(STATE_PATH(home), JSON.stringify(state), 'utf8')
}

const readStateFile = (home) => JSON.parse(readFileSync(STATE_PATH(home), 'utf8'))

/**
 * 可编程 pluginManager：listBundles 每次返回当前快照，setBundleEnabled 记录调用并就地改快照，
 * 这样「切换后再次读到的状态」和真实 DSH 的行为一致。
 */
function makeManager(list) {
  const snapshot = list.map((item) => ({ ...item }))
  const calls = []
  let running = 0
  let maxConcurrent = 0
  const manager = {
    calls,
    get maxConcurrent() { return maxConcurrent },
    delay: 0,
    onCall: null,
    outcome: null,
    async listBundles() {
      return snapshot.map((item) => ({ ...item }))
    },
    async setBundleEnabled(name, enabled) {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      try {
        calls.push({ name, enabled })
        if (manager.delay > 0) await new Promise((resolve) => setTimeout(resolve, manager.delay))
        if (manager.onCall) manager.onCall(name, enabled)
        const target = snapshot.find((item) => item.name === name)
        if (target) target.enabled = enabled
        if (manager.outcome) {
          const result = manager.outcome(name, enabled)
          if (result !== undefined) return result
        }
        return { changed: true, application: 'applied', stage: 'enable', target: name, enabled }
      } finally {
        running -= 1
      }
    },
    setEnabled(name, enabled) {
      const target = snapshot.find((item) => item.name === name)
      if (target) target.enabled = enabled
    },
  }
  return manager
}

function harness({ home, manager }) {
  const routes = []
  const warned = []
  const ctx = {
    logger: { info() {}, warn(message) { warned.push(String(message)) } },
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name === 'pluginManager') return manager
      return undefined
    },
    effect(fn) { return fn() },
    inject(deps, callback) {
      const scoped = {
        get(name) {
          if (name === 'connection') {
            return { fetch: { register(route) { routes.push(route); return async () => {} } } }
          }
          if (name === 'pluginManager') return manager
          return undefined
        },
      }
      callback(scoped)
    },
  }
  apply(ctx)

  const call = async (path, body) => {
    const route = routes.find((item) => item.path === path)
    assert.ok(route, '路由未注册：' + path)
    const init = { method: route.methods[0] }
    if (body !== undefined) {
      init.body = JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    const response = await route.fetch(new Request('http://test' + path, init))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.equal(typeof payload.ok, 'boolean')
    return payload
  }

  return { routes, warned, call, value: async (path) => (await call(path)).value }
}

const home0 = () => mkdtempSync(join(tmpdir(), 'dsh-modpack-'))
const byName = (payload, name) => payload.value.bundles.find((item) => item.name === name)

// ── 1. 首次运行 ────────────────────────────────────────────────────────────
test('首次运行无 state.json：返回 seed，不写盘', async () => {
  const home = home0()
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: true })])
  const { value } = harness({ home, manager })

  const payload = await value('/api/dsh-modpack/state')

  assert.equal(payload.seeded, true)
  assert.equal(payload.mode, 'ready')
  assert.equal(payload.state.activePackId, null)
  assert.equal(payload.state.commonEnabled, true)
  assert.equal(payload.state.lastApplied, null)
  assert.equal(payload.state.packs.length, 1)
  assert.equal(payload.state.packs[0].id, 'common')
  assert.equal(payload.state.packs[0].always, true)
  assert.deepEqual(payload.state.packs[0].bundles, [])
  assert.equal(payload.warning, undefined)
  assert.equal(existsSync(STATE_PATH(home)), false, '首次运行不得写盘')
  assert.equal(manager.calls.length, 0)
})

// ── 2. 状态文件损坏 ────────────────────────────────────────────────────────
test('状态文件损坏：备份为 state.json.bak-*，按首次运行返回并带 warning', async () => {
  const home = home0()
  mkdirSync(STATE_DIR(home), { recursive: true })
  writeFileSync(STATE_PATH(home), '{ this is not json', 'utf8')
  const { value } = harness({ home, manager: makeManager([]) })

  const payload = await value('/api/dsh-modpack/state')

  assert.equal(payload.seeded, true)
  assert.equal(typeof payload.warning, 'string')
  assert.match(payload.warning, /损坏/)
  const backups = readdirSync(STATE_DIR(home)).filter((name) => name.startsWith('state.json.bak-'))
  assert.equal(backups.length, 1, '损坏文件必须先备份：' + JSON.stringify(readdirSync(STATE_DIR(home))))
  assert.equal(readFileSync(join(STATE_DIR(home), backups[0]), 'utf8'), '{ this is not json')
  assert.equal(payload.state.packs.length, 1)
  assert.equal(payload.state.packs[0].id, 'common')
})

// ── 3. GET state 投影 ──────────────────────────────────────────────────────
test('GET state：bundles 投影正确（label 退化 / 受保护最后排 / reason 中文）', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ activePackId: 'p1', packs: [commonPack(['dsh-alpha']), pack('p1', ['dsh-beta'])] }))
  const manager = makeManager([
    bundle({ name: 'dsh-base-core', official: true, optional: false, enabled: true }),
    bundle({ name: 'dsh-alpha', enabled: true, meta: { title: '阿尔法' } }),
    bundle({ name: 'dsh-beta', enabled: false, meta: { title: { en: 'Beta', 'zh-cn': '贝塔' } } }),
    bundle({ name: 'dsh-gamma', installed: false }),
    bundle({ name: 'dsh-err', enabled: true, error: { code: 'operation-error' } }),
    bundle({ name: 'dsh-delta', enabled: false, meta: { title: '德尔塔' } }),
  ])
  const { value } = harness({ home, manager })

  const payload = await value('/api/dsh-modpack/state')

  assert.equal(payload.seeded, false)
  // 排序按 label 的码位：拉丁/符号在前，中文标签在后；受保护的一律沉底。
  assert.deepEqual(payload.bundles.map((item) => item.name), ['dsh-err', 'dsh-gamma', 'dsh-delta', 'dsh-beta', 'dsh-alpha', 'dsh-base-core'])
  assert.equal(byName({ value: payload }, 'dsh-alpha').label, '阿尔法')
  assert.equal(byName({ value: payload }, 'dsh-beta').label, '贝塔', '本地化标题应取中文')
  assert.equal(byName({ value: payload }, 'dsh-gamma').label, 'dsh-gamma', '没有 meta 时退化为包名')
  assert.equal(byName({ value: payload }, 'dsh-base-core').reason, 'DSH 基座，始终开启')
  assert.match(byName({ value: payload }, 'dsh-gamma').reason, /未安装/)
  assert.match(byName({ value: payload }, 'dsh-err').reason, /加载出错/)
  assert.match(byName({ value: payload }, 'dsh-delta').reason, /白名单/)
  assert.equal(byName({ value: payload }, 'dsh-alpha').reason, undefined)
  assert.equal(payload.bundles.at(-1).protected, true, '受保护的必须排在最后')

  assert.deepEqual(payload.effective.desiredEnabled, ['dsh-alpha', 'dsh-beta'])
  assert.deepEqual(payload.effective.currentlyEnabled, ['dsh-alpha'])
  assert.deepEqual(payload.effective.protected, ['dsh-base-core'])
  assert.equal(payload.effective.drift, true)
})

// ── 4. protected 三条规则 ─────────────────────────────────────────────────
test('protected：readOnlyReason / official&&!optional / 自己的包名 三条规则各自生效', async () => {
  const home = home0()
  const manager = makeManager([
    bundle({ name: 'dsh-readonly', readOnlyReason: 'management-required', enabled: true }),
    bundle({ name: 'dsh-base-core', official: true, optional: false, enabled: true }),
    bundle({ name: 'dsh-modpack', official: false, optional: false, enabled: true }),
    bundle({ name: 'dsh-free', official: true, optional: true, enabled: true }),
  ])
  const { value } = harness({ home, manager })
  const payload = await value('/api/dsh-modpack/state')

  const readonly = payload.bundles.find((item) => item.name === 'dsh-readonly')
  const base = payload.bundles.find((item) => item.name === 'dsh-base-core')
  const self = payload.bundles.find((item) => item.name === 'dsh-modpack')
  const free = payload.bundles.find((item) => item.name === 'dsh-free')

  assert.equal(readonly.protected, true)
  assert.equal(readonly.togglable, false)
  assert.equal(readonly.reason, '由 DSH 管理层接管，无法用开关切换')
  assert.equal(base.protected, true)
  assert.equal(base.reason, 'DSH 基座，始终开启')
  assert.equal(self.protected, true)
  assert.equal(self.reason, '本整合包自身，始终开启')
  assert.equal(free.protected, false)
  assert.equal(free.togglable, true)
  assert.deepEqual(payload.effective.protected, ['dsh-base-core', 'dsh-modpack', 'dsh-readonly'])
})

// ── 5. switch ─────────────────────────────────────────────────────────────
test('switch：只动状态不一致的，always ∪ 目标包语义，activePackId 落盘', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ packs: [commonPack(['dsh-alpha']), pack('p1', ['dsh-gamma'])] }))
  const manager = makeManager([
    bundle({ name: 'dsh-base-core', official: true, optional: false, enabled: true }),
    bundle({ name: 'dsh-alpha', enabled: false }),
    bundle({ name: 'dsh-beta', enabled: true }),
    bundle({ name: 'dsh-gamma', enabled: true }),
  ])
  const { call } = harness({ home, manager })

  const response = await call('/api/dsh-modpack/switch', { id: 'p1' })

  assert.equal(response.ok, true)
  const report = response.value.switch
  assert.deepEqual(manager.calls, [{ name: 'dsh-alpha', enabled: true }, { name: 'dsh-beta', enabled: false }])
  assert.deepEqual(report.enabled, ['dsh-alpha'])
  assert.deepEqual(report.disabled, ['dsh-beta'])
  assert.deepEqual(report.skipped, ['dsh-gamma'])
  assert.deepEqual(report.failed, [])
  assert.deepEqual(report.restartRequired, [])
  assert.equal(report.applied, 'applied')
  assert.equal(report.packId, 'p1')

  assert.deepEqual(response.value.effective.desiredEnabled, ['dsh-alpha', 'dsh-gamma'])
  assert.deepEqual(response.value.effective.currentlyEnabled, ['dsh-alpha', 'dsh-gamma'])
  assert.equal(response.value.effective.drift, false)

  const saved = readStateFile(home)
  assert.equal(saved.activePackId, 'p1')
  assert.equal(saved.lastApplied.packId, 'p1')
  assert.deepEqual(saved.lastApplied.enabled, ['dsh-alpha'])
  assert.deepEqual(saved.lastApplied.disabled, ['dsh-beta'])
})

test('switch 遇到 restart-required：applied=restart-required 且 restartRequired 非空', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ packs: [commonPack(), pack('p1', ['dsh-alpha'])] }))
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: false })])
  manager.outcome = (name, enabled) => ({ changed: true, application: 'restart-required', restartReason: 'no-hmr', stage: 'enable', target: name, enabled })
  const { call } = harness({ home, manager })

  const response = await call('/api/dsh-modpack/switch', { id: 'p1' })

  const report = response.value.switch
  assert.equal(report.applied, 'restart-required')
  assert.deepEqual(report.restartRequired, ['dsh-alpha'])
  assert.deepEqual(report.enabled, ['dsh-alpha'])
  assert.deepEqual(report.failed, [])
  assert.deepEqual(readStateFile(home).lastApplied.restartRequired, ['dsh-alpha'])
})

test('switch 中单个 bundle 抛错：计入 failed，applied=partial，其余继续', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ packs: [commonPack(), pack('p1', ['dsh-alpha', 'dsh-beta', 'dsh-gamma'])] }))
  const manager = makeManager([
    bundle({ name: 'dsh-alpha', enabled: false }),
    bundle({ name: 'dsh-beta', enabled: false }),
    bundle({ name: 'dsh-gamma', enabled: false }),
  ])
  manager.onCall = (name) => { if (name === 'dsh-beta') throw new Error('设置失败') }
  const { call } = harness({ home, manager })

  const response = await call('/api/dsh-modpack/switch', { id: 'p1' })

  const report = response.value.switch
  assert.deepEqual(manager.calls.map((item) => item.name), ['dsh-alpha', 'dsh-beta', 'dsh-gamma'])
  assert.deepEqual(report.failed, [{ name: 'dsh-beta', message: '设置失败' }])
  assert.deepEqual(report.enabled, ['dsh-alpha', 'dsh-gamma'])
  assert.equal(report.applied, 'partial')
  assert.deepEqual(readStateFile(home).lastApplied.failed, [{ name: 'dsh-beta', message: '设置失败' }])
})

test('switch 未知整合包：unknown-pack，不动任何插件', async () => {
  const home = home0()
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: true })])
  const { call } = harness({ home, manager })

  const response = await call('/api/dsh-modpack/switch', { id: 'nope' })

  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'unknown-pack')
  assert.match(response.error.message, /nope/)
  assert.equal(manager.calls.length, 0)
})

// ── 6. pack/save ──────────────────────────────────────────────────────────
test('pack/save：新建、common 的 always 锁定 true、非法输入 invalid-input', async () => {
  const home = home0()
  const { call } = harness({ home, manager: makeManager([bundle({ name: 'dsh-alpha', enabled: true })]) })

  const created = await call('/api/dsh-modpack/pack/save', { name: '游戏整合包', bundles: ['dsh-alpha', 'dsh-beta', 'dsh-alpha'], note: '打游戏用' })
  assert.equal(created.ok, true)
  assert.equal(created.value.state.packs.length, 2)
  const fresh = created.value.state.packs[1]
  assert.equal(typeof fresh.id, 'string')
  assert.ok(fresh.id.length >= 32, '新建整合包应派 randomUUID')
  assert.equal(fresh.name, '游戏整合包')
  assert.equal(fresh.always, false)
  assert.equal(fresh.note, '打游戏用')
  assert.deepEqual(fresh.bundles, ['dsh-alpha', 'dsh-beta'])
  assert.equal(created.value.seeded, false)

  const common = await call('/api/dsh-modpack/pack/save', { id: 'common', name: '公共插件', always: false, bundles: ['dsh-alpha'], note: '常开' })
  assert.equal(common.ok, true)
  const savedCommon = common.value.state.packs.find((item) => item.id === 'common')
  assert.equal(savedCommon.always, true, 'common 的 always 必须锁定为 true')
  assert.equal(savedCommon.name, '公共插件')
  assert.equal(savedCommon.note, '常开')
  assert.deepEqual(savedCommon.bundles, ['dsh-alpha'])

  for (const bad of [
    { name: '', bundles: [] },
    { name: 'x' },
    { name: 'x', bundles: ['ok', 2] },
    { name: 'x', bundles: [], always: 'yes' },
    { id: '', name: 'x', bundles: [] },
  ]) {
    const response = await call('/api/dsh-modpack/pack/save', bad)
    assert.equal(response.ok, false, JSON.stringify(bad))
    assert.equal(response.error.code, 'invalid-input', JSON.stringify(bad))
    assert.equal(typeof response.error.message, 'string')
  }
  assert.equal(readStateFile(home).packs.length, 2, '非法输入不得改动状态')

  const unknown = await call('/api/dsh-modpack/pack/save', { id: 'nope', name: 'x', bundles: [] })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'unknown-pack')
})

// ── 7. pack/delete ────────────────────────────────────────────────────────
test('pack/delete：拒删 common；删掉 active 后 activePackId=null 且不触发切换', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ activePackId: 'p1', packs: [commonPack(), pack('p1'), pack('p2')] }))
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: true })])
  const { call } = harness({ home, manager })

  const common = await call('/api/dsh-modpack/pack/delete', { id: 'common' })
  assert.equal(common.ok, false)
  assert.equal(common.error.code, 'protected-pack')
  assert.match(common.error.message, /common/)

  const missing = await call('/api/dsh-modpack/pack/delete', { id: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'unknown-pack')

  const deleted = await call('/api/dsh-modpack/pack/delete', { id: 'p1' })
  assert.equal(deleted.ok, true)
  assert.equal(deleted.value.state.activePackId, null)
  assert.deepEqual(deleted.value.state.packs.map((item) => item.id), ['common', 'p2'])
  assert.equal(manager.calls.length, 0, '删包不得调用 setBundleEnabled')
  assert.deepEqual(readStateFile(home).packs.map((item) => item.id), ['common', 'p2'])
  assert.equal(readStateFile(home).activePackId, null)
})

// ── 8. pack/adopt ────────────────────────────────────────────────────────
test('pack/adopt：写入当前实际启用的可切换插件集合', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ packs: [commonPack(), pack('p1')] }))
  const manager = makeManager([
    bundle({ name: 'dsh-base-core', official: true, optional: false, enabled: true }),
    bundle({ name: 'dsh-alpha', enabled: true }),
    bundle({ name: 'dsh-beta', enabled: false }),
    bundle({ name: 'dsh-gamma', installed: false, enabled: true }),
  ])
  const { call } = harness({ home, manager })

  const response = await call('/api/dsh-modpack/pack/adopt', { id: 'p1' })

  assert.equal(response.ok, true)
  const adopted = response.value.state.packs.find((item) => item.id === 'p1')
  assert.deepEqual(adopted.bundles, ['dsh-alpha'])
  assert.deepEqual(readStateFile(home).packs.find((item) => item.id === 'p1').bundles, ['dsh-alpha'])
  assert.equal(manager.calls.length, 0)

  const missing = await call('/api/dsh-modpack/pack/adopt', { id: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'unknown-pack')
})

// ── 9. common ────────────────────────────────────────────────────────────
test('common：只改 commonEnabled，不触发切换', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ packs: [commonPack(['dsh-alpha'])] }))
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: true })])
  const { call } = harness({ home, manager })

  const response = await call('/api/dsh-modpack/common', { enabled: false })
  assert.equal(response.ok, true)
  assert.equal(response.value.state.commonEnabled, false)
  assert.deepEqual(response.value.effective.desiredEnabled, [])
  assert.deepEqual(response.value.effective.currentlyEnabled, ['dsh-alpha'])
  assert.equal(response.value.effective.drift, true)
  assert.equal(manager.calls.length, 0, '关公共整合包不得触发切换')
  assert.equal(readStateFile(home).commonEnabled, false)

  const bad = await call('/api/dsh-modpack/common', { enabled: 'no' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'invalid-input')
  assert.equal(readStateFile(home).commonEnabled, false)
})

// ── 10. 并发串行 ─────────────────────────────────────────────────────────
test('并发两次 switch：mutex 串行执行，setBundleEnabled 不交错', async () => {
  const home = home0()
  writeStateFile(home, stateFixture({ packs: [commonPack(), pack('p1', ['dsh-alpha']), pack('p2', ['dsh-beta'])] }))
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: false }), bundle({ name: 'dsh-beta', enabled: false })])
  manager.delay = 20
  const { call } = harness({ home, manager })

  const [first, second] = await Promise.all([
    call('/api/dsh-modpack/switch', { id: 'p1' }),
    call('/api/dsh-modpack/switch', { id: 'p2' }),
  ])

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(manager.maxConcurrent, 1, '两次切换的 setBundleEnabled 不允许重叠')
  assert.deepEqual(manager.calls.map((item) => item.name + ':' + item.enabled), ['dsh-alpha:true', 'dsh-alpha:false', 'dsh-beta:true'])
})

// ── 11. 原子写 ───────────────────────────────────────────────────────────
test('状态写入是原子写：不留 *.tmp 残留，mode 为 0o600', async () => {
  const home = home0()
  const { call } = harness({ home, manager: makeManager([bundle({ name: 'dsh-alpha', enabled: true })]) })

  await call('/api/dsh-modpack/pack/save', { name: '整合包', bundles: ['dsh-alpha'] })
  await call('/api/dsh-modpack/common', { enabled: false })

  const entries = readdirSync(STATE_DIR(home))
  assert.deepEqual(entries.filter((name) => name.includes('.tmp')), [], '不得留下临时文件：' + JSON.stringify(entries))
  assert.ok(entries.includes('state.json'))
  if (process.platform !== 'win32') {
    assert.equal(statSync(STATE_PATH(home)).mode & 0o777, 0o600)
  }
})

// ── 12. readonly ────────────────────────────────────────────────────────
test('pluginManager 拿不到时 mode=readonly，写接口返回 no-plugin-manager 且不改状态', async () => {
  const home = home0()
  const { call } = harness({ home, manager: undefined })

  const payload = await call('/api/dsh-modpack/state')
  assert.equal(payload.ok, true)
  assert.equal(payload.value.mode, 'readonly')
  assert.deepEqual(payload.value.bundles, [])
  assert.deepEqual(payload.value.effective.desiredEnabled, [])
  assert.equal(payload.value.seeded, true)

  for (const [path, body] of [
    ['/api/dsh-modpack/switch', { id: null }],
    ['/api/dsh-modpack/pack/save', { name: 'x', bundles: [] }],
    ['/api/dsh-modpack/pack/delete', { id: 'common' }],
    ['/api/dsh-modpack/pack/adopt', { id: 'common' }],
    ['/api/dsh-modpack/common', { enabled: false }],
  ]) {
    const response = await call(path, body)
    assert.equal(response.ok, false, path)
    assert.equal(response.error.code, 'no-plugin-manager', path)
    assert.equal(typeof response.error.message, 'string')
  }
  assert.equal(existsSync(STATE_PATH(home)), false, '只读模式不得写盘')
})

// ── 13. 降级不抛 ─────────────────────────────────────────────────────────
test('connection.fetch.register 不可用时只 warn 不抛，也不注册路由', () => {
  const warned = []
  const ctx = {
    logger: { info() {}, warn(message) { warned.push(String(message)) } },
    get() { return undefined },
    effect() { throw new Error('不该注册任何东西') },
    inject(deps, callback) { callback({ get() { return undefined } }) },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(warned.length, 1)
  assert.match(warned[0], /register/)
})

test('请求体不是 JSON / handler 内部异常：都变成 {ok:false,error:{code}}', async () => {
  const home = home0()
  const manager = makeManager([bundle({ name: 'dsh-alpha', enabled: true })])
  const { routes, call } = harness({ home, manager })

  const route = routes.find((item) => item.path === '/api/dsh-modpack/switch')
  const broken = await route.fetch(new Request('http://test/api/dsh-modpack/switch', { method: 'POST', body: 'not json' }))
  const brokenPayload = await broken.json()
  assert.equal(brokenPayload.ok, false)
  assert.equal(brokenPayload.error.code, 'invalid-input')

  manager.listBundles = async () => { throw new Error('列表炸了') }
  const response = await call('/api/dsh-modpack/switch', { id: null })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'internal')
  assert.match(response.error.message, /列表炸了/)
  assert.equal(existsSync(STATE_PATH(home)), false)
})
