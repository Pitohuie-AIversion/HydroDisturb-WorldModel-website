import {loadWakeManifest, type WakeManifest} from './wake';
import {readFocus} from './models/focus';

type RolloutState = {base: number; k: number};

function findFrame(manifest: WakeManifest, step: number) {
  const exact = manifest.frames.find(frame => frame.step === step);
  if (exact) return {frame: exact, exact: true};
  const prior = manifest.frames.filter(frame => frame.step <= step).at(-1) ?? manifest.frames[0];
  return {frame: prior, exact: false};
}

function format(value: number, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function tokenBounds() {
  const {z, y, x} = readFocus();
  return 'Z' + (z * 8) + '–' + (z * 8 + 7) + ' · Y' + (y * 8) + '–' + (y * 8 + 7) + ' · X' + (x * 8) + '–' + (x * 8 + 7);
}

export function mountDataThread(before: HTMLElement, panel: HTMLElement, index: number) {
  const thread = document.createElement('section');
  thread.className = 'data-thread';
  thread.setAttribute('aria-label', '贯穿章节的 C04 流场数据');
  thread.innerHTML = [
    '<div class="data-thread-head"><span class="data-thread-kicker"><i></i> C04 · REAL FIELD</span><span class="data-thread-note">同一流场参考</span></div>',
    '<div class="data-thread-grid">',
    '<div><small>物理时刻</small><b data-thread-time>载入中</b><span data-thread-step></span></div>',
    '<div><small>空间块</small><b data-thread-region></b><span>Token 与原网格保持对应</span></div>',
    '<div class="data-thread-values"><small>真实场统计 · 当前归档</small><b data-thread-values>ū —　v̄ —　w̄ —　p̄ —</b><span>均值 · m/s / Pa</span></div>',
    '<div><small>字段与色标</small><b>u · v · w · p</b><span>固定物理范围 · C04 81 帧</span></div>',
    '</div>'
  ].join('');
  before.before(thread);

  const time = thread.querySelector<HTMLElement>('[data-thread-time]')!;
  const step = thread.querySelector<HTMLElement>('[data-thread-step]')!;
  const region = thread.querySelector<HTMLElement>('[data-thread-region]')!;
  const values = thread.querySelector<HTMLElement>('[data-thread-values]')!;
  const note = thread.querySelector<HTMLElement>('.data-thread-note')!;
  const abort = new AbortController();
  let manifest: WakeManifest | undefined;
  let currentStep: number | undefined;
  let forecastLabel = '模拟预测';

  function renderRegion() {
    region.textContent = tokenBounds();
  }
  function renderFrame(requested = currentStep ?? manifest?.modelReferenceFrame ?? 0) {
    if (!manifest) return;
    const {frame, exact} = findFrame(manifest, requested);
    currentStep = requested;
    time.textContent = frame.time_s.toFixed(2) + ' s';
    step.textContent = exact ? 'solver step ' + frame.step : '目标 step ' + requested + ' · 参照 ' + frame.step;
    const stats = frame.stats6 ?? [];
    values.textContent = 'ū ' + format(stats[0]) + '　v̄ ' + format(stats[1]) + '　w̄ ' + format(stats[2]) + '　p̄ ' + format(stats[3]);
    note.textContent = index === 0 ? '真实归档帧' : index === 6 ? 'C04 '+(exact?'同帧真值':'前档参照')+' · '+forecastLabel : '同一 C04 参考帧';
    renderRegion();
  }

  const stageTag = document.getElementById('stage-tag');
  const observer = stageTag ? new MutationObserver(() => {
    const value = Number(stageTag.dataset.step);
    if (Number.isFinite(value)) renderFrame(value);
  }) : undefined;
  observer?.observe(stageTag!, {attributes: true, attributeFilter: ['data-step']});
  panel.addEventListener('rollout-step', event => {
    const {base, k} = (event as CustomEvent<RolloutState>).detail;
    currentStep=base+k;
    renderFrame(base + k);
  }, {signal: abort.signal});
  panel.addEventListener('rollout-source', event => {
    forecastLabel=(event as CustomEvent<{label:string}>).detail.label;
    if(currentStep!==undefined)renderFrame(currentStep);
  }, {signal:abort.signal});
  window.addEventListener('flowscope-focus', renderRegion, {signal: abort.signal});

  void loadWakeManifest().then(loaded => {
    if (abort.signal.aborted) return;
    manifest = loaded;
    renderFrame(currentStep??(index === 0 ? loaded.frames[0].step : loaded.frames[loaded.modelReferenceFrame].step));
  });

  return {
    setFrame(stepValue: number) { renderFrame(stepValue); },
    dispose() {
      abort.abort();
      observer?.disconnect();
      thread.remove();
    }
  };
}
