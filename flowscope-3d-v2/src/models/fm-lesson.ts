import {buttons,check,range,selectButton} from './shared';
import {ordinaryTrajectory,shortcutExample,steps,stepSize} from './fm-math';

const names=['D0','D1','D2'];
const rules=['1 − 0.5 × D0 + 0.25 × τ','1.7 × cos(2πτ) − 0.35 × D1','1.1 × sin(2πτ) − 0.25 × D2'];
const phases=['组成 Query','读取历史','求速度','Euler 更新'];
const phaseDescriptions=[
  '用当前潜状态和本步的 τ 组成 Query。每到一个新起点，重新计算一次。',
  '新的 Query 读取四帧 Clean 历史的同层 K/V。每步复用这份历史，注意力权重可改变。',
  '速度头给出潜特征对 τ 的变化率。细蓝箭头表示同一 τ 下各位置的速度方向，琥珀色箭头表示当前状态走完一步的实际增量。',
  '将速度乘以 Δτ，再加回起点。新落点和新的 τ 成为下一步 Query 的输入。',
];
const fixed=(v:number)=>v.toFixed(4);
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const stepDurationMs=2800;

export interface FmFrame {
  k:number;
  fraction:number;
  phase:number;
  atEnd:boolean;
}

export function mountFmLesson(
  controls:HTMLElement,surface:HTMLElement,changed:()=>void,
  draw:(frame:FmFrame)=>void,projection:string,
) {
  const {states,velocities}=ordinaryTrajectory();
  const short=shortcutExample();
  const viewport=surface.parentElement!;
  const events=new AbortController();
  const signal=events.signal;
  const get=<E extends HTMLElement=HTMLElement>(q:string)=>controls.querySelector<E>(q)!;
  const strip=document.createElement('section');
  strip.className='fm-score';
  strip.setAttribute('aria-label','当前积分步的四个环节');
  strip.innerHTML=`
    <div class="fm-score-heading"><h3>单步计算链</h3><span>同一物理步 t → t+1</span></div>
    <div class="fm-phase-track" role="group" aria-label="查看计算环节">
      ${phases.map((name,i)=>`<button type="button" data-fm-stage="${i}"><span>${name}</span><strong></strong></button>`).join('')}
    </div><div class="fm-evidence" data-fm-evidence></div><p data-fm-caption></p>`;
  viewport.after(strip);
  document.addEventListener('fullscreenchange',()=>{
    if(document.fullscreenElement===viewport)viewport.append(strip);
    else viewport.after(strip);
  },{signal});
  const stamp=document.createElement('div');
  stamp.className='fm-plot-caption';
  stamp.innerHTML=`<span>示意轨迹 · ${projection}</span><b data-fm-scene-title></b><small data-fm-scene-detail></small>`;
  viewport.append(stamp);
  viewport.classList.add('fm-view');
  controls.classList.add('fm-panel');
  controls.innerHTML=`
    <div class="fm-step-heading"><strong data-iter></strong><span data-call></span></div>
    <div class="fm-step-index" role="group" aria-label="选择积分步">
      ${Array.from({length:steps},(_,i)=>`<button data-fm-knot="${i}" type="button" aria-label="查看第 ${i+1} 步">${i+1}</button>`).join('')}
    </div>
    <div class="fm-lesson-transport">
      <button class="fm-run" type="button" data-fm-run aria-pressed="false">播放推演</button>
      <div class="fm-step-nav"><button type="button" data-fm-reset>回到起点</button><button type="button" data-integrate="0">上一步</button><button type="button" data-integrate="1">下一步</button></div>
    </div>
    ${range('生成进度 τ',0,100,0,'tau')}
    <div class="fm-controls-row"><span class="mc-caption">查看分量</span>${buttons(names,'fm-feature')}</div>
    <section class="fm-calc"><header><strong data-fm-title></strong><span>Δτ = 1/8</span></header>
      <dl><dt>当前状态 zₖ</dt><dd data-fm-value="current"></dd>
      <dt>本步速度 vₖ</dt><dd data-fm-value="velocity"></dd>
      <dt>增量 Δτ × vₖ</dt><dd data-fm-value="delta"></dd>
      <dt>下一状态 zₖ₊₁</dt><dd data-fm-value="next"></dd></dl>
      <div class="fm-equation" data-fm-equation></div><p class="fm-intermediate" data-fm-intermediate hidden></p></section>
    <p class="fm-states" data-fm-status></p>
    ${check('对照 Shortcut 教师与学生','shortcut',false)}
    <section class="fm-short" data-fm-shortcut hidden><strong>自蒸馏示例 · τ = 0，d = 0.25</strong>
      <dl><dt>教师第一半步速度</dt><dd data-fm-short="half1"></dd>
      <dt>教师第二半步速度</dt><dd data-fm-short="half2"></dd>
      <dt>教师目标 · 两速度均值</dt><dd data-fm-short="target"></dd>
      <dt>学生一步速度</dt><dd data-fm-short="student"></dd></dl>
      <p class="fm-source">教师先走 0.125，再从中点重算速度。两次速度的均值停止梯度，用来监督学生的大步速度。</p></section>
    <details class="mc-details"><summary>教学函数与物理条件</summary><p data-fm-rule></p>
      <p>图上只取一个 Token 的潜特征，数值无量纲。普通 FM 的步长条件 d = 0。模型的六维统计头单独读取 Clean 历史。</p></details>`;
  const slider=get<HTMLInputElement>('[data-range=tau]'),output=get('[data-out=tau]');
  slider.step='.5';
  const stepLabel=get('[data-iter]'),call=get('[data-call]'),title=get('[data-fm-title]');
  const rule=get('[data-fm-rule]'),status=get('[data-fm-status]'),eq=get('[data-fm-equation]'),mid=get('[data-fm-intermediate]');
  const back=get<HTMLButtonElement>('[data-integrate="0"]'),forward=get<HTMLButtonElement>('[data-integrate="1"]');
  const run=get<HTMLButtonElement>('[data-fm-run]'),reset=get<HTMLButtonElement>('[data-fm-reset]');
  const transport=get('.fm-lesson-transport'),indexRow=get('.fm-step-index');
  const smallScreen=window.matchMedia('(max-width: 700px)');
  function placeTransport() {
    if(smallScreen.matches)strip.querySelector('.fm-score-heading')!.after(transport);
    else indexRow.after(transport);
  }
  smallScreen.addEventListener('change',placeTransport,{signal});
  placeTransport();
  const shortFlag=get<HTMLInputElement>('[data-flag=shortcut]'),shortPanel=get('[data-fm-shortcut]');
  const values=['current','velocity','delta','next'].map(key=>get('[data-fm-value="'+key+'"]'));
  const shortValues=['half1','half2','target','student'].map(key=>get('[data-fm-short="'+key+'"]'));
  const sceneTitle=stamp.querySelector<HTMLElement>('[data-fm-scene-title]')!;
  const sceneDetail=stamp.querySelector<HTMLElement>('[data-fm-scene-detail]')!;
  const caption=strip.querySelector<HTMLElement>('[data-fm-caption]')!;
  const evidence=strip.querySelector<HTMLElement>('[data-fm-evidence]')!;
  const stageButtons=[...strip.querySelectorAll<HTMLButtonElement>('[data-fm-stage]')];
  const indices=[...controls.querySelectorAll<HTMLButtonElement>('[data-fm-knot]')];
  const phaseReadouts=stageButtons.map(b=>b.querySelector('strong')!);
  let tau=0,feature=0,phase=0,k=0,playhead=0;
  let frame=0,active=false,lastStamp:number|undefined;
  let previousBody='',previousClock='';
  let drawnTau=-1,drawnPhase=-1;

  function refresh() {
    const atEnd=tau===1;
    const fraction=tau*steps-k;
    const clockKey=Math.round(tau*200)/2;
    const bodyKey=[k,phase,feature,atEnd].join('/');
    if(String(clockKey)!==previousClock||bodyKey!==previousBody) {
      slider.value=String(clockKey);
      output.textContent=(clockKey/100).toFixed(Number.isInteger(clockKey)?2:3);
      const offset=clockKey/100-k*stepSize;
      mid.hidden=offset<=0||offset>=stepSize;
      if(!mid.hidden) mid.textContent='步内位置 · '+names[feature]+' ≈ '+fixed(states[k][feature]+offset*velocities[k][feature]);
      previousClock=String(clockKey);
    }
    if(bodyKey!==previousBody) {
      const current=states[k][feature],v=velocities[k][feature],delta=stepSize*v,next=states[k+1][feature];
      const component=names[feature];
      stepLabel.textContent=atEnd?'8 步完成':'Euler 第 '+(k+1)+' / '+steps+' 步';
      call.textContent='τ '+(k*stepSize).toFixed(3)+' → '+((k+1)*stepSize).toFixed(3);
      title.textContent=component+' · 单步计算';
      [current,v,delta,next].forEach((value,i)=>values[i].textContent=fixed(value));
      const exact=Math.abs(Number(fixed(current))+stepSize*Number(fixed(v))-Number(fixed(next)))<1e-9;
      eq.textContent=fixed(current)+(delta<0?' − ':' + ')+'0.125 × '+fixed(Math.abs(v))+(exact?' = ':' ≈ ')+fixed(next);
      rule.textContent='示意速度 '+component+' = '+rules[feature]+'。Shortcut 示例另加 d × '+[.16,-.12,.10][feature]+'。';
      [short.half1,short.half2,short.target,short.student].forEach((z,i)=>shortValues[i].textContent=fixed(z[feature]));
      selectButton(controls,'fm-feature',feature);
      indices.forEach((b,i)=>{
        b.setAttribute('aria-pressed',String(i===k));
        b.classList.toggle('is-complete',i<k||atEnd);
      });
      stageButtons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===phase)));
      const inline=['zₖ = '+fixed(current),'K/V · 4 帧','vₖ = '+fixed(v),'zₖ₊₁ = '+fixed(next)];
      inline.forEach((value,i)=>phaseReadouts[i].textContent=value);
      const query='Query<sub>'+(k+1)+'</sub>';
      const evidenceRows=[
        '<span>'+component+' = '+fixed(current)+'</span><span>τₖ = '+(k*stepSize).toFixed(3)+'</span><span>d = 0</span><i>→</i><b>'+query+'</b>',
        ['t−3','t−2','t−1','t'].map(t=>'<span>'+t+' <small>K/V</small></span>').join('')+'<i>→</i><b>'+query+'</b>',
        '<span>'+query+'</span><i>→</i><span>单速度头</span><i>→</i><b>vₖ['+component+'] = '+fixed(v)+'</b>',
        '<span>'+fixed(current)+'</span><i>'+(delta<0?'−':'+')+'</i><span>0.125 × '+fixed(Math.abs(v))+'</span><i>'+(exact?'=':'≈')+'</i><b>'+fixed(next)+'</b>',
      ];
      evidence.innerHTML=evidenceRows[phase];
      strip.dataset.phase=String(phase);
      sceneTitle.textContent=atEnd?'积分到达终点':phases[phase];
      sceneDetail.textContent=(atEnd?'τ = 1.000':'第 '+(k+1)+' / 8 步')+'　·　'+component+'　'+(atEnd?fixed(next):inline[phase]);
      caption.textContent=atEnd&&phase===3?'第八步写回完成。最终潜状态 ẑₜ₊₁ 与历史分支输出的六维统计 b̂ₜ₊₁ 一同进入解码器。':phaseDescriptions[phase];
      status.textContent=atEnd?'τ = 1 · 此物理步积分完成。':'预测条件固定 · 历史 t−3、t−2、t−1、t → 目标 t+1';
      controls.dispatchEvent(new CustomEvent('fm-step',{bubbles:true,detail:{phase,step:k,tau,feature}}));
      previousBody=bodyKey;
    }
    back.disabled=tau===0;
    reset.disabled=tau===0&&phase===0&&!active;
    forward.disabled=atEnd;
    if(drawnTau!==tau||drawnPhase!==phase) {
      draw({k,phase,fraction,atEnd});
      changed();
      drawnTau=tau;drawnPhase=phase;
    }
  }
  function localInteraction() {
    surface.dispatchEvent(new CustomEvent('fm-explore',{bubbles:true}));
  }
  function stop() {
    if(frame)cancelAnimationFrame(frame);
    frame=0;active=false;lastStamp=undefined;
    run.setAttribute('aria-pressed','false');
    run.textContent=tau===1?'重播推演':'播放推演';
  }
  function seek(t:number) {
    localInteraction();
    stop();
    tau=clamp(t);
    k=Math.min(steps-1,Math.floor(tau*steps));
    const fraction=tau*steps-k;
    phase=fraction>0?3:0;
    playhead=fraction===0?k:k+.75+.25*fraction;
    run.textContent=tau===1?'重播推演':'播放推演';
    refresh();
  }
  function showPhase(next:number) {
    if(!Number.isInteger(next)||next<0||next>3)return;
    localInteraction();stop();
    phase=next;
    // Inspecting a phase at the terminal node reopens the final Euler interval.
    tau=k*stepSize;
    playhead=k+next/4;
    run.textContent='播放推演';
    refresh();
  }
  function narrate(position:number) {
    playhead=Math.max(0,Math.min(steps,position));
    k=Math.min(steps-1,Math.floor(playhead));
    const part=playhead-k;
    phase=Math.min(3,Math.floor(part*4));
    tau=(k+Math.max(0,(part-.75)*4))*stepSize;
    refresh();
  }
  function tick(stamp:number) {
    frame=0;
    if(!active)return;
    if(lastStamp!==undefined)narrate(playhead+(stamp-lastStamp)/stepDurationMs);
    lastStamp=stamp;
    if(playhead>=steps){stop();return;}
    frame=requestAnimationFrame(tick);
  }
  run.addEventListener('click',()=>{
    localInteraction();
    if(active){stop();return;}
    if(tau===1)narrate(0);
    active=true;lastStamp=undefined;
    run.setAttribute('aria-pressed','true');run.textContent='暂停推演';
    frame=requestAnimationFrame(tick);
  },{signal});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden&&active)stop();
  },{signal});
  reset.addEventListener('click',()=>seek(0),{signal});
  slider.addEventListener('input',()=>seek(slider.valueAsNumber/100),{signal});
  back.addEventListener('click',()=>seek((Math.ceil(tau*steps)-1)/steps),{signal});
  forward.addEventListener('click',()=>seek((Math.floor(tau*steps)+1)/steps),{signal});
  indices.forEach((b,i)=>b.addEventListener('click',()=>seek(i*stepSize),{signal}));
  stageButtons.forEach((b,i)=>b.addEventListener('click',()=>showPhase(i),{signal}));
  controls.parentElement?.addEventListener('fm-select-phase',e=>showPhase((e as CustomEvent<number>).detail),{signal});
  controls.parentElement?.addEventListener('fm-guide-pose',event=>{
    const pose=(event as CustomEvent<FmFrame>).detail;
    if(active)stop();
    feature=0;k=pose.k;phase=pose.phase;tau=(k+pose.fraction)*stepSize;
    playhead=k+(phase===3?.75+.25*pose.fraction:phase/4);
    if(shortFlag.checked){shortFlag.checked=false;shortPanel.hidden=true;}
    refresh();
  },{signal});
  controls.querySelectorAll<HTMLElement>('[data-fm-feature]').forEach((b,i)=>b.addEventListener('click',()=>{
    localInteraction();feature=i;refresh();
  },{signal}));
  shortFlag.addEventListener('change',()=>{shortPanel.hidden=!shortFlag.checked;},{signal});
  refresh();
  return {
    seek,
    update(progress:number){
      if(active)stop();
      // Leave the completed eighth step on screen briefly before the chapter changes.
      narrate(clamp(progress/.95)*steps);
    },
    dispose(){stop();events.abort();strip.remove();stamp.remove();viewport.classList.remove('fm-view');}
  };
}
