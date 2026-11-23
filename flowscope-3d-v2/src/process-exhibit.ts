import { readFocus } from './models/focus';

type Step = [title: string, formula: string, description: string];
interface Exhibit {
  title: [string, string];
  instruction: string;
  measure: [string, string];
  steps: Step[];
}

const exhibits: Record<number, Exhibit | undefined> = {
  1: {
    title: ['从体素', '到 Token'],
    instruction: '点圆柱下游的一块流体。逐层切换，看同一位置怎样被收进更粗的网格。',
    measure: ['空间网格 · Z × Y × X', '64 × 96 × 192'],
    steps: [
      ['输入场', 'Stem · C32', '四个物理通道与两个几何通道一起进入 Stem。先在尾流里选定位置。'],
      ['第一次折叠', 'S2C 01 · C64', '相邻 2 × 2 × 2 个空间位置重排到通道维，三条空间轴各缩短一半。'],
      ['第二次折叠', 'S2C 02 · C128', '颜色标出同一块流体。每个输出格点现在对应原网格中 4 × 4 × 4 个位置。'],
      ['定位 Token', 'S2C 03 · C256', '三次重排后，一个空间格点对应 8 × 8 × 8 个输入位置。带着这个位置进入潜空间。']
    ]
  },
  2: {
    title: ['展开一个', 'Token'],
    instruction: '接着看编码章选中的位置。点另一个 Token 或改变特征维度，观察向量截面。',
    measure: ['每个空间位置', '256 维'],
    steps: [
      ['空间索引', '8 × 12 × 24', '在 2,304 个格点中找回刚才的位置。切换格点会同时改变所查看的 Token。'],
      ['特征截面', 'D = 256', '展开该 Token 的通道向量，比较 RMSNorm 前后的特征幅值。'],
      ['物理探针', 'Enstrophy / Spectrum', '两个 Probe 从整帧潜状态估计拟能和能谱。六维统计 b 走独立旁路。']
    ]
  },
  3: {
    title: ['回到', '物理空间'],
    instruction: '带着同一 Token 回到尾流。依次查看解码、物理读出和边界约束。',
    measure: ['物理读出', 'u · v · w · p'],
    steps: [
      ['逐级展开', 'C2S × 3', '沿编码的反方向恢复空间分辨率，在原网格找到所选 Token 对应的区域。'],
      ['速度与压力', 'Curl(A) / p′', '矢量势经相容离散旋度得到速度脉动，压力由另一支路单独读出。'],
      ['恢复量纲', '统计旁路 b', '均值和尺度经独立旁路送入读出端，将脉动还原为物理量。'],
      ['检查边界', 'fluid / stencil', '查看流体掩码与导数模板的有效范围，区分可读取物理量和可计算导数的位置。']
    ]
  },
  4: {
    title: ['四帧历史', '双轨对读'],
    instruction: '点下排的 Query，沿亮起的连线向上找它此刻能读到的历史 K/V。',
    measure: ['历史窗口', 'L = 4'],
    steps: [
      ['条件前缀', '5 prefix tokens', '每帧先接入 Text、Phys、Step、Action、Regime 五个条件槽。'],
      ['历史编码', 'Clean → K/V', '上排按时间排列已知帧。Clean 轨生成历史 K/V，供 Query 读取。'],
      ['读取历史', 'Query → K/V', '点击下排任一 Query，比较亮起的历史长度，观察因果边界怎样随查询时刻移动。'],
      ['输出分支', 'vθ / b̂', '当前 Query 接速度头，历史 Clean 表征接统计预测头。切换训练和推理可检查监督来源。']
    ]
  },
  6: {
    title: ['滚动预测', '同帧对照'],
    instruction: '沿一条剖线对照 C04 尾流和模拟预测。推进窗口，看峰值逐渐偏向哪里。',
    measure: ['滚动步数 H', '10 / 50 / 100'],
    steps: [
      ['读取历史', 't−3 … t', '取出当前四帧历史。窗口中的步号标明这一轮预测从哪里出发。'],
      ['解码下一帧', 'ẑ, b̂ → U, p', '下一潜状态和预测统计共同恢复物理场。目标步有 C04 归档时可做同帧对照，缺档时标出前一帧供参照。'],
      ['回填窗口', 'FIFO · L = 4', '移出最早一帧，把新预测写到窗口末端，查看下一轮实际要读取的四帧。'],
      ['剖面对照', 'CFD / prediction', '预测与真值共用物理色标。点一条剖线查看峰位偏差，或切到绝对误差，定位偏差最大的区域。']
    ]
  }
};

export function mountExhibit(index: number, interactive: boolean, select: (step: number) => void) {
  const exhibit = interactive ? exhibits[index] : undefined;
  const body = document.body;
  const heading = document.getElementById('chapter-head')!;
  const viewport = document.getElementById('viewport')!;
  body.classList.toggle('process-exhibit', Boolean(exhibit));
  body.classList.toggle('wide-exhibit', Boolean(exhibit) && (index === 4 || index === 6));
  heading.classList.toggle('process-intro', Boolean(exhibit));
  if (!exhibit) return;
  viewport.prepend(heading);
  const accent = document.createElement('span');
  accent.textContent = exhibit.title[1];
  document.getElementById('title')!.replaceChildren(exhibit.title[0], accent);
  document.getElementById('subtitle')!.textContent = exhibit.instruction;
  const readout = document.createElement('div');
  readout.className = 'process-measure';
  readout.innerHTML = '<small></small><b></b>';
  readout.firstElementChild!.textContent = exhibit.measure[0];
  readout.lastElementChild!.textContent = exhibit.measure[1];
  heading.append(readout);
  const signal = new AbortController();
  const location = document.createElement('div');
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'exhibit-action';
  if (index <= 3) {
    location.className = 'focus-location';
    const refresh = () => {
      const {z,y,x} = readFocus();
      location.textContent = '追踪格点　Z ' + z + '　Y ' + y + '　X ' + x;
    };
    refresh();
    window.addEventListener('flowscope-focus', refresh, {signal: signal.signal});
    heading.append(location);
    const target = index === 1 ? 'latent' : index === 2 ? 'decoder' : 'encoder';
    action.textContent = index === 1 ? '展开这个 Token →' : index === 2 ? '追踪至物理解码 →' : '返回编码选区 ↗';
    action.onclick = () => { window.location.hash = target; };
    heading.append(action);
  } else if (index === 6) {
    action.textContent = '导入预测切片';
    action.onclick = () => document.querySelector<HTMLInputElement>('#panel [data-forecast]')?.click();
    readout.append(action);
  }
  const strip = document.createElement('section');
  strip.className = 'process-strip';
  strip.setAttribute('aria-label', '本章交互过程');
  const row = document.createElement('div');
  row.className = 'process-stops';
  row.style.setProperty('--stops', String(exhibit.steps.length));
  const text = document.createElement('p');
  const buttons = exhibit.steps.map(([title, formula], i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.processIndex = String(i);
    button.innerHTML = '<small></small><strong></strong>';
    button.firstElementChild!.textContent = formula;
    button.lastElementChild!.textContent = title;
    button.onclick = () => { select(i); };
    row.append(button);
    return button;
  });
  strip.append(row,text);
  viewport.after(strip);
  function show(step: number) {
    if (!exhibit || !Number.isInteger(step) || !buttons[step]) return;
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === step)));
    text.textContent = exhibit.steps[step][2];
  }
  show(0);
  return {show, dispose() { signal.abort(); action.remove(); location.remove(); readout.remove(); strip.remove(); }};
}
