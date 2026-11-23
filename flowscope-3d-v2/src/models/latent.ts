import {Stage, buttons, range, selectButton} from './shared';
import {readLatent,type LatentCache,type LatentSourceFrame} from './latent-io';
import {loadWakeManifest} from '../wake';
import {readFocus,writeFocus} from './focus';
import {processSelector} from './instrument';
import {latentView} from './latent-view';

const gridX=24, gridY=12, gridZ=8, features=256;
const count=gridX*gridY*gridZ;
function coordinates(id:number) {return [id%gridX,Math.floor(id/gridX)%gridY,Math.floor(id/(gridX*gridY))];}

/** Fixed Fourier modes across all 256 features give a closed-form per-token RMS. */
function activation(x:number,y:number,z:number,frame:number,c:number,normalised:boolean) {
  const a=.55+.25*Math.sin(x*.26+frame*.4);
  const b=.32+.14*Math.cos(y*.4-z*.11);
  const bias=.12*Math.sin((x+y)*.22);
  const angle=2*Math.PI*c/features;
  const raw=bias+a*Math.sin(angle+x*.21+y*.35-z*.44+frame*.5)+b*Math.cos(3*angle+y*.28+z*.3)+.16*Math.sin(7*angle+x*.13+frame*.19);
  const rms=Math.sqrt(bias*bias+(a*a+b*b+.16*.16)/2+1e-6);
  return normalised ? raw/rms : raw;
}
export function latent(s:Stage) {
  const focus=readFocus();
  let token=(focus.z*gridY+focus.y)*gridX+focus.x,channel=37,frame=3,norm=true;
  function selectToken(id:number){
    token=id;
    const [x,y,z]=coordinates(id);writeFocus({x,y,z});
    process.jump(0);
    refresh(false);s.changed();
  }
  function selectChannel(c:number){channel=c;process.jump(1);refresh();s.changed();}
  const view=latentView(s,selectToken,selectChannel);
  let archive:LatentSourceFrame[]=[];
  let cfdHistory:LatentSourceFrame[]=[];
  let loaded:LatentCache|undefined;
  let imported:LatentCache|undefined,filmView=false;
  let pending=0;

  s.controls.innerHTML='<h3>潜空间探针</h3>'+buttons(['t−3','t−2','t−1','t'],'frame')+
    '<div class="mc-token-axes">'+range('X',0,23,12,'x')+range('Y',0,11,6,'y')+range('Z',0,7,4,'z')+'</div>'+
    range('特征通道',0,255,channel,'channel')+
    '<label class="mc-check"><input data-norm type="checkbox" checked>无仿射 RMSNorm</label>'+
    '<div class="mc-reading"><b data-name></b><span data-activation></span><p data-map></p></div>'+
    '<details class="mc-details"><summary>六维旁路 b</summary><p>每一帧在有效流体内计算 μu、μv、μw、μp、σuvw、σp；三个速度分量共享尺度，六项独立于空间 Token。</p><p data-real-b></p></details>'+
    '<details class="mc-details"><summary>Enstrophy / Spectrum Probe</summary><p>设计目标为从 z_clean 估计无量纲三维拟能与能谱。监督标签来自 CFD 体场的有效差分区域和经过验证的谱窗口。</p></details>'+
    '<label class="mc-file">导入已训练 z_clean 缓存<input type="file" accept=".fslat" data-upload-latent></label>'+
    '<button type="button" class="mc-reset" data-reset-latent hidden>恢复合成潜空间</button><p class="mc-note" data-latent-status>当前激活为合成演示。导出工具为 scripts/export_latent.py。</p>';
  const valueAt=(id:number,c:number)=>{
    if(loaded)return loaded.values[c*count+id];
    const [x,y,z]=coordinates(id);
    return activation(x,y,z,frame,c,norm);
  };
  const refresh=(recolor=true)=>{
    const [x,y,z]=coordinates(token);
    view.refresh(token,channel,valueAt,recolor,!!loaded,loaded?loaded.norm==='per_token_no_affine':norm);
    for(const [name,value] of Object.entries({x,y,z,channel})){
      s.get<HTMLInputElement>('[data-range='+name+']').value=String(value);
      s.get('[data-out='+name+']').textContent=String(value);
    }
    selectButton(s.controls,'frame',loaded?-1:frame);
    s.controls.querySelectorAll<HTMLButtonElement>('[data-frame]').forEach(button=>{button.disabled=!!loaded;});
    const normBox=s.get<HTMLInputElement>('[data-norm]');
    normBox.disabled=!!loaded;normBox.checked=loaded?loaded.norm==='per_token_no_affine':norm;
    s.get('[data-reset-latent]').hidden=!loaded;
    s.controls.dataset.output=loaded?'trained':'concept';
    s.get('[data-name]').textContent='Token #'+token+' · ZYX ('+[z,y,x].join(', ')+')';
    s.get('[data-activation]').textContent=(loaded||norm?'z_clean':'z_raw')+'['+channel+'] = '+valueAt(token,channel).toPrecision(6)+(loaded?'（缓存实值）':'（合成）');
    s.get('[data-map]').textContent='对应输入格点 X '+x*8+'–'+(x*8+7)+'，Y '+y*8+'–'+(y*8+7)+'，Z '+z*8+'–'+(z*8+7)+'。';
    const cf=loaded?.frame??cfdHistory[frame];
    s.get('[data-real-b]').textContent=cf?.stats6?.length===6
      ?'真实 C04 · t='+cf.time_s.toFixed(2)+' s；b=['+cf.stats6.map(v=>v.toPrecision(3)).join(', ')+']。速度项单位 m/s，压力项单位 Pa。'
      :'当前帧统计待载入。';
  };
  for(const axis of ['x','y','z']) s.on(s.get('[data-range='+axis+']'),'input',()=>{
    const [x,y,z]=['x','y','z'].map(a=>Number(s.get<HTMLInputElement>('[data-range='+a+']').value));
    selectToken((z*gridY+y)*gridX+x);
  });
  s.on(s.get('[data-range=channel]'),'input',()=>selectChannel(Number(s.get<HTMLInputElement>('[data-range=channel]').value)));
  s.on(s.get('[data-norm]'),'change',()=>{norm=s.get<HTMLInputElement>('[data-norm]').checked;process.jump(1);refresh();s.changed();});
  s.controls.querySelectorAll<HTMLElement>('[data-frame]').forEach((el,i)=>s.on(el,'click',()=>{frame=i;refresh();s.changed();}));
  const upload=s.get<HTMLInputElement>('[data-upload-latent]');
  s.on(upload,'change',async()=>{
    const file=upload.files?.[0];if(!file)return;
    const seq=++pending;
    try{
      if(!archive.length)throw Error('等待 C04 帧索引就绪后再选择缓存。');
      const cache=await readLatent(file,archive);
      if(!s.alive||seq!==pending)return;
      imported=cache;loaded=filmView?undefined:cache;
      s.get('[data-latent-status]').textContent=filmView?'讲解正在显示教学向量。':cacheLabel(cache);
      refresh();s.changed();
    }catch(error){if(s.alive&&seq===pending)s.get('[data-latent-status]').textContent=String(error);}
    if(seq===pending)upload.value='';
  });
  s.on(s.get('[data-reset-latent]'),'click',()=>{
    ++pending;loaded=undefined;imported=undefined;
    s.get('[data-latent-status]').textContent='当前激活为合成演示。';
    refresh();s.changed();
  });
  refresh();
  void loadWakeManifest().then(m=>{
    if(!s.alive)return;
    archive=m.frames;
    const last=Math.min(m.frames.length-1,Math.max(3,m.modelReferenceFrame));
    cfdHistory=m.frames.slice(Math.max(0,last-3),last+1);
    refresh(false);s.changed();
  }).catch(()=>{if(s.alive)s.get('[data-real-b]').textContent='真实旁路统计暂不可用。';});
  const process=processSelector(s.controls,3,index=>view.stage(index),s.changed);
  function cacheLabel(cache:LatentCache){
    return '已导入模型输出 · step '+cache.frame.step+' · t='+cache.frame.time_s.toFixed(2)+' s · checkpoint '+cache.checkpoint.slice(0,12)+'…';
  }
  s.useFilmData=active=>{
    filmView=active;
    if(!imported)return;
    loaded=active?undefined:imported;
    s.get('[data-latent-status]').textContent=active?'讲解正在显示教学向量。':cacheLabel(imported);
    refresh();s.changed();
  };
  s.animate=p=>{process.update(p);view.animate(p);};
  s.onDispose=()=>{process.dispose();view.dispose();};
}
