import { errorText, isTogglable } from './bundles.js'

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * 同一个进程里可能有多个写请求同时到达（面板 + 另一个标签页），
 * 交错执行 setBundleEnabled 会让「最终真正启用的是什么」取决于时序，所以排队执行。
 */
export function createMutex() {
  let tail = Promise.resolve()
  return function withLock(task) {
    const result = tail.then(() => task())
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

const failureMessage = (result) => errorText(result?.error) ?? '插件管理器没有接受这次变更'

/**
 * 契约的优先级：restart-required 先于 partial，只有完全没有变更时才是 noop。
 * 失败项仍然逐条写进 failed，界面据此不许自动刷新。
 */
function resolveApplied(report) {
  if (report.restartRequired.length > 0) return 'restart-required'
  if (report.failed.length > 0) return 'partial'
  if (report.enabled.length + report.disabled.length === 0) return 'noop'
  return 'applied'
}

/**
 * 只碰「状态与白名单不一致」的可切换插件：一致的进 skipped，受保护的完全不动。
 * 单个插件失败不中断整轮，否则一次切换会因为一个坏插件把剩下的都留下。
 */
export async function runSwitch({ bundles, desired, manager, logger }) {
  const report = { packId: null, enabled: [], disabled: [], skipped: [], failed: [], restartRequired: [], applied: 'noop' }
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (!isTogglable(bundle)) continue
    const want = desired.has(bundle.name)
    const have = bundle.enabled === true
    if (want === have) {
      report.skipped.push(bundle.name)
      continue
    }
    try {
      const result = await manager.setBundleEnabled(bundle.name, want)
      const application = result?.application
      if (application === 'failed' || application === 'cancelled') {
        report.failed.push({ name: bundle.name, message: failureMessage(result) })
        continue
      }
      if (want) report.enabled.push(bundle.name)
      else report.disabled.push(bundle.name)
      if (application === 'restart-required') report.restartRequired.push(bundle.name)
    } catch (error) {
      report.failed.push({ name: bundle.name, message: messageOf(error) })
      logger?.warn?.('modpack: 切换 ' + bundle.name + ' 失败：' + messageOf(error))
    }
  }
  report.applied = resolveApplied(report)
  return report
}
