import { loadTruthSlice, loadWakeManifest } from '../wake';
import { Stage, buttons, range, selectButton } from './shared';
import { createRolloutPlot, errorColors, fieldColors } from './rollout-plot';
import { drawRolloutProfile } from './rollout-profile';
import { loadSimulatedSlice } from './simulated-rollout';
import './rollout-style.css';

type Channel='u'|'v'|'w'|'p';
type Truth=Awaited<ReturnType<typeof loadTruthSlice>>;
type Meta=Awaited<ReturnType<typeof loadWakeManifest>>;
interface Forecast {
  schema:'flowscope.forecast-slice.v1';
  channel:Channel;
  unit:string;
  axis_order:'YX';
  step:number;
  time_s:number;
  start_step:number;
  z_index:number;
  shape_yx:[number,number];
  values:(number|null)[];
  truth_source_sha256:string;
  checkpoint_sha256:string;
}
const channels:Channel[]=['u','v','w','p'];
const horizons=[10,50,100];
function parseForecast(value:unknown):Forecast {
  if(!value||typeof value!=='object')throw Error('JSON 需要包含预测切片对象。');
  const f=value as Forecast;
  if(f.schema!=='flowscope.forecast-slice.v1')throw Error('schema 需为 flowscope.forecast-slice.v1。');
  if(!channels.includes(f.channel)||!Number.isInteger(f.step)||!Number.isInteger(f.start_step)||!Number.isFinite(f.time_s)||f.z_index!==32)throw Error('缺少有效通道、起始步、目标步、time_s 或 z_index=32。');
  if(f.axis_order!=='YX'||f.unit!==(f.channel==='p'?'Pa':'m/s'))throw Error('切片轴序应为 YX，单位应与通道的物理单位一致。');
  if(!Array.isArray(f.shape_yx)||f.shape_yx.length!==2||!f.shape_yx.every(n=>Number.isInteger(n)&&n>0&&n<=1024))throw Error('shape_yx 无效。');
  if(!Array.isArray(f.values)||f.values.length!==f.shape_yx[0]*f.shape_yx[1]||!f.values.every(v=>v===null||typeof v==='number'&&Number.isFinite(v)))throw Error('预测数组长度或数值无效。');
  if(!/^[0-9a-f]{64}$/i.test(f.truth_source_sha256)||!/^[0-9a-f]{64}$/i.test(f.checkpoint_sha256))throw Error('需要匹配真值的 SHA-256 和 checkpoint SHA-256。');
  return f;
}

export function rollout(s:Stage) {
  const surface=document.getElementById('canvas-shell')!;
  const panel=s.controls.parentElement!;
  let meta:Meta|undefined, channel:Channel='v', horizon=10,k=2,base=835,phase=0,row=48,mode=0;
  let clock=0, manualAt=NaN,request=0,loading=true;
  let filmView=false;
  let selectedSource:'simulated'|'imported'='simulated', forecastNote='';
  let truth:Truth|undefined, pred:Float32Array|undefined, errors:Float32Array|undefined, errorMax=0, rmse=0, count=0;
  const predictions=new Map<string,Forecast>(), cache=new Map<string,Truth>();
  let reading=false, desired:{index:number;channel:Channel;lod:number;serial:number;k:number;source:'simulated'|'imported';imported?:Forecast}|undefined;
  s.root.visible=false;
  s.render=()=>true;
  s.controls.classList.add('rollout-inspector');
  s.controls.innerHTML='<h3>滚动时域 H</h3>'+buttons(horizons.map(v=>'H = '+v),'horizon')+
    range('滚动步 k',0,10,k,'k')+
    '<div class="ro-step-controls"><button type="button" data-k-prev aria-label="前一个物理步">← 上一步</button><button type="button" data-k-next aria-label="后一个物理步">下一步 →</button></div>'+
    '<h3>预测来源</h3>'+buttons(['教学模拟','导入预测'],'forecast-source')+
    '<h3>同帧切片</h3>'+buttons(channels,'field')+buttons(['真值 / 预测','真值 / 绝对误差'],'compare')+
    '<div class="mc-reading"><b data-frame-label></b><span data-window></span><p data-ref></p><div class="mc-scale" data-physical-scale hidden></div><p data-metric></p><div class="mc-scale" data-error-scale hidden></div></div>'+
    '<p class="mc-note" data-provenance></p><a class="ro-volume-link" href="./data/simulated-rollout/step-0845-volume.npz" download>下载模拟三维场 · H = 10 · step 845（NPZ）</a>'+
    '<label class="mc-file">导入模型预测切片<input type="file" accept=".json,application/json" data-forecast></label>'+
    '<p class="mc-note" data-message role="status"></p>'+
    '<section class="ro-profile"><h3>沿 X 的共同剖线</h3>'+range('剖线 Y 网格索引',0,95,row,'profile-row')+
    '<div class="ro-traces"><span data-ref-key>真实 CFD</span><span data-pred-key hidden></span></div><canvas data-profile-plot role="img" aria-label="沿相同物理坐标 X 的真值与预测曲线"></canvas><p data-profile-readout></p></section>'+
    '<details class="mc-details"><summary>预测切片格式</summary><p>在项目目录运行 scripts/export_prediction.py，从已解码的预测 NPZ 和对应 checkpoint 导出 JSON。导出器核验坐标、物理单位、有效掩码及归档哈希。详见 docs/prediction.md。</p></details>';
  const plot=createRolloutPlot(surface,chooseRow,next=>{select(next,true);s.changed();});
  const profile=s.get<HTMLCanvasElement>('[data-profile-plot]'),readout=s.get('[data-profile-readout]');
  const profileSize=new ResizeObserver(()=>drawProfile());profileSize.observe(profile);
  const processListener=(event:Event)=>{
    const value=(event as CustomEvent<{index:number}>).detail?.index;
    if(!Number.isInteger(value)||value<0||value>3)return;
    setPhase(value);s.changed();
  };
  panel.addEventListener('flowscope-process-select',processListener);
  s.onDispose=()=>{plot.dispose();profileSize.disconnect();panel.removeEventListener('flowscope-process-select',processListener);};
  function setPhase(value:number){
    phase=value;s.controls.dataset.processStep=String(value);
    s.controls.dispatchEvent(new CustomEvent('flowscope-process-state',{bubbles:true,detail:{index:phase}}));
    paint();
  }
  function paint(){
    plot.update({base,k,horizon,phase,channel,meta,truth,prediction:pred,source:activeSource(),error:errors,errorMax,showError:mode===1&&!!errors,row,loading});
  }
  function activeSource(){return filmView?'imported':selectedSource;}
  function drawProfile(){drawRolloutProfile(profile,readout,truth,truth?.step===base+k?pred:undefined,row,meta,channel,truth?.step===base+k);}
  function chooseRow(value:number){
    const lod=truth?.lod??1,max=(meta?.grid_zyx[1]??96)-1;
    row=Math.min(Math.floor(max/lod)*lod,Math.max(0,Math.round(value/lod)*lod));
    const slider=s.get<HTMLInputElement>('[data-range=profile-row]');
    slider.max=String(Math.floor(max/lod)*lod);slider.step=String(lod);slider.value=String(row);
    s.get('[data-out=profile-row]').textContent=String(row);paint();drawProfile();
  }
  function compare(){
    errors=undefined;count=0;errorMax=0;rmse=0;
    const exact=truth?.step===base+k;
    if(pred&&truth&&exact){
      errors=new Float32Array(pred.length);
      let sum=0;
      for(let i=0;i<pred.length;i++){
        if(!Number.isFinite(truth.values[i])||!Number.isFinite(pred[i])){errors[i]=NaN;continue;}
        const d=pred[i]-truth.values[i];errors[i]=Math.abs(d);sum+=d*d;errorMax=Math.max(errorMax,Math.abs(d));count++;
      }
      if(count)rmse=Math.sqrt(sum/count);else errors=undefined;
    }
    const unit=meta?.units[channel]??'';
    const name=activeSource()==='imported'?'导入预测':k===0?'模拟初值':'模拟预测';
    s.controls.dataset.output=pred?(activeSource()==='imported'?'trained':'simulated'):'concept';
    const currentMode=errors?mode:0;
    selectButton(s.controls,'compare',currentMode);
    s.get<HTMLButtonElement>('[data-compare="1"]').disabled=!errors;
    s.controls.dataset.comparison=pred?(currentMode===1?'error':'prediction'):'pending';
    s.get('[data-ref-key]').textContent=exact?'真实 CFD':'前档参照';
    const key=s.get('[data-pred-key]');key.hidden=!pred||!exact;key.textContent=name;
    s.get('[data-provenance]').textContent=forecastNote;
    s.get('[data-metric]').textContent=errors?name+' · 切片 RMSE '+rmse.toPrecision(4)+' '+unit+' · LOD '+truth!.lod+' · 有效网格 n = '+count+(currentMode?' · 绝对误差范围 0 – '+Number(errorMax.toPrecision(4))+' '+unit:''):pred&&truth&&!exact?'该目标步缺少独立真值，剖线仅显示左侧参照。':'';
    const scale=s.get('[data-error-scale]');scale.hidden=!errors||currentMode!==1;scale.style.background='linear-gradient(90deg,'+errorColors.join(',')+')';
    s.controls.dispatchEvent(new CustomEvent('rollout-source',{bubbles:true,detail:{label:pred?name:loading?'预测载入中':filmView?'导览 · 等待导入预测':'预测未载入'}}));
    chooseRow(row);
  }
  function showTruth(sample:Truth){
    loading=false;truth=sample;
    const exact=sample.step===base+k;
    const unit=meta?.units[channel]??'';
    s.get('[data-ref]').textContent=(exact?'真值 ':'目标 step '+(base+k)+' 未归档。前一归档参照 ')+channel+' · step '+sample.step+' · '+sample.time_s.toFixed(2)+' s · Z['+sample.zIndex+'] = '+sample.z_m.toFixed(3)+' m · '+sample.width+' × '+sample.height+' · 色标 '+sample.range.map(v=>Number(v.toPrecision(3))).join(' … ')+' '+unit;
    const scale=s.get('[data-physical-scale]');scale.hidden=false;scale.style.background='linear-gradient(90deg,'+fieldColors.join(',')+')';
    compare();s.changed();
  }
  function remember(key:string,sample:Truth){cache.set(key,sample);if(cache.size>12)cache.delete(cache.keys().next().value!);}
  async function readLatest(){
    if(reading)return;reading=true;
    try{
      while(s.alive&&desired){
        const task=desired;desired=undefined;
        const key=task.index+':'+task.channel+':'+task.lod;
        try{
          const sample=cache.get(key)??await loadTruthSlice(task.index,task.channel,32,task.lod);
          if(!s.alive)break;
          remember(key,sample);if(task.serial!==request)continue;
          let values:Float32Array|undefined;
          let note=task.source==='simulated'?'模拟预测 · 固定 C04 第 835 步的三维速度，沿流线反向取样，外推速度与压力。':task.imported?'模型预测 · checkpoint '+task.imported.checkpoint_sha256.slice(0,12)+'…':'此步和通道尚未载入模型预测。可导入对应文件，或选择教学模拟。';
          try{
            if(task.source==='simulated')values=await loadSimulatedSlice(task.k,task.channel,sample.lod);
            else if(task.imported)values=Float32Array.from(task.imported.values,v=>v===null?NaN:v);
            if(values&&values.length!==sample.values.length)throw Error('预测切片与显示网格不匹配。');
          }catch(error){values=undefined;note='预测读取失败。'+String(error);}
          if(!s.alive||task.serial!==request)continue;
          pred=values;forecastNote=note;showTruth(sample);
        }catch(error){if(s.alive&&task.serial===request){loading=false;s.get('[data-ref]').textContent='切片读取失败。'+String(error);compare();s.changed();}}
      }
    }finally{reading=false;}
  }
  function fetchTruth(){
    desired=undefined;const serial=++request,step=base+k;
    let index=-1;
    meta?.frames.forEach((f,i)=>{if(f.step<=step)index=i;});
    const source=activeSource();
    selectButton(s.controls,'forecast-source',source==='simulated'?0:1);
    const imported=source==='imported'&&!filmView?predictions.get(step+':'+channel):undefined;
    const lod=imported?1:2;
    loading=true;truth=undefined;pred=undefined;forecastNote='';compare();s.get('[data-physical-scale]').hidden=true;
    s.get('[data-ref]').textContent='正在读取归档的中央 Z 切片…';
    if(index<0)return;
    desired={index,channel,lod,serial,k,imported,source};void readLatest();
  }
  function select(next:number,manual=false){
    if(manual)manualAt=clock;
    k=Math.max(0,Math.min(horizon,Math.round(next)));
    const slider=s.get<HTMLInputElement>('[data-range=k]');slider.max=String(horizon);slider.value=String(k);
    s.get('[data-out=k]').textContent=String(k);
    s.get('[data-frame-label]').textContent='第 '+k+' / '+horizon+' 步 · 目标 step '+(base+k);
    s.get('[data-window]').textContent='当前四帧窗 '+Array.from({length:4},(_,i)=>String(base+k-3+i)).join(' · ');
    s.get<HTMLButtonElement>('[data-k-prev]').disabled=k===0;s.get<HTMLButtonElement>('[data-k-next]').disabled=k===horizon;
    s.controls.dispatchEvent(new CustomEvent('rollout-step',{bubbles:true,detail:{base,k}}));
    selectButton(s.controls,'horizon',horizons.indexOf(horizon));selectButton(s.controls,'field',channels.indexOf(channel));selectButton(s.controls,'compare',mode);
    fetchTruth();
  }
  s.controls.querySelectorAll<HTMLElement>('[data-horizon]').forEach((b,i)=>s.on(b,'click',()=>{horizon=horizons[i];select(horizon,true);s.changed();}));
  s.controls.querySelectorAll<HTMLElement>('[data-field]').forEach((b,i)=>s.on(b,'click',()=>{channel=channels[i];select(k,true);s.changed();}));
  s.controls.querySelectorAll<HTMLButtonElement>('[data-forecast-source]').forEach((b,i)=>s.on(b,'click',()=>{selectedSource=i===0?'simulated':'imported';select(k,true);s.changed();}));
  s.controls.querySelectorAll<HTMLElement>('[data-compare]').forEach((b,i)=>s.on(b,'click',()=>{mode=i;selectButton(s.controls,'compare',i);compare();s.changed();}));
  s.on(s.get('[data-range=k]'),'input',()=>{select(Number(s.get<HTMLInputElement>('[data-range=k]').value),true);s.changed();});
  s.on(s.get('[data-range=profile-row]'),'input',()=>chooseRow(Number(s.get<HTMLInputElement>('[data-range=profile-row]').value)));
  s.on(s.get('[data-k-prev]'),'click',()=>{select(k-1,true);s.changed();});
  s.on(s.get('[data-k-next]'),'click',()=>{select(k+1,true);s.changed();});
  const upload=s.get<HTMLInputElement>('[data-forecast]');
  let uploadSerial=0;
  s.on(upload,'change',async()=>{
    const file=upload.files?.[0];if(!file)return;
    const serial=++uploadSerial;
    try{
      if(file.size>5_000_000)throw Error('单切片文件应小于 5 MB。');
      const parsed=parseForecast(JSON.parse(await file.text()));
      if(!s.alive||serial!==uploadSerial)return;
      const archiveIndex=meta?.frames.findIndex(f=>f.step===parsed.step)??-1;
      if(parsed.start_step!==base||parsed.step<base||parsed.step>base+100||archiveIndex<0)throw Error('预测起点或目标超出当前归档。');
      const ref=await loadTruthSlice(archiveIndex,parsed.channel,32);
      if(!s.alive||serial!==uploadSerial)return;
      if(ref.lod!==1)throw Error('此时刻仅归档预览 LOD，误差核验需要全分辨率真值。');
      if(parsed.truth_source_sha256.toLowerCase()!==ref.source_sha256.toLowerCase()||Math.abs(ref.time_s-parsed.time_s)>1e-6||
          parsed.shape_yx[0]!==ref.height||parsed.shape_yx[1]!==ref.width)throw Error('来源哈希、时标或网格与当前真值不一致。');
      if(parsed.values.some((v,i)=>v===null&&Number.isFinite(ref.values[i])))throw Error('预测在真值有效域内有缺失值。');
      remember(archiveIndex+':'+parsed.channel+':1',ref);
      if(predictions.size>=16&&!predictions.has(parsed.step+':'+parsed.channel))predictions.delete(predictions.keys().next().value!);
      predictions.set(parsed.step+':'+parsed.channel,parsed);
      selectedSource='imported';
      channel=parsed.channel;horizon=horizons.find(h=>h>=parsed.step-base)??100;
      s.get('[data-message]').textContent='已载入 '+file.name+' · checkpoint '+parsed.checkpoint_sha256.slice(0,12)+'…';
      select(parsed.step-base,true);s.changed();
    }catch(error){if(s.alive&&serial===uploadSerial)s.get('[data-message]').textContent=String(error);}
    if(serial===uploadSerial)upload.value='';
  });
  void loadWakeManifest().then(data=>{
    if(!s.alive)return;
    meta=data;base=data.frames[data.modelReferenceFrame].step;select(k);s.changed();
  }).catch(err=>{if(s.alive){loading=false;s.get('[data-ref]').textContent='C04 索引不可用。'+String(err);compare();}});
  s.animate=p=>{
    const advancing=Math.abs(p-clock)>.00001;
    clock=p;
    const t=Math.round(p*horizon);
    const narratedPhase=Math.min(3,Math.floor(p*4));
    if(advancing&&narratedPhase!==phase)setPhase(narratedPhase);
    if(advancing&&t!==k&&(!Number.isFinite(manualAt)||Math.abs(p-manualAt)>.03)){manualAt=NaN;select(t);}
  };
  s.useFilmData=active=>{
    if(filmView===active)return;
    filmView=active;
    fetchTruth();
  };
  select(k);setPhase(0);
}
