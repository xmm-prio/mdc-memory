/**
 * Client row `mdc-memory-ui`: the Memory section of dsh settings. It shows the
 * state of the managed basic-memory runtime served by the Host row's HTTP API
 * (preparation stages, latest progress, error with output) and offers retry.
 */
window.__ModuleLoader__.load({
  id: '@local/mdc-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const NS = 'mdc-memory';
    /** Relative to the document, so the app keeps working behind a path-prefixed proxy. */
    const STATUS_PATH = 'mdc-memory/status';
    const RETRY_PATH = 'mdc-memory/retry';
    const POLL_MS = 2000;

    const zh = {
      nav: 'Memory',
      title: 'Memory',
      intro: '长期记忆由本机托管的 basic-memory 进程提供。首次启动时会自动准备 Python 环境并下载 embedding 模型。',
      state_preparing: '准备中',
      state_ready: '就绪',
      state_error: '错误',
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
    };
    const en = {
      nav: 'Memory',
      title: 'Memory',
      intro: 'Long-term memory is served by a basic-memory process on this machine. The first start prepares a Python environment and downloads the embedding model.',
      state_preparing: 'Preparing',
      state_ready: 'Ready',
      state_error: 'Error',
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
.mdcm-btn{box-sizing:border-box;height:28px;padding:0 12px;font-size:12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer}
.mdcm-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.mdcm-btn:disabled{opacity:.5;cursor:default}
.mdcm-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.mdcm-muted{font-size:13px;color:var(--dsw-alias-label-tertiary)}`;

    const STAGE_MARKS = { pending: '', running: '', done: '✓', failed: '✕' };

    async function request(path, init) {
      const res = await fetch(path, { ...init, headers: { accept: 'application/json', ...init?.headers } });
      const body = await res.json().catch(() => undefined);
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      return body;
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

    function MemorySection({ t }) {
      const { status, setStatus, loadError, setLoadError } = useRuntimeStatus();
      const [retrying, setRetrying] = useState(false);
      const retry = useCallback(async () => {
        setRetrying(true);
        try {
          setStatus(await request(RETRY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
          setLoadError('');
        } catch (error) {
          setLoadError(error.message);
        } finally {
          setRetrying(false);
        }
      }, [setStatus, setLoadError]);

      return h('section', { className: 'mdcm-section' },
        h('style', null, CSS),
        h('h2', { className: 'mdcm-title' }, t('title')),
        h('p', { className: 'mdcm-intro' }, t('intro')),
        status === undefined
          ? !loadError && h('div', { className: 'mdcm-muted' }, t('loading'))
          : h('div', { className: 'mdcm-card', role: 'status', 'aria-live': 'polite' },
            h('div', { className: 'mdcm-head' },
              h('span', { className: 'mdcm-badge', 'data-state': status.state },
                h('span', { className: 'mdcm-dot', 'aria-hidden': true }),
                t(`state_${status.state}`)),
              status.state === 'error' && h('button', { type: 'button', className: 'mdcm-btn', disabled: retrying, onClick: retry },
                retrying ? t('retrying') : t('retry'))),
            h(StageList, { t, stages: status.stages }),
            status.state === 'preparing' && status.detail && h('div', { className: 'mdcm-detail', title: status.detail }, status.detail),
            status.state === 'error' && h(ErrorReport, { t, error: status.error })),
        loadError && h('div', { className: 'mdcm-error', role: 'alert' }, t('loadFailed', { message: loadError })));
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
