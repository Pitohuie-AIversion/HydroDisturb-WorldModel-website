import {names, physicalChannels} from './chapters';
import {loadWakeManifest} from './wake';

const architectureLink='<a href="./references/architecture-v1.2.svg" target="_blank" rel="noopener">对照 V1.2 原始架构 ↗</a>';

function trainingSample(details:HTMLElement,panel:HTMLElement){
  details.innerHTML=`
    <article class="detail-card worked-example">
      <header><h2>训练时，速度标签从哪里来？</h2><small>独立合成样本 · 特征 D0</small></header>
      <p>训练样本同时给出前后两帧。设这个特征从 <b>0.20</b> 变到 <b>1.00</b>，沿两端点的直线抽取一个中间状态。</p>
      <label class="example-slider">取样位置 τ <input id="training-tau" aria-label="训练样本的取样位置" type="range" min="0" max="1" step="0.05" value="0.5"><output for="training-tau"></output></label>
      <div class="example-equation" data-training-state></div>
      <p>这条直线的目标速度 <b>v* = 1.00 − 0.20 = 0.80</b>。改变取样位置，目标速度保持相同。</p>
    </article>
    <article class="detail-card worked-example">
      <header><h2>拆开看这一个积分步</h2><small data-phase-step></small></header>
      <div class="example-phases" role="group" aria-label="单步推演的四个环节">
        ${['组成 Query','读取历史','求速度','写回状态'].map((name,i)=>`<button type="button" data-fm-phase="${i}" aria-pressed="${i===0}">${name}</button>`).join('')}
      </div>
      <div class="example-equation" data-phase-expression></div>
      <p data-phase-reading></p>
      <p><a href="#temporal">查看双轨与历史缓存 ←</a>　<a href="#rollout">查看下一帧如何回填 →</a></p>
    </article>`;
  const slider=details.querySelector<HTMLInputElement>('#training-tau')!;
  const value=details.querySelector<HTMLOutputElement>('output')!;
  const equation=details.querySelector<HTMLElement>('[data-training-state]')!;
  function update(){
    const t=slider.valueAsNumber;
    value.value=t.toFixed(2);
    equation.textContent=`zτ = (1 − ${t.toFixed(2)}) × 0.20 + ${t.toFixed(2)} × 1.00 = ${(0.2+0.8*t).toFixed(2)}`;
  }
  slider.addEventListener('input',update);
  update();
  const phases=details.querySelectorAll<HTMLButtonElement>('[data-fm-phase]');
  phases.forEach(button=>button.addEventListener('click',()=>{
    phases.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    panel.dispatchEvent(new CustomEvent('fm-select-phase',{detail:Number(button.dataset.fmPhase)}));
    updateFmExplanation(details,panel);
  }));
  updateFmExplanation(details,panel);
}

export function updateFmExplanation(details:HTMLElement,panel:HTMLElement,activePhase?:number){
  if(activePhase!==undefined){
    details.querySelectorAll<HTMLButtonElement>('[data-fm-phase]').forEach(button=>{
      button.setAttribute('aria-pressed',String(Number(button.dataset.fmPhase)===activePhase));
    });
  }
  const phase=details.querySelector<HTMLButtonElement>('[data-fm-phase][aria-pressed=true]');
  if(!phase)return;
  const read=(selector:string,fallback:string)=>panel.querySelector(selector)?.textContent??fallback;
  const feature=read('[data-fm-feature][aria-pressed=true]','D0');
  const current=read('[data-fm-value=current]','0.2000');
  const velocity=read('[data-fm-value=velocity]','0.9000');
  const next=read('[data-fm-value=next]','0.3125');
  const step=read('[data-iter]','Euler 第 1 / 8 步');
  const items=[
    [`${read('[data-call]','τ 0.000 → 0.125')}　·　${feature} = ${current}`,
      '用本步起点的潜状态 zₖ、生成时间 τₖ 和已知条件组成 Query。起始步从最后一帧历史潜状态 zₜ 出发。普通 FM 的步长条件 d 为 0。'],
    ['Queryₖ → 同层历史 K / V → Transformer 表示',
      'Query 在每一层根据相关性读取四帧 Clean 历史。当前积分步可以改变注意力权重，历史键和值在整个物理步内保持固定。'],
    [`vₖ[${feature}] = ${velocity}`,
      '单速度头把当前 Query 表示映射为各潜特征对 τ 的变化率。这里用明示的教学函数算出所选分量；其单位是潜特征每单位 τ。'],
    [`${read('[data-fm-equation]','0.2000 + 0.125 × 0.9000 = 0.3125')}`,
      `所选分量更新到 ${next}。还未到 τ = 1 时，用新状态和新的 τ 重算 Query。到终点时，将 ẑ 与历史分支给出的六维统计 b̂ 一起送入解码器。`],
  ];
  const [expression,reading]=items[Number(phase.dataset.fmPhase)];
  details.querySelector<HTMLElement>('[data-phase-step]')!.textContent=step==='8 步完成'?'回看第 8 步':step;
  details.querySelector<HTMLElement>('[data-phase-expression]')!.textContent=expression;
  details.querySelector<HTMLElement>('[data-phase-reading]')!.textContent=reading;
}

function decoderSample(details:HTMLElement){
  details.innerHTML=`
    <article class="detail-card worked-example">
      <header><h2>把一个读数还原为物理量</h2><small data-stats-source>读取 C04 统计</small></header>
      <label class="example-select">通道 <select aria-label="逆归一化示例通道">${physicalChannels.map(ch=>`<option value="${ch}">${ch} · ${names[ch]}</option>`).join('')}</select></label>
      <label class="example-slider">归一化示例值 <input id="decoder-value" type="range" min="-2" max="2" step="0.1" value="0.5"><output for="decoder-value">0.50</output></label>
      <div class="example-equation" data-decoded-value>正在读取该帧的均值与尺度…</div>
      <p>均值与尺度取自该帧的有效流体格点。滑块给出一个假设的解码器读数；三个速度分量共用速度尺度，压力使用独立尺度。</p>
    </article>
    <article class="detail-card worked-example">
      <header><h2>一个速度分量怎样从矢量势得到？</h2><small>相容 Curl</small></header>
      <div class="example-equation">ũ = Dᵧ A*<sub>z</sub> − D<sub>z</sub> A*<sub>y</sub></div>
      <p>在差分模板有效的格点，取 A* 的展向分量沿横流方向的变化，再减去横流分量沿展向的变化，得到流向速度脉动。压力走单独的读出分支。</p>
      <p>${architectureLink}</p>
    </article>`;
  const equation=details.querySelector<HTMLElement>('[data-decoded-value]')!;
  const source=details.querySelector<HTMLElement>('[data-stats-source]')!;
  const channel=details.querySelector<HTMLSelectElement>('select')!;
  const slider=details.querySelector<HTMLInputElement>('input')!;
  const value=details.querySelector<HTMLOutputElement>('output')!;
  void loadWakeManifest().then(m=>{
    if(!source.isConnected)return;
    const frame=m.frames[m.modelReferenceFrame];
    source.textContent=`真实 C04 统计 · ${frame.time_s.toFixed(2)} s`;
    function update(){
      const ch=physicalChannels[channel.selectedIndex];
      const mean=frame.stats6[channel.selectedIndex], scale=frame.stats6[ch==='p'?5:4];
      const sample=slider.valueAsNumber;
      value.value=sample.toFixed(2);
      equation.textContent=`${ch} = ${mean.toFixed(4)} + ${scale.toFixed(4)} × (${sample.toFixed(2)}) ≈ ${(mean+scale*sample).toFixed(4)} ${m.units[ch]}`;
    }
    slider.addEventListener('input',update);channel.addEventListener('change',update);update();
  }).catch(()=>{source.textContent='该帧统计未载入';equation.textContent='请检查离线包中的 C04 数据清单。';});
}

export function showRolloutStep(details:HTMLElement,base:number,k:number){
  const grid=details.querySelector<HTMLElement>('[data-fifo-example]');
  if(!grid)return;
  const target=base+Math.max(1,k);
  function row(start:number,after:boolean){
    return Array.from({length:4},(_,i)=>{
      const step=start+i;
      const action=i===0&&!after?'移出':i===3&&after?'写入':step>base?'预测':'历史';
      return `<span class="window-cell ${action==='移出'?'out':action==='写入'?'in':''}"><b>${step}</b><small>${action}</small></span>`;
    }).join('');
  }
  grid.innerHTML=`<span>回填前</span>${row(target-4,false)}<span>回填后</span>${row(target-3,true)}`;
  details.querySelector<HTMLElement>('[data-fifo-target]')!.textContent=`生成 step ${target}`;
}

export function renderWorkedExample(index:number,details:HTMLElement,panel:HTMLElement){
  if(index===3){decoderSample(details);return true;}
  if(index===5){trainingSample(details,panel);return true;}
  if(index!==6)return false;
  details.innerHTML=`
    <article class="detail-card worked-example">
      <header><h2>四帧历史怎样向前移动？</h2><small data-fifo-target></small></header>
      <div class="example-window" data-fifo-example></div>
      <p>每格保存一对潜状态和六维统计，格内数字是求解器步号。${panel.querySelector('[data-range=k]')?'调节「滚动步 k」可查看每一次回填。':'图中展示从初始历史窗口生成下一物理步的过程。'}</p>
    </article>
    <article class="detail-card worked-example">
      <header><h2>滚动十步，对应多少物理时间？</h2><small>C04 归档时标</small></header>
      <div class="example-equation" data-rollout-clock>读取起止时标…</div>
      <p>H = 10 会生成十个相继的物理步。每个物理步内部都让 τ 从 0 积分到 1，再把结果写回四帧窗口。</p>
      <p><a href="#fm">回看一个物理步内的 FM 积分 ←</a></p>
    </article>`;
  const time=details.querySelector<HTMLElement>('[data-rollout-clock]')!;
  void loadWakeManifest().then(m=>{
    if(!time.isConnected)return;
    const base=m.frames[m.modelReferenceFrame];
    const target=m.frames.find(frame=>frame.step===base.step+10);
    time.textContent=target?`step ${base.step} → ${target.step}　·　${base.time_s.toFixed(2)} → ${target.time_s.toFixed(2)} s`:'目标步无独立归档。';
    showRolloutStep(details,base.step,Number(panel.querySelector<HTMLInputElement>('[data-range=k]')?.value??0));
  }).catch(()=>{time.textContent='C04 归档时标未载入。';});
  return true;
}
