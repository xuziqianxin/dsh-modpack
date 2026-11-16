import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const COMMON_PACK_ID = 'common'
export const STATE_VERSION = 1

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * DSH home 由运行时注册的服务给出（它返回一个取值函数，$DSH_HOME 变化时跟着变）；
 * 服务未就绪时才退回环境变量 / 默认目录，否则会写到一个和 Host 看法不同的地方。
 */
export function resolveHome(ctx) {
  try {
    const service = ctx?.get?.('dshHomePath')
    const resolved = typeof service === 'function' ? service() : service
    if (typeof resolved === 'string' && resolved !== '') return resolved
  } catch { /* 服务未就绪，走下面的兜底 */ }
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function seedState(now = new Date().toISOString()) {
  return {
    version: STATE_VERSION,
    commonEnabled: true,
    activePackId: null,
    packs: [{ id: COMMON_PACK_ID, name: '公共插件', always: true, bundles: [], note: '', createdAt: now, updatedAt: now }],
    lastApplied: null,
  }
}

const stringList = (value) => (Array.isArray(value)
  ? value.filter((item) => typeof item === 'string' && item !== '')
  : [])

const unique = (list) => {
  const out = []
  for (const item of list) if (!out.includes(item)) out.push(item)
  return out
}

function normalizePack(raw, now) {
  if (!isObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id === '') return null
  // 未认得的字段原样留着，后面版本加的字段不会因为本插件读写一次就丢掉。
  const pack = { ...raw }
  pack.name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : raw.id
  pack.always = raw.id === COMMON_PACK_ID ? true : raw.always === true
  pack.bundles = unique(stringList(raw.bundles))
  pack.note = typeof raw.note === 'string' ? raw.note : ''
  pack.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : now
  pack.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : pack.createdAt
  return pack
}

function normalizeLastApplied(raw) {
  if (!isObject(raw)) return null
  const failed = []
  for (const item of Array.isArray(raw.failed) ? raw.failed : []) {
    if (!isObject(item)) continue
    failed.push({ name: String(item.name ?? ''), message: String(item.message ?? '') })
  }
  return {
    at: typeof raw.at === 'string' ? raw.at : '',
    packId: typeof raw.packId === 'string' ? raw.packId : null,
    enabled: stringList(raw.enabled),
    disabled: stringList(raw.disabled),
    failed,
    restartRequired: stringList(raw.restartRequired),
  }
}

export function normalizeState(raw, now = new Date().toISOString()) {
  if (!isObject(raw)) return seedState(now)
  const state = { ...raw }
  state.version = Number.isInteger(raw.version) ? raw.version : STATE_VERSION
  state.commonEnabled = raw.commonEnabled !== false
  state.activePackId = typeof raw.activePackId === 'string' && raw.activePackId !== '' ? raw.activePackId : null
  const packs = (Array.isArray(raw.packs) ? raw.packs : [])
    .map((pack) => normalizePack(pack, now))
    .filter((pack) => pack !== null)
  const common = packs.find((pack) => pack.id === COMMON_PACK_ID)
  if (common) common.always = true
  else packs.unshift(seedState(now).packs[0])
  // activePackId 指向一个已经不存在的整合包时，留着它会让白名单永远算成空，界面上又没有可点的入口。
  if (state.activePackId !== null && !packs.some((pack) => pack.id === state.activePackId)) state.activePackId = null
  state.packs = packs
  state.lastApplied = normalizeLastApplied(raw.lastApplied)
  return state
}

export function createStore({ home, logger } = {}) {
  const root = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  const dir = join(root, 'dsh-modpack')
  const file = join(dir, 'state.json')
  let cached = null
  let seeded = true
  let warning = null

  const backupCorrupt = (reason) => {
    const target = file + '.bak-' + Date.now()
    try {
      copyFileSync(file, target)
      logger?.warn?.('modpack: 状态文件读不出来，已备份到 ' + target + '（' + reason + '）')
      return target
    } catch (error) {
      logger?.warn?.('modpack: 状态文件读不出来，备份也失败（' + reason + '）：' + String(error))
      return null
    }
  }

  /** 只读磁盘一次；首次运行与文件损坏都返回 seed，且都不落盘（写盘是用户决策之后的事）。 */
  const load = () => {
    if (cached) return { state: cached, seeded, warning }
    if (existsSync(file)) {
      let parsed = null
      let failure = null
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (!isObject(parsed)) failure = '顶层不是 JSON 对象'
      } catch (error) {
        failure = error && error.message ? error.message : String(error)
      }
      if (failure) {
        const backup = backupCorrupt(failure)
        cached = seedState()
        seeded = true
        warning = '状态文件已损坏（' + failure + '），已备份为 ' + (backup ? backup.split(/[\\/]/).pop() : '（备份失败）')
          + '，本次按首次运行处理，请重新创建整合包。'
      } else {
        cached = normalizeState(parsed)
        seeded = false
        warning = null
      }
    } else {
      cached = seedState()
      seeded = true
      warning = null
    }
    return { state: cached, seeded, warning }
  }

  /** 原子写：临时文件 + rename，中途崩掉不会把 state.json 留成半截 JSON。 */
  const write = (state) => {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, 'state.json.tmp-' + process.pid + '-' + Date.now().toString(36))
    try {
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
    } catch (error) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清理失败不影响抛出真正的原因 */ }
      throw error
    }
    cached = state
    seeded = false
    warning = null
    return state
  }

  return { dir, file, load, write }
}
