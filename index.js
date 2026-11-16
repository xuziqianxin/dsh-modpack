import { randomUUID } from 'node:crypto'

import { COMMON_PACK_ID, createStore, resolveHome } from './lib/store.js'
import { desiredNames, isTogglable, projectBundle, projectEffective, sortProjected } from './lib/bundles.js'
import { createMutex, runSwitch } from './lib/switcher.js'

export const name = 'modpack'
export const inject = ['connection', 'pluginManager']

const PREFIX = '/api/dsh-modpack'
const NO_STORE = { 'cache-control': 'no-store' }
const NO_MANAGER = '插件管理服务未就绪：现在只能查看整合包，无法切换插件。'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const respond = (body) => Response.json(body, { headers: NO_STORE })
const okBody = (value) => respond({ ok: true, value })
const errorBody = (code, message) => respond({ ok: false, error: { code, message } })

const asList = (value) => (Array.isArray(value) ? value : [])

export function apply(ctx) {
  try {
    const logger = ctx?.logger
    const store = createStore({ home: resolveHome(ctx), logger })
    const withLock = createMutex()

    ctx.inject(['connection', 'pluginManager'], (scoped) => {
      let register
      try {
        const connection = scoped.get('connection')
        const candidate = connection?.fetch?.register
        if (typeof candidate === 'function') register = candidate.bind(connection.fetch)
      } catch (error) {
        logger?.warn?.('modpack: 读取 connection 服务失败：' + messageOf(error))
      }
      if (!register) {
        logger?.warn?.('modpack: connection.fetch.register 不可用，整合包面板降级为只读（不注册任何路由）')
        return
      }

      /** 服务可能在插件运行期间被卸载，所以每次请求都重新取，而不是在 apply 时抓一个快照。 */
      const getManager = () => {
        try {
          return scoped.get('pluginManager') ?? undefined
        } catch {
          return undefined
        }
      }

      const readBody = async (request) => {
        if (request === undefined || request === null) return null
        if (typeof request.json === 'function') {
          try {
            return await request.json()
          } catch {
            return null
          }
        }
        return request
      }

      const buildPayload = async (extra) => {
        const { state, seeded, warning } = store.load()
        const manager = getManager()
        const bundles = manager ? asList(await manager.listBundles()) : []
        const desired = desiredNames(state)
        const value = {
          seeded,
          mode: manager ? 'ready' : 'readonly',
          state,
          bundles: sortProjected(bundles.map((bundle) => projectBundle(bundle, desired))),
          effective: projectEffective(bundles, desired),
        }
        if (typeof warning === 'string' && warning !== '') value.warning = warning
        return { ...value, ...extra }
      }

      const guard = (path, handler) => async (request) => {
        try {
          return await handler(request)
        } catch (error) {
          logger?.warn?.('modpack: ' + path + ' 处理失败：' + messageOf(error))
          return errorBody('internal', '处理请求时出错：' + messageOf(error))
        }
      }

      const stateRoute = async () => okBody(await buildPayload())

      const switchRoute = async (request) => {
        const body = await readBody(request)
        if (!isObject(body)) return errorBody('invalid-input', '请求体必须是 JSON 对象，形如 {"id":"<整合包 id>|null"}')
        const targetId = body.id
        if (targetId !== null && typeof targetId !== 'string') {
          return errorBody('invalid-input', 'id 必须是整合包 id 字符串，或 null 表示只保留公共整合包')
        }
        const manager = getManager()
        if (!manager) return errorBody('no-plugin-manager', NO_MANAGER)
        return withLock(async () => {
          const { state } = store.load()
          if (targetId !== null && !state.packs.some((pack) => pack.id === targetId)) {
            return errorBody('unknown-pack', '整合包不存在：' + targetId)
          }
          const bundles = asList(await manager.listBundles())
          const desired = desiredNames({ ...state, activePackId: targetId })
          const report = await runSwitch({ bundles, desired, manager, logger })
          report.packId = targetId
          const next = {
            ...state,
            activePackId: targetId,
            lastApplied: {
              at: new Date().toISOString(),
              packId: targetId,
              enabled: report.enabled,
              disabled: report.disabled,
              failed: report.failed,
              restartRequired: report.restartRequired,
            },
          }
          store.write(next)
          return okBody(await buildPayload({ switch: report }))
        })
      }

      const packSaveRoute = async (request) => {
        const body = await readBody(request)
        const parsed = parsePackInput(body)
        if (parsed.error) return errorBody('invalid-input', parsed.error)
        const manager = getManager()
        if (!manager) return errorBody('no-plugin-manager', NO_MANAGER)
        return withLock(async () => {
          const { state } = store.load()
          const at = new Date().toISOString()
          const index = parsed.value.id === undefined
            ? -1
            : state.packs.findIndex((pack) => pack.id === parsed.value.id)
          if (parsed.value.id !== undefined && index === -1) {
            return errorBody('unknown-pack', '整合包不存在：' + parsed.value.id)
          }
          let packs
          if (index === -1) {
            packs = [...state.packs, {
              id: randomUUID(),
              name: parsed.value.name,
              always: parsed.value.always === true,
              bundles: parsed.value.bundles,
              note: parsed.value.note ?? '',
              createdAt: at,
              updatedAt: at,
            }]
          } else {
            packs = state.packs.map((pack, position) => (position === index
              ? {
                ...pack,
                name: parsed.value.name,
                bundles: parsed.value.bundles,
                // 公共整合包承载常开白名单，always 是它的身份而不是可编辑字段。
                always: pack.id === COMMON_PACK_ID
                  ? true
                  : (parsed.value.always === undefined ? pack.always === true : parsed.value.always),
                note: parsed.value.note === undefined ? pack.note : parsed.value.note,
                updatedAt: at,
              }
              : pack))
          }
          store.write({ ...state, packs })
          return okBody(await buildPayload())
        })
      }

      const packDeleteRoute = async (request) => {
        const body = await readBody(request)
        if (!isObject(body) || typeof body.id !== 'string' || body.id === '') {
          return errorBody('invalid-input', 'id 必须是整合包 id 字符串')
        }
        const manager = getManager()
        if (!manager) return errorBody('no-plugin-manager', NO_MANAGER)
        return withLock(async () => {
          const { state } = store.load()
          if (body.id === COMMON_PACK_ID) {
            return errorBody('protected-pack', '公共插件（common）承载常开白名单，不能删除')
          }
          if (!state.packs.some((pack) => pack.id === body.id)) {
            return errorBody('unknown-pack', '整合包不存在：' + body.id)
          }
          const packs = state.packs.filter((pack) => pack.id !== body.id)
          // 删掉当前整合包只解除选中，不动任何插件开关：用户没按「切换」，插件就该保持原样。
          const activePackId = state.activePackId === body.id ? null : state.activePackId
          store.write({ ...state, packs, activePackId })
          return okBody(await buildPayload())
        })
      }

      const packAdoptRoute = async (request) => {
        const body = await readBody(request)
        if (!isObject(body) || typeof body.id !== 'string' || body.id === '') {
          return errorBody('invalid-input', 'id 必须是整合包 id 字符串')
        }
        const manager = getManager()
        if (!manager) return errorBody('no-plugin-manager', NO_MANAGER)
        return withLock(async () => {
          const { state } = store.load()
          if (!state.packs.some((pack) => pack.id === body.id)) {
            return errorBody('unknown-pack', '整合包不存在：' + body.id)
          }
          const bundles = asList(await manager.listBundles())
          const desired = desiredNames(state)
          // 版面顺序与「可切换插件清单」一致，用户对着面板能一条条对上。
          const adopted = sortProjected(bundles.map((bundle) => projectBundle(bundle, desired)))
            .filter((bundle) => bundle.togglable && bundle.enabled)
            .map((bundle) => bundle.name)
          const at = new Date().toISOString()
          const packs = state.packs.map((pack) => (pack.id === body.id
            ? { ...pack, bundles: adopted, updatedAt: at }
            : pack))
          store.write({ ...state, packs })
          return okBody(await buildPayload())
        })
      }

      const commonRoute = async (request) => {
        const body = await readBody(request)
        if (!isObject(body) || typeof body.enabled !== 'boolean') {
          return errorBody('invalid-input', 'enabled 必须是布尔值')
        }
        const manager = getManager()
        if (!manager) return errorBody('no-plugin-manager', NO_MANAGER)
        return withLock(async () => {
          const { state } = store.load()
          store.write({ ...state, commonEnabled: body.enabled })
          return okBody(await buildPayload())
        })
      }

      const routes = [
        { path: PREFIX + '/state', methods: ['GET'], handler: stateRoute },
        { path: PREFIX + '/switch', methods: ['POST'], handler: switchRoute },
        { path: PREFIX + '/pack/save', methods: ['POST'], handler: packSaveRoute },
        { path: PREFIX + '/pack/delete', methods: ['POST'], handler: packDeleteRoute },
        { path: PREFIX + '/pack/adopt', methods: ['POST'], handler: packAdoptRoute },
        { path: PREFIX + '/common', methods: ['POST'], handler: commonRoute },
      ]

      for (const route of routes) {
        route.fetch = guard(route.path, route.handler)
      }

      for (const { path, methods, fetch } of routes) {
        ctx.effect(() => register({ path, methods, requestBody: 'buffered', fetch }), 'modpack: ' + path)
      }
    })
  } catch (error) {
    try {
      ctx?.logger?.warn?.('modpack: 插件启动失败，整合包面板不可用：' + messageOf(error))
    } catch { /* logger 也坏了就只能静默，apply 绝不能抛 */ }
  }
}

function parsePackInput(body) {
  if (!isObject(body)) return { error: '请求体必须是 JSON 对象' }
  const { id, name, bundles, note } = body
  if (id !== undefined && (typeof id !== 'string' || id.trim() === '')) {
    return { error: 'id 必须是非空字符串（新建整合包请不要传 id）' }
  }
  if (typeof name !== 'string' || name.trim() === '') return { error: '整合包名字不能为空' }
  if (!Array.isArray(bundles)) return { error: 'bundles 必须是插件名数组' }
  const names = []
  for (const item of bundles) {
    if (typeof item !== 'string' || item.trim() === '') {
      return { error: 'bundles 里只能是非空的插件名字符串' }
    }
    if (!names.includes(item)) names.push(item)
  }
  if (body.always !== undefined && typeof body.always !== 'boolean') {
    return { error: 'always 必须是布尔值' }
  }
  if (note !== undefined && typeof note !== 'string') return { error: 'note 必须是字符串' }
  return { value: { id: id === undefined ? undefined : id.trim(), name: name.trim(), bundles: names, note, always: body.always } }
}
