export const SELF_BUNDLE = 'dsh-modpack'

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const READ_ONLY_REASON = {
  'management-required': '由 DSH 管理层接管，无法用开关切换',
  unaddressable: 'DSH 找不到可定位的插件条目，无法切换',
}

/** DSH 的本地化文本要么是字符串，要么是 { en, <locale>: ... }；中文界面优先中文。 */
export function localizedText(value) {
  if (typeof value === 'string') return value
  if (!isObject(value)) return undefined
  const keys = Object.keys(value)
  for (const wanted of ['zh-cn', 'zh-hans', 'zh', 'en']) {
    const key = keys.find((candidate) => candidate.toLowerCase() === wanted)
    if (key && typeof value[key] === 'string' && value[key] !== '') return value[key]
  }
  return undefined
}

export function labelOf(bundle) {
  const title = localizedText(bundle?.meta?.title)
  if (title) return title
  return typeof bundle?.name === 'string' && bundle.name !== '' ? bundle.name : '（未命名插件）'
}

export function descriptionOf(bundle) {
  const own = typeof bundle?.description === 'string' && bundle.description !== '' ? bundle.description : undefined
  return own ?? localizedText(bundle?.meta?.description)
}

export function errorText(error) {
  if (error === undefined || error === null) return undefined
  if (typeof error === 'string') return error
  const code = typeof error.code === 'string' ? error.code : '未知错误'
  const diagnostic = typeof error.diagnostic === 'string' && error.diagnostic !== '' ? '：' + error.diagnostic : ''
  return code + diagnostic
}

/**
 * 受保护的插件永远开着，不进整合包勾选。三条规则互相独立：
 * DSH 声明只读、DSH 基座（官方且非可选）、本插件自己。
 */
export function isProtected(bundle) {
  if (!isObject(bundle)) return false
  if (bundle.readOnlyReason !== undefined && bundle.readOnlyReason !== null) return true
  if (bundle.name === SELF_BUNDLE) return true
  return bundle.official === true && bundle.optional !== true
}

export function protectedReason(bundle) {
  const readOnly = bundle?.readOnlyReason
  if (readOnly !== undefined && readOnly !== null) {
    return READ_ONLY_REASON[readOnly] ?? '只读插件（' + String(readOnly) + '），无法切换'
  }
  if (bundle?.name === SELF_BUNDLE) return '本整合包自身，始终开启'
  if (bundle?.official === true && bundle?.optional !== true) return 'DSH 基座，始终开启'
  return '受保护，始终开启'
}

export function isTogglable(bundle) {
  if (!isObject(bundle)) return false
  if (bundle.installed !== true) return false
  if (isProtected(bundle)) return false
  return bundle.error === undefined || bundle.error === null
}

function notTogglableReason(bundle) {
  if (bundle?.installed !== true) return '未安装到当前配置，无法切换'
  const error = errorText(bundle?.error)
  return error ? '插件加载出错（' + error + '），暂不参与切换' : '当前不可切换'
}

/**
 * 白名单 = 启用中的 always 包 ∪ 当前整合包。commonEnabled=false 时公共整合包整体不参与，
 * 这是用户「暂时全关掉」的唯一开关；非 always 的包只有被当前选中时才并进来。
 */
export function desiredNames(state) {
  const names = new Set()
  const commonOn = state?.commonEnabled !== false
  const activeId = typeof state?.activePackId === 'string' ? state.activePackId : null
  for (const pack of Array.isArray(state?.packs) ? state.packs : []) {
    const always = pack.always === true
    if (always && !commonOn) continue
    if (!always && pack.id !== activeId) continue
    for (const name of Array.isArray(pack.bundles) ? pack.bundles : []) {
      if (typeof name === 'string' && name !== '') names.add(name)
    }
  }
  return names
}

export function projectBundle(bundle, desired) {
  const protectedBundle = isProtected(bundle)
  const togglable = isTogglable(bundle)
  const projected = {
    name: typeof bundle?.name === 'string' ? bundle.name : '',
    label: labelOf(bundle),
    enabled: bundle?.enabled === true,
    installed: bundle?.installed === true,
    protected: protectedBundle,
    togglable,
  }
  const description = descriptionOf(bundle)
  if (description) projected.description = description
  if (typeof bundle?.version === 'string' && bundle.version !== '') projected.version = bundle.version
  let reason
  if (protectedBundle) reason = protectedReason(bundle)
  else if (!togglable) reason = notTogglableReason(bundle)
  else if (!desired.has(bundle.name)) reason = '不在整合包白名单内，切换时会被关闭'
  if (reason) projected.reason = reason
  const error = errorText(bundle?.error)
  if (error) projected.error = error
  return projected
}

export function sortProjected(list) {
  return [...list].sort((a, b) => {
    if (a.protected !== b.protected) return a.protected ? 1 : -1
    if (a.label !== b.label) return a.label < b.label ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index])

/**
 * 只有可切换插件参与漂移判断：受保护的插件永远开着，把它们算进来会让 drift 恒为 true。
 */
export function projectEffective(bundles, desired) {
  const protectedNames = []
  const currentlyEnabled = []
  const desiredEnabled = []
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (isProtected(bundle)) {
      if (typeof bundle?.name === 'string' && bundle.name !== '') protectedNames.push(bundle.name)
      continue
    }
    if (!isTogglable(bundle)) continue
    if (bundle.enabled === true) currentlyEnabled.push(bundle.name)
    if (desired.has(bundle.name)) desiredEnabled.push(bundle.name)
  }
  desiredEnabled.sort()
  currentlyEnabled.sort()
  protectedNames.sort()
  return {
    desiredEnabled,
    currentlyEnabled,
    drift: !sameList(desiredEnabled, currentlyEnabled),
    protected: protectedNames,
  }
}
