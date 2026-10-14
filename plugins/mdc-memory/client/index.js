/**
 * Client row `mdc-memory-ui`: the Memory section of dsh settings. It shows the
 * state of the managed basic-memory runtime served by the Host row's HTTP API
 * (preparation stages, latest progress, error with output) and offers retry,
 * and it manages the knowledge bases: list, enable switch, delete with
 * confirmation, and add (name + absolute path).
 */
window.__ModuleLoader__.load({
  id: '@local/mdc-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useId, useRef, useState } = React;

    const NS = 'mdc-memory';
    /** Relative to the document, so the app keeps working behind a path-prefixed proxy. */
    const STATUS_PATH = 'mdc-memory/status';
    const RETRY_PATH = 'mdc-memory/retry';
    const KBS_PATH = 'mdc-memory/kbs';
    const KB_ADD_PATH = 'mdc-memory/kbs/add';
    const KB_DELETE_PATH = 'mdc-memory/kbs/delete';
    const KB_SET_ENABLED_PATH = 'mdc-memory/kbs/set-enabled';
    const POLL_MS = 2000;
    /** Error codes of the Host API that have their own message. */
    const KNOWN_ERRORS = new Set(['invalid-request', 'path-not-absolute', 'name-taken', 'name-reserved', 'path-registered', 'path-reserved', 'not-found', 'rejected', 'unavailable']);

    const zh = {
      nav: 'Memory',
      title: 'Memory',
      intro: '长期记忆由本机托管的 basic-memory 进程提供。首次启动时会自动准备 Python 环境并下载 embedding 模型。',
      state_preparing: '准备中',
      state_ready: '就绪',
      state_error: '错误',
      stage_source: '校验 basic-memory 源码',
      stage_venv: '准备 Python 环境',
      stage_model: '下载 embedding 模型',
      stage_server: '启动 basic-memory',
      stageState_pending: '等待中',
      stageState_running: '进行中',
      stageState_done: '已完成',
      stageState_failed: '失败',
      failedAt: '“{stage}”失败：{message}',
      output: '查看输出',
      retry: '重试',
      retrying: '正在重试…',
      loading: '正在读取状态…',
      loadFailed: '无法读取 Memory 状态：{message}',
      kbTitle: '知识库',
      kbIntro: '知识库是存放笔记的目录。开启的知识库就是生效知识库，agent 只在其中读写记忆、召回经验。',
      kbUnavailable: 'basic-memory 就绪后才能管理知识库。',
      kbLoading: '正在读取知识库…',
      kbEmpty: '还没有知识库。',
      kbNoneEffective: '所有知识库都已关闭，agent 不会使用记忆。',
      kbSwitch: '启用知识库“{name}”',
      kbDelete: '删除',
      kbAdd: '添加知识库',
      addTitle: '添加知识库',
      addName: '名称',
      addPath: '绝对路径',
      addPathPlaceholder: '例如 D:\\notes\\踩坑经验',
      addHint: '目录不存在时会自动创建；目录中已有的 Markdown 笔记会在后台建立索引。',
      addSubmit: '添加',
      addPending: '正在添加…',
      cancel: '取消',
      deleteTitle: '删除知识库“{name}”？',
      deleteBody: '将在 basic-memory 中注销该知识库并清理索引，磁盘上的文件不会被删除。',
      deleteConfirm: '删除',
      'error_invalid-request': '请填写名称和路径。',
      'error_path-not-absolute': '路径必须是绝对路径，例如 D:\\notes\\踩坑经验。',
      'error_name-taken': '已有名为“{knowledgeBase}”的知识库。',
      'error_name-reserved': '这个名称是内部保留的，请换一个。',
      'error_path-registered': '该目录与知识库“{knowledgeBase}”的目录重叠。',
      'error_path-reserved': '该目录与 Memory 的内部数据目录重叠。',
      'error_not-found': '知识库“{knowledgeBase}”不存在，可能已被删除。',
      error_rejected: 'basic-memory 拒绝了该操作：{message}',
      error_unavailable: 'basic-memory 尚未就绪，请稍后再试。',
      error_generic: '操作失败：{message}',
    };
    const en = {
      nav: 'Memory',
      title: 'Memory',
      intro: 'Long-term memory is served by a basic-memory process on this machine. The first start prepares a Python environment and downloads the embedding model.',
      state_preparing: 'Preparing',
      state_ready: 'Ready',
      state_error: 'Error',
      stage_source: 'Check basic-memory source',
      stage_venv: 'Prepare Python environment',
      stage_model: 'Download embedding model',
      stage_server: 'Start basic-memory',
      stageState_pending: 'Waiting',
      stageState_running: 'In progress',
      stageState_done: 'Done',
      stageState_failed: 'Failed',
      failedAt: '"{stage}" failed: {message}',
      output: 'Show output',
      retry: 'Retry',
      retrying: 'Retrying…',
      loading: 'Loading status…',
      loadFailed: 'Could not load memory status: {message}',
      kbTitle: 'Knowledge bases',
      kbIntro: 'A knowledge base is a directory of notes. Enabled knowledge bases are the effective ones: agents read, write and recall memory only there.',
      kbUnavailable: 'Knowledge bases can be managed once basic-memory is ready.',
      kbLoading: 'Loading knowledge bases…',
      kbEmpty: 'No knowledge base yet.',
      kbNoneEffective: 'Every knowledge base is turned off; agents will not use memory.',
      kbSwitch: 'Enable knowledge base "{name}"',
      kbDelete: 'Delete',
      kbAdd: 'Add knowledge base',
      addTitle: 'Add knowledge base',
      addName: 'Name',
      addPath: 'Absolute path',
      addPathPlaceholder: 'e.g. D:\\notes\\lessons',
      addHint: 'A missing directory is created; Markdown notes already in it are indexed in the background.',
      addSubmit: 'Add',
      addPending: 'Adding…',
      cancel: 'Cancel',
      deleteTitle: 'Delete knowledge base "{name}"?',
      deleteBody: 'It is unregistered from basic-memory and its index is dropped. Files on disk are kept.',
      deleteConfirm: 'Delete',
      'error_invalid-request': 'Enter a name and a path.',
      'error_path-not-absolute': 'The path must be absolute, e.g. D:\\notes\\lessons.',
      'error_name-taken': 'A knowledge base named "{knowledgeBase}" already exists.',
      'error_name-reserved': 'This name is reserved for internal use; choose another one.',
      'error_path-registered': 'The directory overlaps the one of knowledge base "{knowledgeBase}".',
      'error_path-reserved': 'The directory overlaps the internal Memory data directory.',
      'error_not-found': 'Knowledge base "{knowledgeBase}" does not exist; it may have been deleted.',
      error_rejected: 'basic-memory refused: {message}',
      error_unavailable: 'basic-memory is not ready yet; try again shortly.',
      error_generic: 'The operation failed: {message}',
    };

    const CSS = `
.mdcm-section{max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}
.mdcm-title{margin:0;font-size:18px;font-weight:600}
.mdcm-intro{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.mdcm-card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.mdcm-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.mdcm-badge{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.mdcm-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.mdcm-badge[data-state=preparing] .mdcm-dot{background:var(--dsw-alias-state-business-primary);animation:mdcm-pulse 1.2s ease-in-out infinite}
.mdcm-badge[data-state=ready] .mdcm-dot{background:var(--dsw-alias-state-success-primary)}
.mdcm-badge[data-state=error] .mdcm-dot{background:var(--dsw-alias-state-error-primary)}
@keyframes mdcm-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.mdcm-badge[data-state=preparing] .mdcm-dot{animation:none}}
.mdcm-stages{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.mdcm-stage{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.mdcm-marker{box-sizing:border-box;flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;border:1px solid var(--dsw-alias-border-l3);font-size:10px;line-height:1}
.mdcm-stage[data-state=running] .mdcm-marker{border-color:var(--dsw-alias-state-business-primary);border-top-color:transparent;animation:mdcm-spin .9s linear infinite}
.mdcm-stage[data-state=done] .mdcm-marker{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.mdcm-stage[data-state=failed] .mdcm-marker{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.mdcm-stage[data-state=running],.mdcm-stage[data-state=failed]{color:var(--dsw-alias-label-primary)}
@keyframes mdcm-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mdcm-stage[data-state=running] .mdcm-marker{animation:none}}
.mdcm-stage-label{flex:1;min-width:0}
.mdcm-stage-state{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mdcm-detail{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdcm-error{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.mdcm-output summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
.mdcm-output pre{box-sizing:border-box;max-height:220px;margin:6px 0 0;padding:8px 10px;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.mdcm-btn{box-sizing:border-box;flex:none;height:28px;padding:0 12px;font-size:12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer}
.mdcm-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.mdcm-btn:disabled{opacity:.5;cursor:default}
.mdcm-btn:focus-visible,.mdcm-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.mdcm-btn.mdcm-btn-secondary{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.mdcm-btn.mdcm-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mdcm-btn.mdcm-btn-danger{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}
.mdcm-btn.mdcm-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);opacity:.85}
.mdcm-muted{font-size:13px;color:var(--dsw-alias-label-tertiary)}
.mdcm-subtitle{margin:0;font-size:14px;font-weight:600}
.mdcm-kbs{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.mdcm-kb{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l2)}
.mdcm-kb:first-child{border-top:0;padding-top:0}
.mdcm-kb-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.mdcm-kb-name{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdcm-kb-path{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdcm-add{align-self:flex-start}
.mdcm-switch{box-sizing:border-box;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.mdcm-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.mdcm-switch:disabled{opacity:.5;cursor:default}
.mdcm-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform 120ms ease}
.mdcm-switch[aria-checked=true] .mdcm-thumb{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}
@media (prefers-reduced-motion:reduce){.mdcm-thumb{transition:none}}
.mdcm-modal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px}
.mdcm-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}
.mdcm-dialog{position:relative;box-sizing:border-box;width:min(420px,100%);display:flex;flex-direction:column;gap:14px;padding:22px 24px 24px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary)}
.mdcm-dialog-title{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.mdcm-dialog-body{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.mdcm-form{display:contents}
.mdcm-field{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.mdcm-input{box-sizing:border-box;height:32px;padding:0 8px;font-size:14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none}
.mdcm-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.mdcm-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mdcm-actions{display:flex;justify-content:flex-end;gap:8px}`;

    const STAGE_MARKS = { pending: '', running: '', done: '✓', failed: '✕' };

    /** Fetch JSON; a failure carries the Host's `code` and `details` for localized messages. */
    async function request(path, init) {
      const res = await fetch(path, { ...init, headers: { accept: 'application/json', ...init?.headers } });
      const body = await res.json().catch(() => undefined);
      if (!res.ok) throw Object.assign(new Error(body?.message ?? `HTTP ${res.status}`), { code: body?.code, details: body?.details });
      return body;
    }

    function post(path, payload) {
      return request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    }

    function describeError(t, error) {
      if (KNOWN_ERRORS.has(error.code)) return t(`error_${error.code}`, { ...error.details, message: error.message });
      return t('error_generic', { message: error.message });
    }

    /** Poll the runtime status while the section is mounted. */
    function useRuntimeStatus() {
      const [status, setStatus] = useState();
      const [loadError, setLoadError] = useState('');
      useEffect(() => {
        let cancelled = false;
        let timer;
        const poll = async () => {
          try {
            const next = await request(STATUS_PATH);
            if (cancelled) return;
            setStatus(next);
            setLoadError('');
          } catch (error) {
            if (!cancelled) setLoadError(error.message);
          }
          if (!cancelled) timer = setTimeout(poll, POLL_MS);
        };
        void poll();
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, []);
      return { status, setStatus, loadError, setLoadError };
    }

    /** The knowledge base list, read whenever basic-memory becomes ready and after each change. */
    function useKnowledgeBases(ready) {
      const [listing, setListing] = useState();
      const [error, setError] = useState();
      const reload = useCallback(async () => {
        try {
          setListing(await request(KBS_PATH));
          setError(undefined);
        } catch (failure) {
          setError(failure);
        }
      }, []);
      useEffect(() => {
        if (ready) void reload();
      }, [ready, reload]);
      return { listing, error, setError, reload };
    }

    function StageList({ t, stages }) {
      return h('ol', { className: 'mdcm-stages' }, stages.map((stage) => h('li', { key: stage.id, className: 'mdcm-stage', 'data-state': stage.state },
        h('span', { className: 'mdcm-marker', 'aria-hidden': true }, STAGE_MARKS[stage.state]),
        h('span', { className: 'mdcm-stage-label' }, t(`stage_${stage.id}`)),
        h('span', { className: 'mdcm-stage-state' }, t(`stageState_${stage.state}`)))));
    }

    function ErrorReport({ t, error }) {
      return h('div', { className: 'mdcm-error' },
        h('div', null, t('failedAt', { stage: t(`stage_${error.stage}`), message: error.message })),
        error.output && h('details', { className: 'mdcm-output' },
          h('summary', null, t('output')),
          h('pre', null, error.output)));
    }

    function RuntimeCard({ t, status, setStatus, setLoadError }) {
      const [retrying, setRetrying] = useState(false);
      const retry = useCallback(async () => {
        setRetrying(true);
        try {
          setStatus(await post(RETRY_PATH, {}));
          setLoadError('');
        } catch (error) {
          setLoadError(error.message);
        } finally {
          setRetrying(false);
        }
      }, [setStatus, setLoadError]);
      return h('div', { className: 'mdcm-card', role: 'status', 'aria-live': 'polite' },
        h('div', { className: 'mdcm-head' },
          h('span', { className: 'mdcm-badge', 'data-state': status.state },
            h('span', { className: 'mdcm-dot', 'aria-hidden': true }),
            t(`state_${status.state}`)),
          status.state === 'error' && h('button', { type: 'button', className: 'mdcm-btn', disabled: retrying, onClick: retry },
            retrying ? t('retrying') : t('retry'))),
        h(StageList, { t, stages: status.stages }),
        status.state === 'preparing' && status.detail && h('div', { className: 'mdcm-detail', title: status.detail }, status.detail),
        status.state === 'error' && h(ErrorReport, { t, error: status.error }));
    }

    function Switch({ checked, disabled, label, onChange }) {
      return h('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled, className: 'mdcm-switch', onClick: () => onChange(!checked) },
        h('span', { className: 'mdcm-thumb' }));
    }

    const focusablesIn = (root) => [...root.querySelectorAll('button:not(:disabled), input:not(:disabled)')];

    /**
     * Modal layered over the settings panel. Escape and Tab are handled here
     * and marked handled (preventDefault), because the settings panel ignores
     * key events that are already handled; otherwise Escape would close it too.
     */
    function Dialog({ title, alert, onClose, children }) {
      const ref = useRef(null);
      const titleId = useId();
      useEffect(() => {
        const previous = document.activeElement;
        (ref.current.querySelector('[data-autofocus]') ?? focusablesIn(ref.current)[0])?.focus();
        return () => previous?.focus?.();
      }, []);
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
          return;
        }
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const items = focusablesIn(ref.current);
        if (items.length === 0) return;
        const at = items.indexOf(document.activeElement);
        const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
        items[next].focus();
      };
      return h('div', { className: 'mdcm-modal', role: 'presentation', onKeyDown },
        h('div', { className: 'mdcm-mask', 'aria-hidden': true, onClick: onClose }),
        h('div', { ref, className: 'mdcm-dialog', role: alert ? 'alertdialog' : 'dialog', 'aria-modal': true, 'aria-labelledby': titleId },
          h('h3', { id: titleId, className: 'mdcm-dialog-title' }, title),
          children));
    }

    function AddDialog({ t, onAdded, onClose }) {
      const [name, setName] = useState('');
      const [path, setPath] = useState('');
      const [pending, setPending] = useState(false);
      const [error, setError] = useState();
      const submit = async (event) => {
        event.preventDefault();
        setPending(true);
        try {
          await post(KB_ADD_PATH, { name: name.trim(), path: path.trim() });
          onAdded();
        } catch (failure) {
          setError(failure);
          setPending(false);
        }
      };
      return h(Dialog, { title: t('addTitle'), onClose: pending ? () => {} : onClose },
        h('form', { className: 'mdcm-form', onSubmit: submit },
          h('label', { className: 'mdcm-field' }, t('addName'),
            h('input', { className: 'mdcm-input', value: name, disabled: pending, 'data-autofocus': true, autoComplete: 'off', onChange: (event) => setName(event.target.value) })),
          h('label', { className: 'mdcm-field' }, t('addPath'),
            h('input', { className: 'mdcm-input', value: path, disabled: pending, placeholder: t('addPathPlaceholder'), spellCheck: false, autoComplete: 'off', onChange: (event) => setPath(event.target.value) })),
          h('p', { className: 'mdcm-hint' }, t('addHint')),
          error && h('div', { className: 'mdcm-error', role: 'alert' }, describeError(t, error)),
          h('div', { className: 'mdcm-actions' },
            h('button', { type: 'button', className: 'mdcm-btn mdcm-btn-secondary', disabled: pending, onClick: onClose }, t('cancel')),
            h('button', { type: 'submit', className: 'mdcm-btn', disabled: pending || name.trim() === '' || path.trim() === '' },
              pending ? t('addPending') : t('addSubmit')))));
    }

    function DeleteDialog({ t, knowledgeBase, onConfirm, onClose }) {
      return h(Dialog, { title: t('deleteTitle', { name: knowledgeBase.name }), alert: true, onClose },
        h('p', { className: 'mdcm-dialog-body' }, t('deleteBody')),
        h('div', { className: 'mdcm-actions' },
          h('button', { type: 'button', className: 'mdcm-btn mdcm-btn-secondary', 'data-autofocus': true, onClick: onClose }, t('cancel')),
          h('button', { type: 'button', className: 'mdcm-btn mdcm-btn-danger', onClick: onConfirm }, t('deleteConfirm'))));
    }

    function KnowledgeBaseCard({ t, ready }) {
      const { listing, error, setError, reload } = useKnowledgeBases(ready);
      const [busy, setBusy] = useState(() => new Set());
      const [adding, setAdding] = useState(false);
      const [deleting, setDeleting] = useState();

      const mutate = useCallback(async (name, path, payload) => {
        setBusy((current) => new Set(current).add(name));
        try {
          await post(path, payload);
          setError(undefined);
        } catch (failure) {
          setError(failure);
        } finally {
          await reload();
          setBusy((current) => {
            const next = new Set(current);
            next.delete(name);
            return next;
          });
        }
      }, [reload, setError]);

      const items = listing?.items ?? [];
      let body;
      if (!ready) body = h('div', { className: 'mdcm-muted' }, t('kbUnavailable'));
      else if (listing === undefined) body = !error && h('div', { className: 'mdcm-muted' }, t('kbLoading'));
      else if (items.length === 0) body = h('div', { className: 'mdcm-muted' }, t('kbEmpty'));
      else {
        body = h('ul', { className: 'mdcm-kbs' }, items.map((knowledgeBase) => h('li', { key: knowledgeBase.name, className: 'mdcm-kb' },
          h('div', { className: 'mdcm-kb-text' },
            h('span', { className: 'mdcm-kb-name', title: knowledgeBase.name }, knowledgeBase.name),
            h('span', { className: 'mdcm-kb-path', title: knowledgeBase.path }, knowledgeBase.path)),
          h(Switch, {
            checked: knowledgeBase.enabled,
            disabled: busy.has(knowledgeBase.name),
            label: t('kbSwitch', { name: knowledgeBase.name }),
            onChange: (enabled) => mutate(knowledgeBase.name, KB_SET_ENABLED_PATH, { name: knowledgeBase.name, enabled }),
          }),
          h('button', { type: 'button', className: 'mdcm-btn mdcm-btn-secondary', disabled: busy.has(knowledgeBase.name), onClick: () => setDeleting(knowledgeBase) },
            t('kbDelete')))));
      }

      return h('div', { className: 'mdcm-card' },
        h('h3', { className: 'mdcm-subtitle' }, t('kbTitle')),
        h('p', { className: 'mdcm-intro' }, t('kbIntro')),
        body,
        ready && items.length > 0 && listing.effective.length === 0 && h('div', { className: 'mdcm-muted' }, t('kbNoneEffective')),
        error && h('div', { className: 'mdcm-error', role: 'alert' }, describeError(t, error)),
        h('button', { type: 'button', className: 'mdcm-btn mdcm-btn-secondary mdcm-add', disabled: !ready, onClick: () => setAdding(true) }, `+ ${t('kbAdd')}`),
        adding && h(AddDialog, {
          t,
          onClose: () => setAdding(false),
          onAdded: () => {
            setAdding(false);
            setError(undefined);
            void reload();
          },
        }),
        deleting && h(DeleteDialog, {
          t,
          knowledgeBase: deleting,
          onClose: () => setDeleting(undefined),
          onConfirm: () => {
            setDeleting(undefined);
            void mutate(deleting.name, KB_DELETE_PATH, { name: deleting.name });
          },
        }));
    }

    function MemorySection({ t }) {
      const { status, setStatus, loadError, setLoadError } = useRuntimeStatus();
      return h('section', { className: 'mdcm-section' },
        h('style', null, CSS),
        h('h2', { className: 'mdcm-title' }, t('title')),
        h('p', { className: 'mdcm-intro' }, t('intro')),
        status === undefined
          ? !loadError && h('div', { className: 'mdcm-muted' }, t('loading'))
          : h(RuntimeCard, { t, status, setStatus, setLoadError }),
        loadError && h('div', { className: 'mdcm-error', role: 'alert' }, t('loadFailed', { message: loadError })),
        h(KnowledgeBaseCard, { t, ready: status?.state === 'ready' }));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const tr = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mdc-memory: dictionaries');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'memory',
          order: 30,
          label: () => tr('nav'),
          locale: NS,
        }, MemorySection));
      },
    };
  },
});
