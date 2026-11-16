# DSH 事实（Lead 已核实，带 file:line）

DSH 版本 0.2.2-rc.3。应用源码已解包到
`D:\enderman\deepseek_plugin\.probe\asar\dsh\node_modules\@deepseek-ai\`（可直接 read/grep）。

## 服务端

- 服务名与声明：`dsh-plugin-manager/src/index.ts:315-324`
  （`Context { pluginManager: PluginManager }`，`static inject = ['loader','profileContext']`）。
- 可调用的远程方法（都是公开方法）：
  - `listBundles(): Promise<BundleInfo[]>` — index.ts:499-500
  - `setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>` — index.ts:946-952
  - `setPluginEnabled(id, enabled)` — index.ts:928-939（按 entry 粒度，本插件不用）
  - `listPlugins()` — index.ts:475-476
- `BundleInfo` / `ChangeResult` 字段定义：`dsh-plugin-manager/src/types.ts:73-119`（BundleInfo）、
  `171-199`（ChangeResult，含 `application: 'applied'|'restart-required'|'overridden'|'failed'|'cancelled'`）。
- hmr 在桌面 profile 里是**挂载的**：`dsh-base/cordis.patch.yml:28-29`（id `hmr`）。
  因此 `setBundleEnabled` 在桌面端通常直接 `applied`（热生效）。
- hmr 监视 profile 的 `cordis.patch.yml` 与 `package.json`：`dsh-hmr/src/index.ts:406-407`。
- HTTP 路由注册方式（第三方插件实证样例）：
  `C:\Users\enderman\.dsh\profiles\desktop\node_modules\dsh-token-effi\index.js:191-199` 与 `:336-355`
  ```js
  ctx.inject(['connection'], (scoped) => {
    const register = scoped.get('connection')?.fetch?.register?.bind(scoped.get('connection').fetch)
    if (!register) return                     // 拿不到就降级，不要抛
    ctx.effect(() => register({ path: '/api/dsh-modpack/state', methods: ['GET'], fetch: handler }), 'label')
  })
  ```
  路由 handler 返回 `Response.json(...)`（token-effi index.js:20-22 的 `ok`/`bad` 写法可直接借鉴）。
- DSH_HOME 解析样例：`dsh-token-effi/index.js:76`（`ctx.get('dshHomePath')`）。
- 插件入口样例：`dsh-token-effi/index.js:1-8`（ESM，`export const name` / `export const inject` / `export function apply(ctx)`）。

## 客户端

- 客户端 bundle 形态：`dsh-token-effi/client.js:1-6` 与 `:654-679`
  ```js
  window.__ModuleLoader__.load({ id: 'dsh-modpack', factory(require) {
    const React = require('react')
    return { inject: ['slots'], apply(ctx) { ctx.slots.inject('settings.plugins.tab', () =>
      ctx.slots.register({ name: 'settings.plugins.tab', id: 'modpack', order: 20, label: '整合包' }, Component)) } }
  } })
  ```
- `settings.plugins.tab` 的官方注册样例：`dsh-client-ui-settings-plugin-inventory/src/client/index.ts:33-64`。
- 槽位契约：`dsh-client-ui-settings/src/client/contract/slots.ts:74`。
- 组件拿到的 props（可选用）：`t`、`renderSlot`、`hooks` 等，见
  `dsh-client-ui-slots` 的 `PropsRuntime/PropsLocale/InjectFace`；也可以完全不用 props。
- `dsh.client` 清单契约：`dsh-client-modules/src/index.ts:2-3, 908-915`（必须 `exports './client'`）。

## 本机 profile（只读参考，**子代理不得修改**）

- `C:\Users\enderman\.dsh\profiles\desktop\package.json` → `dsh.profile.bundles`（bundle 层顺序）
- `C:\Users\enderman\.dsh\profiles\desktop\cordis.patch.yml`（用户 patch 层）

## 纪律

- 不要调用真实的 `setBundleEnabled`，不要写 profile 下任何文件：测试全部用 mock。
- 不要在插件代码里 `process.exit` / 重启 DSH：桌面 Host 没有向主进程请求重启的通道，
  杀 Host 会掉进崩溃恢复对话框（`lib/main.js:11842-11848` 的 close 处理）。
