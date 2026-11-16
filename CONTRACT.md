# dsh-modpack · 冻结接口 v1（Lead 所有，子代理只读）

DSH 0.2.2-rc.3。DSH 自己已有插件开关（`ctx.pluginManager.setBundleEnabled`），本插件是它的
**编排层**：把「一键开关」升级为「公共白名单 + 整合包」。不重写 DSH 的配置格式，不改 profile 文件。

## 概念

- **插件（plugin）** = 一个 DSH bundle（`BundleInfo.name`）。整合包只能编排**已安装**的 bundle。
- **受保护插件（protected）** = 永远开启，不进整合包勾选，任何切换都不会关闭它。
  `protected(bundle) = bundle.readOnlyReason !== undefined || (bundle.official && !bundle.optional) || bundle.name === 'dsh-modpack'`
- **公共整合包（always pack）** = `always: true` 的整合包；任何一次切换都会自动并入它。
  用户可用 `commonEnabled=false` 整体停用，此时 always 包不参与。
- **白名单语义**：切换后「应当启用的可切换插件」= 所有启用中的 always 包 ∪ 当前整合包；
  其余可切换插件一律关闭。当前整合包为 null 时只剩 always 包。

## 状态文件

路径：`$DSH_HOME/dsh-modpack/state.json`（`ctx.get('dshHomePath')` 拿不到时退 `~/.dsh`）。
写入用原子写（tmp 文件 + rename），`mode 0o600`。

```json
{ "version": 1,
  "commonEnabled": true,
  "activePackId": null,
  "packs": [ { "id": "common", "name": "公共插件", "always": true, "bundles": [],
               "note": "", "createdAt": "ISO", "updatedAt": "ISO" } ],
  "lastApplied": null }
```

- `Pack = { id: string, name: string, always: boolean, bundles: string[], note?: string, createdAt: ISO, updatedAt: ISO }`
- `lastApplied = { at: ISO, packId: string|null, enabled: string[], disabled: string[],
                  failed: {name,message}[], restartRequired: string[] }`
- **首次运行（文件不存在）**：不写盘、不动任何插件。返回 seed 状态（只有一个 `common` 包、
  `activePackId=null`）并置 `seeded: true`，由界面引导用户「从当前配置另存为整合包」。
- 未知字段保留（向前兼容）；缺字段按上面默认值补齐。
- 文件损坏：备份成 `state.json.bak-<ts>`，按首次运行处理，并在响应里带 `warning`。

## 受保护 / 可切换判据（服务端唯一实现）

```
togglable(bundle) = bundle.installed === true && !protected(bundle) && bundle.error === undefined
```

## HTTP API

前缀 `/api/dsh-modpack`，全部 JSON，`cache-control: no-store`。
成功 `{ ok: true, value: T }`，失败 `{ ok: false, error: { code, message } }`（code 为
`'no-plugin-manager'` / `'unknown-pack'` / `'invalid-input'` / `'protected-pack'` / `'internal'`）。

**GET `/api/dsh-modpack/state`** → `StatePayload`

**POST `/api/dsh-modpack/switch`** `{ id: string|null }` → `StatePayload`（附 `switch: SwitchReport`）

**POST `/api/dsh-modpack/pack/save`** `{ id?, name, always?, bundles, note? }` → `StatePayload`
（无 `id` = 新建并用 `randomUUID` 派 id；`id='common'` 允许改名/改集合但 `always` 锁定为 true）

**POST `/api/dsh-modpack/pack/delete`** `{ id }` → `StatePayload`（拒删 `common`；删掉当前
active 后 `activePackId=null`，不自动重算、不自动关闭插件）

**POST `/api/dsh-modpack/pack/adopt`** `{ id }` → `StatePayload`（把**当前实际启用**的
可切换插件名单写进该包）

**POST `/api/dsh-modpack/common`** `{ enabled: boolean }` → `StatePayload`（只改
`commonEnabled`，不触发切换）

```ts
StatePayload = {
  seeded: boolean
  warning?: string
  mode: 'ready' | 'readonly'            // pluginManager 服务拿不到 = readonly
  state: { version, commonEnabled, activePackId, packs, lastApplied }
  bundles: Bundle[]
  effective: { desiredEnabled: string[], currentlyEnabled: string[],
               drift: boolean, protected: string[] }
}
Bundle = { name: string, label: string, description?: string, version?: string,
           enabled: boolean, installed: boolean, protected: boolean,
           togglable: boolean, reason?: string, error?: string }
SwitchReport = { packId: string|null, enabled: string[], disabled: string[],
                 skipped: string[], failed: {name,message}[],
                 restartRequired: string[],
                 applied: 'applied' | 'restart-required' | 'partial' | 'noop' }
```

- `label`：`bundle.meta` 的本地化标题，退化到 `bundle.name`。`reason`：中文人类可读原因
  （例如「DSH 基座，始终开启」）。`bundles` 按 `label` 排序，受保护的排在最后。
- 写接口在进程内串行（mutex）；单个 bundle 的 `setBundleEnabled` 失败不中断，记入 `failed`。
- 切换只对「状态不一致」的 bundle 调 `setBundleEnabled`，一致的不动（`skipped`）。
- `drift = desiredEnabled 与 currentlyEnabled 不一致`。
- `applied`：全成功且都 applied → `applied`；有 restartRequired → `restart-required`；
  有 failed → `partial`；没有任何变更 → `noop`。

## 客户端

- 只贡献一个 `plugins.tab`（就是「插件」页里 已安装 / 更新 / 发现 那一排 tab）：
  `{ id: 'modpack', order: 20, label: () => '整合包' }`（label 传函数，页面用 `resolveSlotLabel` 解析）。
- 版面三块：
  1. 顶部：公共整合包开关（常开白名单）+ 当前整合包名 + 「切换」按钮 + 最近一次切换结果条。
  2. 左列：整合包列表，选中即预览；新建 / 改名 / 删除 / 从当前配置另存。
  3. 右列：可切换插件清单（已启用 / 未启用两组），受保护插件灰显并给出原因。
- 切换成功后：显示报告（启用 n / 关闭 m / 需重启 k），**800ms 后 `location.reload()` 一次**；
  有失败项时不自动刷新，改为显示错误与「重试」。
- `mode === 'readonly'` 时整页只读并说明原因。
- 手写客户端 bundle（无构建步骤）：`window.__ModuleLoader__.load({ id: 'dsh-modpack', factory(require) { ... return { inject: ['slots'], apply(ctx) {...} } } })`，
  React 走 `require('react')`，样式用 inline style（与 `dsh-token-effi` 同风格）。
- 文案中文。

## 文件边界

| 文件 | 所有者 |
|---|---|
| `package.json` `cordis.patch.yml` `CONTRACT.md` `NOTES-dsh-facts.md` `README.md` | Lead |
| `index.js` `lib/**` `test/server.test.mjs` | 服务端子代理 |
| `client.js` `test/client.test.mjs` | 客户端子代理 |
