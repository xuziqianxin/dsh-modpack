window.__ModuleLoader__.load({
  id: 'dsh-modpack',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = '/api/dsh-modpack';
    const RELOAD_DELAY = 800;

    const C = { acc: '#2ec4b6', bad: '#ff5c7a', warn: '#ff9f45', blue: '#4c8dff', unk: '#6b7280' };

    // 只用中性灰做底色，颜色跟着 color: inherit 走，深色/浅色主题都不用另配一套。
    const S = {
      wrap: {
        height: '100%', minHeight: 0, boxSizing: 'border-box',
        overflowY: 'auto', overflowX: 'hidden',
        padding: '14px 16px 60px', maxWidth: 1120, margin: '0 auto',
        fontSize: 13, lineHeight: 1.5, color: 'inherit',
      },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, margin: '0 2px 10px' },
      title: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 14, fontWeight: 600 },
      sub: { fontSize: 11.5, opacity: 0.48 },
      bar: {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        padding: '9px 12px', borderRadius: 10, marginBottom: 10,
        border: '1px solid rgba(127,127,127,0.22)', background: 'rgba(127,127,127,0.05)',
      },
      toggle: { display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, cursor: 'pointer', margin: 0 },
      btn: {
        fontSize: 11.5, padding: '3px 11px', borderRadius: 7, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.28)', background: 'rgba(127,127,127,0.08)', color: 'inherit',
      },
      btnPrimary: {
        fontSize: 11.5, padding: '3px 11px', borderRadius: 7, cursor: 'pointer', color: 'inherit',
        border: '1px solid rgba(46,196,182,0.45)', background: 'rgba(46,196,182,0.14)',
      },
      btnDanger: {
        fontSize: 11.5, padding: '3px 11px', borderRadius: 7, cursor: 'pointer', color: 'inherit',
        border: '1px solid rgba(255,92,122,0.42)', background: 'rgba(255,92,122,0.10)',
      },
      input: {
        fontSize: 12, padding: '3px 8px', borderRadius: 7, minWidth: 140,
        border: '1px solid rgba(127,127,127,0.28)', background: 'transparent', color: 'inherit',
      },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(230px, 310px) minmax(340px, 1fr)', gap: 12, alignItems: 'start' },
      card: { border: '1px solid rgba(127,127,127,0.20)', borderRadius: 11, padding: '12px 14px', background: 'rgba(127,127,127,0.04)' },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
      cardTitle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, opacity: 0.92 },
      cardMeta: { fontSize: 11, opacity: 0.45, fontVariantNumeric: 'tabular-nums' },
      prow: {
        display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '6px 8px',
        borderRadius: 8, marginBottom: 3, cursor: 'pointer', textAlign: 'left', fontSize: 12,
        color: 'inherit', border: '1px solid transparent', background: 'transparent',
      },
      prowActive: { background: 'rgba(76,141,255,0.10)', border: '1px solid rgba(76,141,255,0.42)' },
      prowName: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      prowMeta: { fontSize: 10.5, opacity: 0.45, fontVariantNumeric: 'tabular-nums' },
      rowActions: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
      brow: { display: 'flex', alignItems: 'center', gap: 8, padding: '3.5px 0', fontSize: 12, margin: 0 },
      browName: { flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      browOff: { opacity: 0.6 },
      reason: { fontSize: 11, opacity: 0.6, marginLeft: 'auto', textAlign: 'right' },
      groupTitle: { fontSize: 11, fontWeight: 600, opacity: 0.5, margin: '10px 0 4px' },
      hint: { fontSize: 11.5, opacity: 0.5, marginBottom: 2 },
      muted: { opacity: 0.5, fontSize: 11.5, fontStyle: 'normal' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5, opacity: 0.55 },
      pill: (color) => ({
        display: 'inline-block', padding: '0 7px', borderRadius: 9, fontSize: 10.5,
        border: '1px solid ' + color + '55', background: color + '22', color: color, whiteSpace: 'nowrap',
      }),
      note: (color) => ({
        marginBottom: 10, padding: '8px 12px', borderRadius: 9, fontSize: 12, color: 'inherit',
        border: '1px solid ' + color + '55', background: color + '12',
      }),
    };

    // ---------- 纯函数 ----------

    function groupBundles(bundles) {
      const list = Array.isArray(bundles) ? bundles : [];
      const enabled = [];
      const disabled = [];
      const locked = [];
      for (const b of list) {
        if (!b || typeof b !== 'object') continue;
        if (b.togglable) {
          if (b.enabled) enabled.push(b); else disabled.push(b);
        } else {
          locked.push(b);
        }
      }
      return { enabled: enabled, disabled: disabled, locked: locked };
    }

    function diffText(effective) {
      if (!effective) return '启用状态未知';
      const desired = Array.isArray(effective.desiredEnabled) ? effective.desiredEnabled : [];
      const current = Array.isArray(effective.currentlyEnabled) ? effective.currentlyEnabled : [];
      const missing = desired.filter((n) => current.indexOf(n) < 0);
      const extra = current.filter((n) => desired.indexOf(n) < 0);
      if (!missing.length && !extra.length) return '当前启用状态与整合包预期一致';
      const parts = [];
      if (missing.length) parts.push('待启用 ' + missing.length + ' 个');
      if (extra.length) parts.push('待关闭 ' + extra.length + ' 个');
      return '与预期不一致：' + parts.join('、');
    }

    function reportText(report) {
      if (!report) return '';
      const enabled = Array.isArray(report.enabled) ? report.enabled.length : 0;
      const disabled = Array.isArray(report.disabled) ? report.disabled.length : 0;
      const restart = Array.isArray(report.restartRequired) ? report.restartRequired.length : 0;
      return '启用 ' + enabled + ' / 关闭 ' + disabled + ' / 需重启 ' + restart;
    }

    const APPLIED_TEXT = { applied: '已生效', 'restart-required': '重启后生效', partial: '部分失败', noop: '无需变更' };

    function appliedText(applied) {
      return APPLIED_TEXT[applied] || '已提交';
    }

    const ERROR_TEXT = {
      'no-plugin-manager': '插件管理服务不可用',
      'unknown-pack': '找不到这个整合包',
      'invalid-input': '参数不合法',
      'protected-pack': '受保护的整合包不能这样操作',
      internal: '服务端内部错误',
    };

    function errorText(error) {
      if (!error) return '未知错误';
      const base = ERROR_TEXT[error.code] || '操作失败';
      return error.message ? base + '：' + error.message : base;
    }

    function readEnvelope(json) {
      if (json && json.ok === true) return { ok: true, value: json.value };
      const error = (json && json.error) || {};
      return { ok: false, error: { code: error.code || 'internal', message: error.message || '' } };
    }

    // noop 表示一个插件状态都没变：刷新只会让页面白闪一次，不带来任何新状态。
    function shouldAutoReload(report) {
      if (!report) return false;
      if (Array.isArray(report.failed) && report.failed.length) return false;
      return report.applied !== 'noop';
    }

    function toggleMember(list, name) {
      const base = Array.isArray(list) ? list.slice() : [];
      const i = base.indexOf(name);
      if (i >= 0) base.splice(i, 1); else base.push(name);
      return base;
    }

    function sameMembers(a, b) {
      const x = Array.isArray(a) ? a : [];
      const y = Array.isArray(b) ? b : [];
      if (x.length !== y.length) return false;
      const set = {};
      for (const n of y) set[n] = true;
      for (const n of x) if (!set[n]) return false;
      return true;
    }

    function newestPack(packs) {
      const list = Array.isArray(packs) ? packs.slice() : [];
      if (!list.length) return null;
      list.sort((a, b) => String((a && (a.updatedAt || a.createdAt)) || '').localeCompare(String((b && (b.updatedAt || b.createdAt)) || '')));
      return list[list.length - 1] || null;
    }

    function currentlyEnabledTogglable(data) {
      const list = data && Array.isArray(data.bundles) ? data.bundles : [];
      return list.filter((b) => b && b.togglable && b.enabled).map((b) => b.name);
    }

    function membersOf(pack) {
      return pack && Array.isArray(pack.bundles) ? pack.bundles : [];
    }

    function shortTime(iso) {
      const s = String(iso || '');
      return s.length >= 19 ? s.slice(0, 10) + ' ' + s.slice(11, 19) : s;
    }

    function messageOf(e) {
      return (e && e.message) || String(e || '') || '未知错误';
    }

    function reloadPage() {
      if (typeof location !== 'undefined' && location && typeof location.reload === 'function') location.reload();
    }

    // ---------- 传输层 ----------

    async function request(path, init) {
      let res;
      try {
        res = await fetch(path, init);
      } catch (e) {
        throw new Error('连不上 DSH 服务：' + messageOf(e));
      }
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        throw new Error('服务返回了无法解析的响应');
      }
      const shell = readEnvelope(json);
      if (!shell.ok) throw new Error(errorText(shell.error));
      return shell.value;
    }

    const getState = () => request(API + '/state', { method: 'GET' });

    const postJson = (path, body) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body),
    });

    // ---------- 展示层（无 hooks，SSR 可渲染） ----------

    function ModpackView(props) {
      const p = props || {};
      const act = p.act || {};
      const data = p.data || null;
      const busy = Boolean(p.pending);

      if (!data) {
        return h('div', { style: S.wrap },
          h('div', { style: S.muted }, p.error ? '读取整合包状态失败：' + p.error : '正在读取整合包状态…'),
          p.error
            ? h('div', { style: S.rowActions },
              h('button', { type: 'button', style: S.btn, onClick: () => act.load && act.load() }, '重试'))
            : null);
      }

      const state = data.state || {};
      const packs = Array.isArray(state.packs) ? state.packs : [];
      const activeId = state.activePackId === undefined || state.activePackId === null ? null : state.activePackId;
      const selId = p.selectedId === undefined ? activeId : p.selectedId;
      const preview = packs.filter((x) => x && x.id === selId)[0] || null;
      const active = packs.filter((x) => x && x.id === activeId)[0] || null;
      const readonly = data.mode === 'readonly';
      const commonEnabled = state.commonEnabled !== false;
      const groups = groupBundles(data.bundles);
      const members = Array.isArray(p.draft) ? p.draft : membersOf(preview);
      const dirty = preview ? !sameMembers(members, membersOf(preview)) : members.length > 0;
      const report = p.report || null;
      const last = state.lastApplied || null;
      const shown = report || last;
      const failed = report && Array.isArray(report.failed) ? report.failed.filter(Boolean) : [];
      const protectedCount = data.effective && Array.isArray(data.effective.protected) ? data.effective.protected.length : 0;

      const banners = [];
      if (readonly) {
        banners.push(h('div', { key: 'ro', style: S.note(C.warn) },
          '只读模式：当前 DSH 进程没有提供插件管理服务（pluginManager 未挂载），这页只能查看，所有按钮已禁用。'));
      }
      if (data.warning) {
        banners.push(h('div', { key: 'warn', style: S.note(C.warn) }, '状态文件有问题，已按首次使用处理：' + data.warning));
      }
      if (data.seeded) {
        banners.push(h('div', { key: 'seed', style: S.note(C.blue) },
          h('div', null, '首次使用：还没有任何整合包，现在只有公共白名单里的插件。'),
          h('div', { style: { marginTop: 6 } },
            h('button', {
              type: 'button', style: S.btnPrimary, disabled: readonly || busy,
              onClick: () => act.saveCurrent && act.saveCurrent(),
            }, '从当前配置另存为整合包'))));
      }

      const errorBar = p.error
        ? h('div', { style: S.note(C.bad) }, '操作失败：' + p.error)
        : null;

      const topBar = h('div', { style: S.bar },
        h('label', { style: S.toggle },
          h('input', {
            type: 'checkbox', checked: commonEnabled, disabled: readonly || busy,
            onChange: (e) => act.setCommon && act.setCommon(Boolean(e && e.target && e.target.checked)),
          }),
          '公共整合包（常开白名单）'),
        h('span', { style: S.muted }, '当前整合包：' + (active ? (active.name || active.id) : '未选择（只保留公共白名单）')),
        h('button', {
          type: 'button', style: S.btnPrimary, disabled: readonly || busy,
          title: preview ? '把「' + (preview.name || preview.id) + '」设为当前整合包' : '只保留公共白名单',
          onClick: () => act.switchTo && act.switchTo(selId),
        }, p.pending === 'switch' ? '切换中…' : '切换'));

      const reportBar = h('div', { style: S.bar },
        h('span', { style: { fontSize: 12 } }, '最近一次切换：'),
        shown
          ? h('span', { style: S.mono }, reportText(shown) + (report ? ' · ' + appliedText(report.applied) : (shown.at ? ' · ' + shortTime(shown.at) : '')))
          : h('span', { style: S.muted }, '还没有切换记录'),
        failed.length
          ? h('span', { style: { color: C.bad, fontSize: 11.5 } },
            '失败 ' + failed.length + ' 项：' + failed.map((f) => (f.name || '未知插件') + '（' + (f.message || '未知原因') + '）').join('、'))
          : null,
        failed.length && !readonly
          ? h('button', { type: 'button', style: S.btnDanger, disabled: busy, onClick: () => act.retry && act.retry() }, '重试')
          : null,
        report && shouldAutoReload(report)
          ? h('span', { style: S.muted }, '800 毫秒后自动刷新页面')
          : null);

      const packRow = (pack) => h('button', {
        key: pack.id, type: 'button', 'aria-pressed': pack.id === selId,
        style: Object.assign({}, S.prow, pack.id === selId ? S.prowActive : {}),
        onClick: () => act.select && act.select(pack.id),
      },
        h('span', { style: S.prowName }, pack.name || pack.id),
        pack.always ? h('span', { style: S.pill(C.acc) }, '常开') : null,
        pack.id === activeId ? h('span', { style: S.pill(C.blue) }, '当前') : null,
        h('span', { style: S.prowMeta }, membersOf(pack).length + ' 个'));

      const leftCard = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, h('span', { style: { opacity: 0.7 } }, '☰'), '整合包'),
          h('div', { style: S.cardMeta }, packs.length + ' 个')),
        packs.length ? packs.map(packRow) : h('div', { style: S.muted }, '还没有整合包。'),
        h('div', { style: S.rowActions },
          h('input', {
            type: 'text', value: p.nameDraft || '', placeholder: '整合包名', 'aria-label': '整合包名',
            style: S.input, disabled: readonly || busy,
            onChange: (e) => act.setNameDraft && act.setNameDraft(e && e.target ? e.target.value : ''),
          })),
        h('div', { style: S.rowActions },
          h('button', { type: 'button', style: S.btn, disabled: readonly || busy, onClick: () => act.createPack && act.createPack() }, '新建'),
          h('button', { type: 'button', style: S.btn, disabled: readonly || busy || !preview, onClick: () => act.renamePack && act.renamePack() }, '改名'),
          h('button', {
            type: 'button', style: S.btnDanger,
            disabled: readonly || busy || !preview || preview.id === 'common',
            onClick: () => act.deletePack && act.deletePack(),
          }, '删除'),
          h('button', { type: 'button', style: S.btn, disabled: readonly || busy || !preview, onClick: () => act.adoptPack && act.adoptPack() }, '从当前配置另存')));

      const bundleRow = (bundle) => h('label', {
        key: bundle.name,
        style: Object.assign({}, S.brow, bundle.enabled ? {} : S.browOff),
      },
        h('input', {
          type: 'checkbox', checked: members.indexOf(bundle.name) >= 0, disabled: readonly || busy,
          onChange: () => act.toggleBundle && act.toggleBundle(bundle.name),
        }),
        h('span', { style: S.browName }, bundle.label || bundle.name),
        bundle.label && bundle.label !== bundle.name ? h('span', { style: S.mono }, bundle.name) : null,
        bundle.enabled ? h('span', { style: S.pill(C.acc) }, '已启用') : h('span', { style: S.pill(C.unk) }, '未启用'));

      const lockedRow = (bundle) => h('div', {
        key: bundle.name, style: Object.assign({}, S.brow, { opacity: 0.5 }), 'aria-disabled': 'true',
      },
        h('span', { style: { fontSize: 11, opacity: 0.7 } }, '锁'),
        h('span', { style: S.browName }, bundle.label || bundle.name),
        bundle.label && bundle.label !== bundle.name ? h('span', { style: S.mono }, bundle.name) : null,
        h('span', { style: S.reason }, bundle.reason || bundle.error || '不可切换'));

      const section = (title, items, render) => h('div', { key: title },
        h('div', { style: S.groupTitle }, title + '（' + items.length + '）'),
        items.length ? items.map(render) : h('div', { style: S.muted }, '无'));

      const rightCard = h('div', { style: S.card },
        h('div', { style: S.cardHead },
          h('div', { style: S.cardTitle }, h('span', { style: { opacity: 0.7 } }, '⚙'), '可切换插件'),
          h('div', { style: S.cardMeta }, preview ? '正在编辑：' + (preview.name || preview.id) : '未选中整合包')),
        h('div', { style: S.hint }, '勾选＝这个整合包会启用它；切换时未被勾选的可切换插件一律关闭。'),
        section('已启用', groups.enabled, bundleRow),
        section('未启用', groups.disabled, bundleRow),
        section('受保护 / 不可切换', groups.locked, lockedRow),
        h('div', { style: S.rowActions },
          h('button', {
            type: 'button', style: dirty ? S.btnPrimary : S.btn,
            disabled: readonly || busy || !preview || !dirty,
            onClick: () => act.saveBundles && act.saveBundles(),
          }, dirty ? '保存插件集合' : '插件集合已保存')));

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('div', { style: S.title }, '整合包', h('span', { style: S.sub }, diffText(data.effective))),
          h('div', { style: S.muted }, protectedCount + ' 个受保护插件')),
        banners,
        errorBar,
        topBar,
        reportBar,
        h('div', { style: S.grid }, leftCard, rightCard));
    }

    // ---------- 容器层（取数、写操作、刷新） ----------

    function ModpackTab() {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [pending, setPending] = useState(null);
      const [report, setReport] = useState(null);
      const [selectedId, setSelectedId] = useState(undefined);
      const [draft, setDraft] = useState(null);
      const [nameDraft, setNameDraft] = useState('');
      const reloaded = useRef(false);
      const attempted = useRef(null);

      const packs = data && data.state && Array.isArray(data.state.packs) ? data.state.packs : [];
      const activeId = data && data.state && data.state.activePackId !== undefined && data.state.activePackId !== null ? data.state.activePackId : null;
      const selId = selectedId === undefined ? activeId : selectedId;
      const preview = packs.filter((x) => x && x.id === selId)[0] || null;
      const members = draft !== null ? draft : membersOf(preview);

      const load = useCallback(async () => {
        setPending('load');
        setError(null);
        try {
          setData(await getState());
        } catch (e) {
          setError(messageOf(e));
        } finally {
          setPending(null);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      // 一次刷新就够：reloaded 挡住第二次 setState 引起的重复计时。
      useEffect(() => {
        if (!report || !shouldAutoReload(report) || reloaded.current) return undefined;
        reloaded.current = true;
        const timer = setTimeout(reloadPage, RELOAD_DELAY);
        return () => clearTimeout(timer);
      }, [report]);

      const run = useCallback(async (label, fn, after) => {
        setPending(label);
        setError(null);
        try {
          const value = await fn();
          if (value && value.state) setData(value);
          setReport(value && value.switch ? value.switch : null);
          setDraft(null);
          setSelectedId(undefined);
          setNameDraft('');
          if (after) after(value);
          return value;
        } catch (e) {
          setError(messageOf(e));
          return null;
        } finally {
          setPending(null);
        }
      }, []);

      const selectPack = (id) => { setSelectedId(id); setDraft(null); };
      const toggleBundle = (name) => setDraft(toggleMember(members, name));
      const setCommon = (enabled) => run('common', () => postJson(API + '/common', { enabled: Boolean(enabled) }));
      const switchTo = (id) => {
        attempted.current = id === undefined ? null : id;
        return run('switch', () => postJson(API + '/switch', { id: attempted.current }));
      };
      const retry = () => switchTo(attempted.current);

      const selectNewest = (value) => {
        const newest = newestPack(value && value.state && value.state.packs);
        if (newest) setSelectedId(newest.id);
      };

      const createPack = () => {
        const name = String(nameDraft || '').trim();
        if (!name) { setError('先填整合包名再新建。'); return Promise.resolve(null); }
        return run('save', () => postJson(API + '/pack/save', { name: name, bundles: members.slice() }), selectNewest);
      };

      const renamePack = () => {
        if (!preview) return Promise.resolve(null);
        const name = String(nameDraft || '').trim();
        if (!name) { setError('先填整合包名再改名。'); return Promise.resolve(null); }
        return run('save', () => postJson(API + '/pack/save', {
          id: preview.id, name: name, always: Boolean(preview.always), bundles: membersOf(preview).slice(),
        }), () => setSelectedId(preview.id));
      };

      const saveBundles = () => {
        if (!preview) return Promise.resolve(null);
        return run('save', () => postJson(API + '/pack/save', {
          id: preview.id, name: preview.name, always: Boolean(preview.always), bundles: members.slice(),
        }), () => setSelectedId(preview.id));
      };

      const deletePack = () => {
        if (!preview) return Promise.resolve(null);
        return run('del', () => postJson(API + '/pack/delete', { id: preview.id }));
      };

      const adoptPack = () => {
        if (!preview) return Promise.resolve(null);
        return run('adopt', () => postJson(API + '/pack/adopt', { id: preview.id }), () => setSelectedId(preview.id));
      };

      // 首次运行的引导路径：把「当前实际启用」的可切换插件直接写成新包。
      const saveCurrent = () => run('save', () => postJson(API + '/pack/save', {
        name: '我的整合包', bundles: currentlyEnabledTogglable(data),
      }), selectNewest);

      return h(ModpackView, {
        data: data,
        error: error,
        pending: pending,
        report: report,
        selectedId: selId,
        draft: draft,
        nameDraft: nameDraft,
        act: {
          load: load,
          select: selectPack,
          toggleBundle: toggleBundle,
          setNameDraft: setNameDraft,
          createPack: createPack,
          renamePack: renamePack,
          saveBundles: saveBundles,
          deletePack: deletePack,
          adoptPack: adoptPack,
          saveCurrent: saveCurrent,
          setCommon: setCommon,
          switchTo: switchTo,
          retry: retry,
        },
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.tab', () => ctx.slots.register({
          name: 'plugins.tab',
          id: 'modpack',
          order: 20,
          // 插件页的 tab 台账用 resolveSlotLabel 解析这个字段，内置 tab 都传函数。
          label: () => '整合包',
        }, ModpackTab));
      },
      __internals: {
        groupBundles: groupBundles,
        diffText: diffText,
        reportText: reportText,
        appliedText: appliedText,
        errorText: errorText,
        readEnvelope: readEnvelope,
        shouldAutoReload: shouldAutoReload,
        toggleMember: toggleMember,
        sameMembers: sameMembers,
        newestPack: newestPack,
        currentlyEnabledTogglable: currentlyEnabledTogglable,
        request: request,
        ModpackView: ModpackView,
        ModpackTab: ModpackTab,
        S: S,
      },
    };
  },
});
