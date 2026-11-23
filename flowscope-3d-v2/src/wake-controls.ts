import {createWake, loadDisplaySlice, loadMidplanePreview} from './wake';
import {compactSeconds,guideEndHold,indexAtTime} from './wake-timing';
import type {WakePose} from './film-guide';
import {mountWakeTransport} from './wake-presentation';
import {names, physicalChannels, palette, type Channel} from './chapters';

export type Wake = Awaited<ReturnType<typeof createWake>>;
type View = 'structure' | 'volume' | 'slice';
type Probe = {xyz_m:number[], rows:({time_s:number,step:number}&Record<Channel,number>)[]};
let probeFile:Promise<Probe> | undefined;

function createProbePlot(container:HTMLElement,probe:Probe,variable:Channel) {
  const rows=probe.rows;
  const data=rows.map(r=>r[variable]);
  const min=Math.min(...data), max=Math.max(...data);
  const x=(t:number)=>3+394*(t-rows[0].time_s)/(rows.at(-1)!.time_s-rows[0].time_s);
  const y=(v:number)=>52-46*(v-min)/(max-min || 1);
  const path=rows.map((r,i)=>(i?'L':'M')+x(r.time_s).toFixed(2)+' '+y(r[variable]).toFixed(2)).join(' ');
  container.innerHTML='<svg class="probe-chart" preserveAspectRatio="none" viewBox="0 0 400 71" role="img" aria-label="真实测点随物理时间的变化"><path d="M3 5H397 M3 28H397 M3 52H397" stroke="#d2e3ee" stroke-width=".8"/><path d="'+path+' V53 H3 Z" fill="#0098dc" fill-opacity=".08"/><path d="'+path+'" stroke="#067fb5" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"/><g data-marker><path d="M0 2V53" stroke="#3b86b0" stroke-dasharray="3 3"/><circle cx="0" r="3" fill="#005589"/></g><g font-size="10" fill="#466579" font-family="Consolas"><text x="3" y="67">0 s</text><text x="397" y="67" text-anchor="end">60 s</text></g></svg>';
  const marker=container.querySelector<SVGGElement>('[data-marker]')!;
  const point=marker.querySelector('circle')!;
  const byStep=new Map(rows.map(row=>[row.step,row]));
  return {variable,select(step:number){
    const row=byStep.get(step);
    marker.style.display=row?'':'none';
    if(!row)return '—';
    marker.setAttribute('transform','translate('+x(row.time_s).toFixed(2)+' 0)');
    point.setAttribute('cy',y(row[variable]).toFixed(2));
    return row[variable].toPrecision(3);
  }};
}

const rgb=palette.map(hex=>[1,3,5].map(start=>parseInt(hex.slice(start,start+2),16)));
function paint(canvas:HTMLCanvasElement, field:Awaited<ReturnType<typeof loadDisplaySlice>>) {
  const {width,height,values,range}=field;
  if(canvas.width!==width)canvas.width=width;
  if(canvas.height!==height)canvas.height=height;
  const ctx=canvas.getContext('2d')!;
  const out=ctx.createImageData(width,height);
  for(let row=0;row<height;row++){
    for(let col=0;col<width;col++){
      const val=values[row*width+col];
      const to=((height-row-1)*width+col)*4;
      if(Number.isFinite(val)){
        const q=Math.min(1,Math.max(0,(val-range[0])/(range[1]-range[0])))*(rgb.length-1);
        const idx=Math.min(rgb.length-2,Math.floor(q));
        for(let k=0;k<3;k++)out.data[to+k]=rgb[idx][k]+(q-idx)*(rgb[idx+1][k]-rgb[idx][k]);
      }else out.data.set([65,78,75],to);
      out.data[to+3]=255;
    }
  }
  ctx.putImageData(out,0,0);
}

export function wakeControls(wake:Wake, panel:HTMLElement, details:HTMLElement, changed:()=>void, pause:()=>void, guideSeconds:number, warmStart:()=>Promise<void>) {
  const manifest=wake.manifest;
  let frame=0, presentedFrame:number|undefined, drawnFrame:number|undefined;
  let view:View='structure', variable:Channel='v', slice=32, lod=2, readoutDirty=false;
  let running=false, serial=0, active=true, lastStrip='', stripBusy=false, localPlay=true;
  let guidePlaying=false, flowEnabled=false, qualityLevel=0, overlayTimer=0, controlState='';
  let pendingGuideFrame:number|undefined;
  wake.setQuality(0);
  const effectiveLod=()=>qualityLevel===2 ? Math.max(lod,4) : qualityLevel===1 ? Math.max(lod,2) : lod;
  const stripKey=()=>frame+'-'+slice+'-'+(slice===32?'archive':effectiveLod());
  const frames=manifest.frames;
  const startTime=frames[0].time_s, lastFrame=frames.length-1, endTime=frames[lastFrame].time_s;
  const transport=mountWakeTransport();
  const dense=transport.setFrames(frames);
  let focusEnd:number|undefined;
  // Fractional archive index. The compact clock gives each pair equal screen time.
  let playhead=0, speed='compact', clockStamp:number|undefined, pausedPlayhead:number|undefined;
  let shownPhase=0;
  let preparing=false, readyToRun=false;
  function physicalAt(position:number){
    const left=Math.min(lastFrame,Math.floor(position));
    if(left===lastFrame)return endTime;
    return frames[left].time_s+(position-left)*(frames[left+1].time_s-frames[left].time_s);
  }
  function applyPhase(phase:number){
    if(view!=='structure'||drawnFrame!==frame)return;
    const t=Math.min(1,Math.max(0,phase));
    if(wake.blend(frame,t)){shownPhase=t;changed();}
  }
  function nearestFrame(t:number){
    const prev=indexAtTime(frames,t);
    return prev<lastFrame && frames[prev+1].time_s-t<t-frames[prev].time_s ? prev+1 : prev;
  }
  const stop=new AbortController();
  const byId=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const listen=(id:string,event:string,fn:()=>void)=>byId(id).addEventListener(event,fn,{signal:stop.signal});
  panel.innerHTML=`
    <p class="note wake-guide-note" id="wake-guide-clock" hidden>导览覆盖全部 ${frames.length} 个归档时刻，结束前到达 ${endTime.toFixed(0)} s。</p>
    <div class="control-block"><div class="control-label">空间表示</div><div class="segments" id="view-group"><button type="button" data-view="structure">涡结构</button><button type="button" data-view="volume">体渲染</button><button type="button" data-view="slice">截面</button></div></div>
    <div class="control-block"><div class="control-label"><span>物理量</span><output id="physical-unit"></output></div><div class="data-keys" id="physical-keys"></div></div>
    <div class="control-block" id="slice-block"><label class="control-label" for="slice-position">展向截面 <output id="slice-index"></output></label><input id="slice-position" type="range" min="0" max="63" value="32"></div>
    <div class="control-block" id="lod-block"><label class="control-label" for="lod">采样精度<select id="lod"><option value="2">标准 LOD 2</option><option value="1">最高可用精度</option><option value="4">轻量 LOD 4</option></select></label></div>
    <div class="control-block"><label class="switch-row" id="section-row"><input id="axial-sections" type="checkbox" checked>等距截线 · 每 0.30 m</label><label class="switch-row"><input id="streamlines" type="checkbox">瞬时流线与示踪点</label><p id="stream-note" class="note" hidden>流线取自当前帧三分量速度，标记沿该瞬时流线移动。</p></div>
    <div class="readings"><div class="reading"><small>雷诺数 Re</small><b>126,167</b></div><div class="reading"><small>圆柱直径 D</small><b>0.30 m</b></div><div class="reading"><small>原始网格 Z × Y × X</small><b>64×96×192</b></div><div class="reading"><small>归档时间步</small><b id="source-step"></b></div></div>
    <p class="note" id="representation"></p>`;
  details.innerHTML=`<article class="detail-card"><header><h2>四通道切片</h2><small id="slice-caption"></small></header><div class="channel-strip" id="field-strip"></div></article>
  <article class="detail-card"><header><h2>尾流测点时序</h2><small id="probe-label"></small></header><div id="probe-plot"></div><small id="probe-pos"></small><div class="wake-probe-moments" id="probe-moments"></div></article>`;
  byId('physical-keys').innerHTML=physicalChannels.map(ch=>`<button type="button" data-ch="${ch}" aria-label="${names[ch]} ${ch}">${ch}</button>`).join('');
  byId('field-strip').innerHTML=physicalChannels.map(ch=>`<button type="button" data-ch="${ch}" aria-label="在主视窗查看 ${names[ch]} 截面"><canvas data-thumb="${ch}"></canvas><span>${ch} · ${names[ch]}</span></button>`).join('');
  const time=byId<HTMLInputElement>('physical-time');
  time.min=String(manifest.frames[0].time_s);
  time.max=String(manifest.frames.at(-1)!.time_s);
  time.step='0.06';
  const legend=byId('legend');
  const loading=byId('loading');
  const tag=byId('source-tag');
  const guideNote=byId('wake-guide-clock');
  delete byId('stage-tag').dataset.step;
  function showGuideNote(enabled:boolean){
    if(guidePlaying===enabled)return;
    guidePlaying=enabled;guideNote.hidden=!enabled;
  }
  const shown=()=>frames[presentedFrame??0];
  const tickId=()=>manifest.frames[frame];
  let probe:Probe|undefined,plot:ReturnType<typeof createProbePlot>|undefined;
  function drawProbe(){
    if(!probe || !active)return;
    if(plot?.variable!==variable)plot=createProbePlot(byId('probe-plot'),probe,variable);
    byId('probe-label').textContent=variable+' = '+plot.select(shown().step)+' '+manifest.units[variable];
  }
  probeFile??=fetch('./assets/probe.json').then(r=>{if(!r.ok)throw Error('probe');return r.json();});
  probeFile.then(v=>{
    if(!active)return;
    probe=v;
    byId('probe-pos').textContent='(x, y 横流, z 展向) = ('+v.xyz_m.map(n=>n.toFixed(2)).join(', ')+') m';
    const locate=document.createElement('button');
    locate.type='button';
    locate.textContent='定位测点';
    function showProbe(visible:boolean){
      locate.setAttribute('aria-pressed',String(visible));
      wake.setProbe(visible?v.xyz_m:undefined);
    }
    locate.setAttribute('aria-pressed','false');
    locate.addEventListener('click',()=>showProbe(locate.getAttribute('aria-pressed')!=='true'),{signal:stop.signal});
    byId('probe-moments').append(locate);
    if(dense){
      const local=v.rows.filter(r=>r.time_s>=frames[dense.start].time_s&&r.time_s<=frames[dense.end].time_s);
      if(local.length){
        const low=local.reduce((a,b)=>a.v<b.v?a:b);
        const high=local.reduce((a,b)=>a.v>b.v?a:b);
        for(const [label,row] of [['最大',high],['最小',low]] as const){
          const button=document.createElement('button');
          button.type='button';
          button.textContent='密采段 v '+label+' · '+row.time_s.toFixed(2)+' s';
          button.title='回看该归档涡面，测点横向速度 '+row.v.toFixed(3)+' '+manifest.units.v;
          button.addEventListener('click',()=>{
            showProbe(true);variable='v';view='structure';selectArchive(nearestFrame(row.time_s));
          },{signal:stop.signal});
          byId('probe-moments').append(button);
        }
      }
    }
    drawProbe();
  }).catch(()=>{if(active)byId('probe-plot').textContent='测点时序未载入';});

  function updateReadout(){
    const source=shown();
    byId('physical-clock').textContent=source.time_s.toFixed(2)+' s';
    byId('source-step').textContent=source.step+' / '+manifest.frames.at(-1)!.step;
    transport.markFrame(presentedFrame??0,lastFrame);
    drawProbe();
  }
  function updateSlider(value:number){
    time.value=String(value);
    time.setAttribute('aria-valuetext',value.toFixed(2)+' 秒');
  }
  function updatePlaybackButton(){
    const button=byId('cycle');
    if(button.getAttribute('aria-pressed')!==String(localPlay))button.setAttribute('aria-pressed',String(localPlay));
    const label=localPlay?'Ⅱ 暂停体场':frame===lastFrame?'↺ 从头播放':'▷ 播放体场';
    if(button.textContent!==label)button.textContent=label;
  }
  function updateUI(){
    const source=tickId();
    updateSlider(localPlay && drawnFrame!==undefined?frames[drawnFrame].time_s:source.time_s);
    byId('slice-index').textContent=String(slice)+' / 63';
    updatePlaybackButton();
    if((!lastStrip||(!localPlay&&!guidePlaying))&&lastStrip!==stripKey())byId('slice-caption').textContent='载入中 · t = '+source.time_s.toFixed(2)+' s';
    const state=view+'/'+variable+'/'+qualityLevel;
    if(state===controlState)return;
    controlState=state;
    byId('physical-unit').textContent=view==='structure'?'ω 展向 / s⁻¹':names[variable]+' / '+manifest.units[variable];
    byId('slice-block').hidden=view!=='slice';byId('lod-block').hidden=view==='structure';
    byId('section-row').hidden=view!=='structure';
    byId('stage-tag').textContent=view==='structure'?'C04　/　Q 等值面':view==='volume'?'C04　/　体渲染':'C04　/　物理截面';
    const range=manifest.display_ranges[view==='structure'?'omega':variable];
    legend.innerHTML='<b>'+(view==='structure'?'展向涡量 ω (s⁻¹)':variable+' ('+manifest.units[variable]+')')+'</b><i class="legend-gradient"></i><span><small>'+range[0]+'</small><small>'+range[1]+'</small></span>';
    legend.querySelector<HTMLElement>('.legend-gradient')!.style.background='linear-gradient(90deg,'+palette.join(',')+')';
    const note=view==='structure'?'Q = 0.85 s⁻² 涡面按展向涡量着色。细线标出沿 X 每隔一个圆柱直径的截面。档间形态为显示插值，时间轴刻线对应真实采样。':view==='volume'?'光线沿三维纹理进行体采样。速度与压力分别使用跨帧固定色标。':'截面穿过三维标量纹理。蓝色圆柱表示固体区域。';
    byId('representation').textContent=note+(qualityLevel===2?' 已自动启用轻量采样。':qualityLevel===1?' 已启用自适应采样。':'');
    byId('view-group').querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
    document.querySelectorAll<HTMLButtonElement>('[data-ch]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.ch===variable&&view!=='structure')));
  }
  async function showStrip(){
    const key=stripKey();
    if(stripBusy||key===lastStrip)return;
    stripBusy=true;
    const current=frame, requestedSlice=slice;
    const valid=()=>active && stripKey()===key;
    const canvas=(ch:Channel)=>details.querySelector<HTMLCanvasElement>('[data-thumb="'+ch+'"]')!;
    try{
      let zIndex=requestedSlice, detail='';
      if(requestedSlice===32){
        const strip=await loadMidplanePreview(manifest.frames[current]);
        try{
          if(!valid())return;
          const width=strip.width/4, height=strip.height;
          physicalChannels.forEach((ch,i)=>{
            const target=canvas(ch);
            if(target.width!==width)target.width=width;
            if(target.height!==height)target.height=height;
            target.getContext('2d')!.drawImage(strip,i*width,0,width,height,0,0,width,height);
          });
        }finally{strip.close();}
      }else{
        const fields=await Promise.all(physicalChannels.map(ch=>loadDisplaySlice(current,ch,requestedSlice,effectiveLod())));
        if(!valid())return;
        physicalChannels.forEach((ch,i)=>paint(canvas(ch),fields[i]));
        zIndex=fields[0].zIndex;
        if(fields[0].interpolated)detail=' · 展向插值';
        else if(zIndex!==requestedSlice)detail=' · 边界采样';
      }
      byId('slice-caption').textContent='Z '+zIndex+' · '+tickId().time_s.toFixed(2)+' s'+detail;
      lastStrip=key;
    }catch{if(valid())byId('slice-caption').textContent='切片读取失败';}
    finally{stripBusy=false;if(active && stripKey()!==key && !running)void showStrip();}
  }
  async function pump(){
    if(running || !active)return;
    running=true;
    try{
      while(active){
        const requested=serial;
        try{
          await wake.update(frame,variable,view,slice,effectiveLod(),()=>{
            if(!active || requested!==serial)return;
            presentedFrame=frame;
            shownPhase=0;
            readoutDirty=true;
          });
          if(!active)return;
          if(requested!==serial)continue;
          loading.hidden=true;
          if(tag.textContent!=='真实 CFD')tag.textContent='真实 CFD';
          // Keep 3D uploads ahead of the secondary preview strip during playback.
          if(!localPlay&&!guidePlaying || view==='slice' || frame%4===0 || frame===lastFrame || frame===focusEnd)void showStrip();
          if((localPlay||guidePlaying) && frame<lastFrame)wake.prefetch(frame+1,variable,view,effectiveLod());
          changed();
        }catch(error){
          if(!active || requested!==serial)continue;
          loading.hidden=false;
          loading.textContent='数据读取失败 · '+(error instanceof Error?error.message:String(error));
          tag.textContent='数据不可用';
          if(localPlay){
            localPlay=false;clockStamp=undefined;
            frame=presentedFrame??0;playhead=frame;
            updateUI();
          }
        }
        if(requested===serial)break;
      }
    }finally{
      running=false;clearTimeout(overlayTimer);
      const next=pendingGuideFrame;pendingGuideFrame=undefined;
      if(active && next!==undefined && next!==frame){frame=next;request();}
    }
  }
  function request(){
    wake.cancelUpdate();
    serial++;updateUI();
    clearTimeout(overlayTimer);
    if(!localPlay && !guidePlaying){
      overlayTimer=window.setTimeout(()=>{if(active&&running){loading.hidden=false;loading.textContent='载入 C04 · '+tickId().time_s.toFixed(2)+' s';}},160);
    }
    void pump();
  }
  function manual(){
    applyPhase(0);
    pause();localPlay=false;clockStamp=undefined;pausedPlayhead=undefined;pendingGuideFrame=undefined;focusEnd=undefined;showGuideNote(false);
  }
  function selectArchive(next:number){
    manual();
    playhead=frame=Math.max(0,Math.min(lastFrame,next));
    request();
    changed();
  }
  listen('wake-prev','click',()=>selectArchive(frame-1));
  listen('wake-next','click',()=>selectArchive(frame+1));
  function playSequence(start:number,rate:string,end?:number){
    manual();
    view='structure';variable='v';speed=rate;
    byId<HTMLSelectElement>('wake-rate').value=speed;
    playhead=frame=start;
    if(start===0)readyToRun=false;
    focusEnd=end;localPlay=true;
    request();changed();
  }
  listen('wake-whole','click',()=>playSequence(0,'compact'));
  listen('wake-focus','click',()=>{if(dense)playSequence(dense.start,'0.5',dense.end);});
  byId('view-group').querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.addEventListener('click',()=>{manual();view=b.dataset.view as View;request();},{signal:stop.signal}));
  document.querySelectorAll<HTMLButtonElement>('[data-ch]').forEach(b=>b.addEventListener('click',()=>{manual();variable=b.dataset.ch as Channel;if(b.closest('#field-strip'))view='slice';else if(view==='structure')view='volume';request();},{signal:stop.signal}));
  listen('physical-time','input',()=>{
    selectArchive(nearestFrame(Number(time.value)));
  });
  time.addEventListener('wake-atlas-frame',event=>{
    const target=frames.findIndex(f=>f.step===(event as CustomEvent<number>).detail);
    if(target<0)return;
    event.preventDefault();
    view='slice';variable='v';slice=32;
    byId<HTMLInputElement>('slice-position').value=String(slice);
    selectArchive(target);
  },{signal:stop.signal});
  time.addEventListener('keydown',event=>{
    const move=event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:0;
    if(!move)return;
    event.preventDefault();selectArchive(frame+move);
  },{signal:stop.signal});
  listen('slice-position','input',()=>{manual();slice=Number(byId<HTMLInputElement>('slice-position').value);request();});
  listen('lod','change',()=>{manual();lod=Number(byId<HTMLSelectElement>('lod').value);request();});
  listen('cycle','click',()=>{
    pause();pendingGuideFrame=undefined;showGuideNote(false);
    if(localPlay && clockStamp!==undefined)advanceClock(performance.now());
    localPlay=!localPlay;
    clockStamp=undefined;
    if(localPlay){
      if(frame===0)readyToRun=false;
      if(frame===lastFrame || presentedFrame===undefined){
        pausedPlayhead=undefined;readyToRun=false;frame=0;request();
      }
      playhead=pausedPlayhead??frame;pausedPlayhead=undefined;
      if(frame<lastFrame)wake.prefetch(frame+1,variable,view,effectiveLod());
    }else{
      // A pause freezes the visible sample even if the next read is in flight.
      if(drawnFrame!==undefined && frame!==drawnFrame){frame=drawnFrame;request();}
      pausedPlayhead=Math.max(frame,Math.min(playhead,Math.min(frame+1,lastFrame)));
      applyPhase(0);
      void showStrip();
    }
    updateUI();changed();
  });
  function advanceClock(now:number){
    if(clockStamp!==undefined){
      const dt=Math.max(0,now-clockStamp)/1000;
      if(speed==='compact')playhead=Math.min(lastFrame,playhead+dt*lastFrame/compactSeconds);
      else{
        const t=Math.min(endTime,physicalAt(playhead)+dt*Number(speed));
        const left=indexAtTime(frames,t);
        playhead=left===lastFrame?lastFrame:left+Math.max(0,(t-frames[left].time_s)/(frames[left+1].time_s-frames[left].time_s));
      }
    }
    clockStamp=now;
  }
  listen('wake-rate','change',()=>{
    if(localPlay && clockStamp!==undefined)advanceClock(performance.now());
    focusEnd=undefined;
    speed=byId<HTMLSelectElement>('wake-rate').value;
  });
  document.addEventListener('visibilitychange',()=>{clockStamp=undefined;},{signal:stop.signal});
  wake.setSections(true);
  listen('axial-sections','change',()=>wake.setSections(byId<HTMLInputElement>('axial-sections').checked));
  listen('streamlines','change',()=>{
    const input=byId<HTMLInputElement>('streamlines');
    flowEnabled=input.checked;changed();
    byId('stream-note').hidden=!input.checked;
    void wake.setStreamlines(input.checked).then(changed).catch(()=>{
      if(active){flowEnabled=false;input.checked=false;byId('stream-note').textContent='当前帧的速度分量读取失败。';}
    });
  });
  updateReadout();request();
  return {
    guided(_progress:number,chapterElapsedSeconds:number,pose?:WakePose){
      pausedPlayhead=undefined;
      focusEnd=undefined;
      if(localPlay){localPlay=false;clockStamp=undefined;updatePlaybackButton();}
      showGuideNote(true);
      const picked=pose?.landmark===undefined?-1:frames.findIndex(f=>f.step===pose.landmark);
      const targetView=picked>=0?'slice':'structure';
      const layoutChanged=view!==targetView||variable!=='v'||slice!==32;
      view=targetView;variable='v';slice=32;
      if(layoutChanged)byId<HTMLInputElement>('slice-position').value='32';
      const position=picked>=0?picked:lastFrame*(pose?.fraction??Math.min(1,Math.max(0,chapterElapsedSeconds)/Math.max(.1,guideSeconds-guideEndHold)));
      const next=Math.floor(position);
      if(layoutChanged){pendingGuideFrame=undefined;frame=next;request();}
      else if(running)pendingGuideFrame=next;
      else if(frame!==next){frame=next;request();}
      else applyPhase(position-next);
    },
    idle(now:number){
      showGuideNote(false);
      if(!localPlay || drawnFrame===undefined || (frame===0&&view==='structure'&&!readyToRun))return;
      // A replay or a seek resumes its clock only once its start frame is drawn.
      if(clockStamp===undefined && drawnFrame!==frame)return;
      advanceClock(now);
      if(!running && drawnFrame===frame && frame<lastFrame && playhead>=frame+1){
        frame++;request();
      }else if(frame<lastFrame)applyPhase(playhead-frame);
    },
    drawn(now:number){
      if(presentedFrame===undefined || frame!==presentedFrame)return;
      const firstDraw=drawnFrame!==presentedFrame;
      drawnFrame=presentedFrame;
      if(readoutDirty){
        readoutDirty=false;
        byId('stage-tag').dataset.step=String(shown().step);
        updateSlider(shown().time_s);
        updateReadout();
      }
      const timeText=(shownPhase>0?'≈ '+physicalAt(frame+shownPhase).toFixed(2):shown().time_s.toFixed(2))+' s / '+endTime+' s';
      if(byId('stage-time').textContent!==timeText)byId('stage-time').textContent=timeText;
      if(!localPlay)return;
      if(frame===0&&view==='structure'&&!readyToRun){
        if(!preparing){
          preparing=true;clockStamp=undefined;
          void warmStart().finally(()=>{
            if(!active)return;
            readyToRun=true;preparing=false;changed();
          });
        }
        return;
      }
      if(frame===(focusEnd??lastFrame)){
        localPlay=false;clockStamp=undefined;playhead=frame;focusEnd=undefined;updatePlaybackButton();
      }else if(firstDraw){
        // If a read or draw missed the next sample's deadline, give this sample
        // its own display interval. Never catch up by skipping recorded geometry.
        if(clockStamp===undefined || playhead>=frame+1)playhead=frame;
        clockStamp=now;
      }
    },
    animating(){return (localPlay&&!preparing) || flowEnabled;},
    tick(seconds:number){wake.tick(seconds);},
    quality(level=1){
      if(qualityLevel===level)return;
      qualityLevel=level;wake.setQuality(level);request();
    },
    dispose(){active=false;serial++;wake.hideFrame();clearTimeout(overlayTimer);stop.abort();transport.dispose();},
    get caption(){
      const t=shownPhase>0?'档间形态插值 · t ≈ '+physicalAt((presentedFrame??0)+shownPhase).toFixed(2):'t = '+shown().time_s.toFixed(2);
      return byId('stage-tag').textContent+' · '+t+' s';
    }
  };
}
