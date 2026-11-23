import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {chapters} from './chapters';
import {renderWorkedExample, showRolloutStep, updateFmExplanation} from './chapter-examples';
import {createModel} from './models';
import {createFmFallback} from './models/fm';
import {createWake} from './wake';
import {wakeControls, type Wake} from './wake-controls';
import {mountWakeVideo} from './wake-video';
import {mountWakeAtlas} from './wake-atlas';
import {mountExhibit} from './process-exhibit';
import {mountDataThread} from './data-thread';
import {createFilmGuide,type FilmGuide} from './film-guide';
import {loadFilm} from './film-media';

const element=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const surface=element('canvas-shell');
const panel=element('panel'), details=element('details'), loading=element('loading');
const clock=element<HTMLInputElement>('master');
const guideTransport=clock.closest<HTMLElement>('.transport')!;
const guide=await fetch('./assets/guide.json').then(async r=>{
  if(!r.ok)throw Error();
  const g=await r.json() as FilmGuide;
  if(g.starts.length!==chapters.length || !Number.isFinite(g.duration))throw Error();
  return g;
}).catch(()=>({starts:chapters.map((_,i)=>i*12),duration:84}));
const DURATION=guide.duration;
const filmGuide=createFilmGuide(guide,panel);
const voice=new Audio();
voice.preload='metadata';
let voiceFailed=false, muted=false, voiceReady=false;
const mediaUrls:string[]=[];
function mediaUrl(blob:Blob){
  const objectUrl=URL.createObjectURL(blob);
  mediaUrls.push(objectUrl);
  return objectUrl;
}
async function localMedia(path:string){
  const response=await fetch(path);
  if(!response.ok)throw new Error('无法读取 '+path);
  return mediaUrl(await response.blob());
}
// A local blob remains seekable on ordinary static servers without byte ranges.
let voiceLoad:Promise<void>|undefined;
function loadVoice(){
  return voiceLoad??=localMedia('./assets/guide.m4a').then(src=>{voice.src=src;voiceReady=true;}).catch(()=>{voiceFailed=true;});
}
voice.addEventListener('error',()=>{voiceFailed=true;});
const scene=new THREE.Scene();
const world=new THREE.Group();
scene.add(world);
scene.add(new THREE.HemisphereLight(0xffffff,0xc9d8d1,1.65));
const keyLight=new THREE.DirectionalLight(0xffffff,2.2);
keyLight.position.set(-3,7,5);
scene.add(keyLight);
const rim=new THREE.DirectionalLight(0xcbe6f5,.95);
rim.position.set(5,3,-4);
scene.add(rim);
const perspectiveCamera=new THREE.PerspectiveCamera(34,1,.05,120);
const orthographicCamera=new THREE.OrthographicCamera(-4.75,4.75,2.75,-2.75,.05,120);
let camera:THREE.PerspectiveCamera|THREE.OrthographicCamera=perspectiveCamera;
let renderer:THREE.WebGLRenderer|undefined, controls:OrbitControls|undefined;
let softwareGL:WebGL2RenderingContext|undefined, softwareFence:WebGLSync|null=null, lastSoftwareDraw=0;
let fallbackVideo:HTMLVideoElement|undefined;
let wakeVideo:ReturnType<typeof mountWakeVideo>|undefined;
let wakeAtlas:ReturnType<typeof mountWakeAtlas>|undefined;
let guideVideoLoad:Promise<void>|undefined;
let fallbackReason='';
let index=-1, elapsed=0, rate=1, guided=false, playing=false, version=0;
let currentModel:ReturnType<typeof createModel>|undefined, currentWake:ReturnType<typeof wakeControls>|undefined;
let exhibit:ReturnType<typeof mountExhibit>;
let dataThread:ReturnType<typeof mountDataThread>|undefined;
let cachedWake:Promise<Wake>|undefined;
const wakeGroup=new THREE.Group();
world.add(wakeGroup);
let dirty=true, disposed=false;
let pendingFrame=false, displayCallback=0, lateTimer=0, timerPaced=false, lastDisplayTick=0;
let lastDispatch=0, pacedDeadline=0, regularDisplayTicks=0;
let frameWorker:Worker|undefined, workerPending=false, workerUnavailable=false, lastWorkerTick=0;
let insideFrame=false, previousStamp=0, previousDraw=false, transportStamp=0;
let qualityLevel=0, sampleMs=0, slowMs=0;
function emitFrame(){
  if(!pendingFrame)return;
  window.clearTimeout(lateTimer);
  pendingFrame=false;
  lastDispatch=performance.now();
  animate(lastDispatch);
}
function stopWorkerClock(){
  frameWorker?.terminate();frameWorker=undefined;
  workerPending=false;lastWorkerTick=0;
}
function requestWorkerTick(){
  if(workerPending||workerUnavailable||!renderer||softwareGL)return;
  try{
    if(!frameWorker){
      const worker=new Worker(new URL('./frame-clock.worker.ts',import.meta.url),{type:'module'});
      frameWorker=worker;
      worker.onerror=()=>{if(frameWorker===worker){workerUnavailable=true;stopWorkerClock();}};
      worker.onmessage=event=>{
        if(frameWorker!==worker)return;
        workerPending=false;
        if(event.data!=='frame'){workerUnavailable=true;stopWorkerClock();return;}
        if(!timerPaced||!pendingFrame||document.hidden||disposed){stopWorkerClock();return;}
        lastWorkerTick=performance.now();
        if(lastWorkerTick-lastDispatch<2){requestWorkerTick();return;}
        pacedDeadline=lastWorkerTick;
        emitFrame();
      };
    }
    workerPending=true;
    frameWorker.postMessage('next');
  }catch{workerUnavailable=true;stopWorkerClock();}
}
function onDisplayTick(stamp:number){
  displayCallback=0;
  const displayInterval=stamp-lastDisplayTick;
  regularDisplayTicks=displayInterval>0&&displayInterval<38?regularDisplayTicks+1:0;
  lastDisplayTick=stamp;
  if(timerPaced){
    if(regularDisplayTicks>=6){timerPaced=false;stopWorkerClock();}
    else if(pendingFrame&&performance.now()<pacedDeadline-1){
      // An isolated host vsync can arrive immediately after a timed draw.
      displayCallback=requestAnimationFrame(onDisplayTick);
      return;
    }
  }
  emitFrame();
}
function onLateFrame(){
  if(!timerPaced){
    timerPaced=true;
    regularDisplayTicks=0;
    pacedDeadline=performance.now();
  }
  emitFrame();
}
function scheduleFrame(){
  if(pendingFrame||insideFrame||document.hidden||disposed)return;
  pendingFrame=true;
  if(!displayCallback)displayCallback=requestAnimationFrame(onDisplayTick);
  // Some visible embedded Chromium surfaces suspend vsync. Keep time against
  // successive deadlines so decode time and timer rounding do not accumulate.
  let delay=42;
  if(timerPaced){
    // An embedded document can lose its own vsync while a dedicated worker
    // continues to receive native display callbacks. Use the timer as watchdog.
    requestWorkerTick();
    const now=performance.now();
    const period=1000/(renderer?(softwareGL?60:120):30);
    pacedDeadline=now-lastDispatch>period*3
      ?now:Math.max(pacedDeadline+period,lastDispatch+period*.55);
    delay=lastWorkerTick&&now-lastWorkerTick<32?32:Math.max(0,pacedDeadline-now);
  }
  lateTimer=window.setTimeout(onLateFrame,delay);
}
function invalidate(){dirty=true;scheduleFrame();}
function updateModelSource(){
  if(!currentModel||(index!==2&&index!==6))return;
  const output=panel.firstElementChild?.getAttribute('data-output');
  const trained=output==='trained';
  element('source-tag').textContent=index===2
    ? (trained?'已导入潜变量':'架构 / 合成演示')
    : (trained?'真实 CFD / 已导入预测':output==='simulated'?'真实 CFD / 模拟预测':'真实 CFD / 滚动示意');
}
new MutationObserver(updateModelSource).observe(panel,{subtree:true,attributes:true,attributeFilter:['data-output']});

function displayRatio(width:number,height:number){
  // Bound high-DPI fragment work in fullscreen while leaving HTML labels native.
  const ceiling=[2073600,1152000,691200][qualityLevel];
  return Math.min(window.devicePixelRatio||1,[1.5,1,.8][qualityLevel],Math.sqrt(ceiling/Math.max(1,width*height)));
}
function adaptQuality(intervalMs:number){
  if(!renderer||qualityLevel>=2||intervalMs<=0)return;
  // Sample consecutive busy draws only. Waiting for a new CFD sample is not a dropped video frame.
  const weight=Math.min(intervalMs,100);
  sampleMs+=weight;
  if(intervalMs>34)slowMs+=weight;
  if(sampleMs<700)return;
  const overloaded=slowMs>sampleMs*.28;
  sampleMs=slowMs=0;
  if(!overloaded)return;
  qualityLevel++;
  const bounds=surface.getBoundingClientRect();
  renderer.setPixelRatio(displayRatio(bounds.width,bounds.height));
  currentWake?.quality(qualityLevel);
  element('footer-state').textContent='WebGL2 · '+(qualityLevel===1?'自适应轻量显示':'自适应低负载显示');
}
function drawScene(){
  if(renderer&&!currentModel?.render?.(renderer,scene,camera,controls?.target))renderer.render(scene,camera);
}

const heightPerDistance=2*Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov/2));
function fitFrustum(width:number,height:number){
  const aspect=Math.max(width,1)/Math.max(height,1);
  // Fit the full archived wake envelope inside the actual plot area as the layout changes.
  const viewHeight=index===0?Math.max(3.78,7.95/aspect):Math.max(4.4,9.5/aspect);
  perspectiveCamera.aspect=aspect;
  perspectiveCamera.updateProjectionMatrix();
  orthographicCamera.top=viewHeight/2;
  orthographicCamera.bottom=-viewHeight/2;
  orthographicCamera.right=viewHeight*aspect/2;
  orthographicCamera.left=-orthographicCamera.right;
  orthographicCamera.updateProjectionMatrix();
  const fitDistance=viewHeight/heightPerDistance;
  if(controls){
    controls.minDistance=2.6;
    controls.maxDistance=Math.max(24,fitDistance*1.5);
    controls.minZoom=fitDistance/controls.maxDistance;
    controls.maxZoom=fitDistance/controls.minDistance;
  }
  return fitDistance;
}

function updateProjectionControl(){
  const button=element<HTMLButtonElement>('projection-toggle');
  const ortho=camera===orthographicCamera;
  button.title=ortho?'切换为透视视角':'切换为正交视角';
  button.setAttribute('aria-label','三维正交投影');
  button.setAttribute('aria-pressed',String(ortho));
  button.textContent=ortho?'正交':'透视';
  element('camera-hint').textContent=chapters[index]?.hint??'拖动旋转 · 滚轮缩放';
}

function installControls(){
  if(!renderer)return;
  controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;controls.dampingFactor=.12;
  controls.addEventListener('change',invalidate);
  controls.update();
}

function toggleProjection(){
  if(!controls)return;
  const fitDistance=(orthographicCamera.top-orthographicCamera.bottom)/heightPerDistance;
  // Match the visible height at the orbit target, including a prior wheel zoom.
  if(camera===perspectiveCamera){
    orthographicCamera.zoom=fitDistance/camera.position.distanceTo(controls.target);
    orthographicCamera.updateProjectionMatrix();
    orthographicCamera.position.copy(camera.position);
    camera=orthographicCamera;
  }else{
    perspectiveCamera.position.copy(camera.position).sub(controls.target)
      .setLength(fitDistance/orthographicCamera.zoom).add(controls.target);
    camera=perspectiveCamera;
  }
  controls.object=camera;
  controls.update();
  updateProjectionControl();
  invalidate();
}

const icons:Record<string,string>={
  'reset-camera':'<path d="M4 11a8 8 0 1 1 2.4 6M4 4v7h7"/>',
  capture:'<path d="M3 7.5h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="3.6"/>',
  fullscreen:'<path d="M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5"/>'
};
Object.entries(icons).forEach(([id,path])=>element(id).innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">'+path+'</svg>');

function installRenderer(){
  try {
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'high-performance',preserveDrawingBuffer:false});
    const gl=renderer.getContext() as WebGL2RenderingContext;
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    const driver=String(gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER));
    if(/swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|\bwarp\b/i.test(driver)){
      qualityLevel=2;
      softwareGL=gl;
    }
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.setClearColor(0xf1f5ef,0);
    renderer.domElement.setAttribute('aria-label','三维场景，可拖动旋转和缩放');
    renderer.domElement.setAttribute('tabindex','0');
    surface.replaceChildren(renderer.domElement);
    installControls();
    renderer.domElement.addEventListener('webglcontextlost',event=>{event.preventDefault();switchToVideo('图形上下文已释放');});
    renderer.domElement.addEventListener('keydown',e=>{
      if(guided)return;
      if(e.key==='Home'){resetCamera();e.preventDefault();return;}
      const angle=e.key==='ArrowLeft'?-.12:e.key==='ArrowRight'?.12:0;
      if(angle){camera.position.sub(controls!.target).applyAxisAngle(new THREE.Vector3(0,1,0),angle).add(controls!.target);controls!.update();invalidate();e.preventDefault();}
    });
    let downX=0,downY=0;
    renderer.domElement.addEventListener('pointerdown',e=>{downX=e.clientX;downY=e.clientY;});
    renderer.domElement.addEventListener('pointerup',e=>{
      if(guided||!currentModel||Math.hypot(e.clientX-downX,e.clientY-downY)>4)return;
      const bounds=surface.getBoundingClientRect();
      const ray=new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX-bounds.left)/bounds.width)*2-1,1-((e.clientY-bounds.top)/bounds.height)*2),camera);
      currentModel.pick(ray);invalidate();
    });
    new ResizeObserver(()=>{
      if(!renderer)return;
      const {width,height}=surface.getBoundingClientRect();
      const oldFit=(orthographicCamera.top-orthographicCamera.bottom)/heightPerDistance;
      const fit=fitFrustum(width,height);
      if(controls&&camera===perspectiveCamera){
        camera.position.sub(controls.target).multiplyScalar(fit/oldFit).add(controls.target);
        controls.update();
      }
      const ratio=displayRatio(width,height);
      if(Math.abs(renderer.getPixelRatio()-ratio)>.001)renderer.setPixelRatio(ratio);
      renderer.setSize(width,height,false);invalidate();
    }).observe(surface);
  } catch {
    switchToVideo('此浏览器未提供 WebGL2');
  }
}

function setVideoChapter() {
  const v=fallbackVideo;
  if(!v?.isConnected||v.readyState<1)return;
  if(Math.abs(v.currentTime-elapsed)>.06)v.currentTime=elapsed;
  if(playing&&v.paused)void v.play().catch(()=>{if(v.isConnected&&v.paused){playing=false;updateTransport();}});
}
function showFallback(freeWake:boolean){
  const v=fallbackVideo;
  if(!v)return;
  loading.hidden=true;
  element('viewport').classList.toggle('wake-film',freeWake);
  element('source-tag').textContent=index?'架构 / 合成演示':'C04 录像';
  if(freeWake){
    if(wakeVideo)return;
    surface.replaceChildren();v.pause();
    element('stage-tag').textContent='C04　/　固定视角';
    element('footer-state').textContent=fallbackReason+' · C04 全程录像';
    wakeVideo=mountWakeVideo(surface,panel);
    wakeAtlas=mountWakeAtlas(guideTransport);
    return;
  }
  wakeAtlas?.dispose();wakeAtlas=undefined;
  wakeVideo?.dispose();wakeVideo=undefined;
  if(!v.isConnected)surface.replaceChildren(v);
  element('footer-state').textContent=fallbackReason+' · 七章演示视频';
  panel.innerHTML='<p class="note">可通过章节目录选择片段，或在演示资料中打开七章视频。</p>';
  modelDetails(index);
  guideVideoLoad??=loadFilm().then(blob=>{v.src=mediaUrl(blob);}).catch(()=>{
    guideVideoLoad=undefined;
    if(v.isConnected){loading.hidden=false;loading.textContent='七章视频读取失败，请检查演示包的 library 文件夹。';}
  });
  setVideoChapter();
}
function switchToVideo(reason:string){
  if(fallbackVideo)return;
  fallbackReason=reason;
  controls?.dispose();controls=undefined; renderer=undefined;softwareGL=undefined;softwareFence=null;
  voice.pause();
  const v=document.createElement('video'); v.controls=true;v.playsInline=true;v.muted=muted;v.preload='metadata';
  v.playbackRate=rate;
  v.addEventListener('loadedmetadata',setVideoChapter);
  v.addEventListener('play',()=>{if(v.isConnected){playing=true;guided=true;updateTransport();scheduleFrame();}});
  v.addEventListener('pause',()=>{if(v.isConnected&&v.paused){playing=false;updateTransport();}});
  v.addEventListener('timeupdate',()=>{if(v.isConnected&&(v.seeking||v.paused)){elapsed=v.currentTime;if(index!==chapterFromTime())void chapter(chapterFromTime(),true);updateTransport();}});
  v.addEventListener('error',()=>{if(v.isConnected){loading.hidden=false;loading.textContent='视频读取失败，请在演示资料中打开本地 MP4。';}});
  fallbackVideo=v;
  element('projection-toggle').hidden=true;element('reset-camera').hidden=true;element('capture').hidden=true;
  surface.parentElement!.classList.add('is-video');
  if(index>=0)void chapter(index);
}
function resetCamera(){
  if(!controls)return;
  // Flush pending orbit and pan deltas before restoring the chapter pose.
  controls.enableDamping=false;controls.update();controls.enableDamping=true;
  const direction=index<=0?new THREE.Vector3(-3.2,3.4,8.2):
    index===6?new THREE.Vector3(.85,1.6,9.7):new THREE.Vector3(3.2,2.7,9.7);
  if(index===0)controls.target.set(.38,.22,0);
  else controls.target.set(0,0,0);
  const bounds=surface.getBoundingClientRect();
  orthographicCamera.zoom=1;
  const distance=fitFrustum(bounds.width,bounds.height);
  camera.position.copy(direction.setLength(distance)).add(controls.target);
  camera.lookAt(controls.target);controls.update();invalidate();
}
const chapterButtons=element('chapters');
chapterButtons.innerHTML=chapters.map((c,i)=>`<button class="chapter-btn" type="button" data-nav="${i}"><span class="n">${String(i+1).padStart(2,'0')}</span><span><strong>${c.name}</strong><small>${c.rail}</small></span></button>`).join('');
element('ticks').innerHTML=chapters.map((c,i)=>`<button type="button" data-nav="${i}" aria-label="跳到${c.name}">${String(i+1).padStart(2,'0')}</button>`).join('');
const safeIndex=(n:number)=>Math.min(chapters.length-1,Math.max(0,n));
const chapterFromTime=()=>safeIndex(guide.starts.filter(start=>start<=elapsed).length-1);
const localProgress=()=>Math.max(0,Math.min(1,(elapsed-guide.starts[index])/((guide.starts[index+1]??DURATION)-guide.starts[index])));
const formatTime=(s:number)=>[Math.floor(s/60),Math.floor(s%60)].map(n=>String(n).padStart(2,'0')).join(':');
function updateTransport(){
  clock.value=String(Math.round(elapsed/DURATION*8399));
  const timeText=formatTime(elapsed>=DURATION?Math.round(DURATION):elapsed)+' / '+formatTime(Math.round(DURATION));
  if(element('elapsed').textContent!==timeText)element('elapsed').textContent=timeText;
  const play=element<HTMLButtonElement>('play');
  const playLabel=playing?'暂停讲解':'播放讲解';
  if(play.getAttribute('aria-label')!==playLabel){play.textContent=playing?'Ⅱ':'▶';play.setAttribute('aria-label',playLabel);}
  const tour=element('tour');
  if(tour.getAttribute('aria-pressed')!==String(guided)){
    tour.innerHTML=guided?'返回自由探索':'<span aria-hidden="true">▷</span> 自动讲解';
    tour.setAttribute('aria-pressed',String(guided));
  }
}
function explore(){guided=false;playing=false;filmGuide.reset();if(controls)controls.enabled=true;voice.pause();fallbackVideo?.pause();updateTransport();}
function showGuideFrame(){
  const p=localProgress(), chapterSeconds=elapsed-guide.starts[index];
  if(filmGuide.show(index,elapsed,currentModel,pose=>{
    currentWake?.guided(p,chapterSeconds,pose);
    wakeAtlas?.mark(pose.landmark);
  }))return;
  currentModel?.update(p);currentWake?.guided(p,chapterSeconds);
}
function playNarration(){
  if(voiceFailed)return;
  const speak=()=>{
    if(!playing||!voiceReady||fallbackVideo?.isConnected)return;
    voice.currentTime=elapsed;
    voice.playbackRate=rate;
    void voice.play().catch(()=>{voiceFailed=true;});
  };
  if(voice.readyState>=1)speak();
  else void loadVoice().then(()=>{
    if(voice.readyState>=1)speak();
    else if(voiceReady)voice.addEventListener('loadedmetadata',speak,{once:true});
  });
}
function togglePlay(){
  if(playing){playing=false;voice.pause();fallbackVideo?.pause();}
  else{
    if(elapsed>=DURATION-.02){elapsed=0;void chapter(0,true);}
    guided=true;playing=true;if(controls)controls.enabled=false;resetCamera();
    showGuideFrame();
    if(fallbackVideo&&!currentModel)showFallback(false);
    else playNarration();
  }
  updateTransport();scheduleFrame();
}
function modelDetails(i:number){
  if(renderWorkedExample(i,details,panel))return;
  const c=chapters[i];if(!('trace' in c))return;
  details.innerHTML='<article class="detail-card"><header><h2>计算路径</h2><small>'+c.input+'</small></header><div class="shape-flow">'+c.trace.map(t=>'<span>'+t+'</span>').join('<i>→</i>')+'</div><p>'+c.note+'</p></article><article class="detail-card"><header><h2>'+c.keyword+'</h2><small>'+c.reference+'</small></header><div class="shape-flow"><span>'+c.next+'</span></div><p><a href="./references/architecture-v1.2.svg" target="_blank" rel="noopener">查看原始架构图 ↗</a>'+(i===2?'　<a href="./references/latent-v1.4.html" target="_blank" rel="noopener">原版潜空间透视台 ↗</a>':'')+'</p></article>';
}
panel.addEventListener('rollout-step',event=>{
  const {base,k}=(event as CustomEvent<{base:number;k:number}>).detail;
  showRolloutStep(details,base,k);
});
panel.addEventListener('fm-step',event=>{
  const state=(event as CustomEvent<{phase:number}>).detail;
  updateFmExplanation(details,panel,state?.phase);
});
panel.addEventListener('flowscope-process-state', event => {
  exhibit?.show((event as CustomEvent<{index:number}>).detail.index);
});

async function chapter(next:number,guideFrame=guided){
  const ticket=++version;
  filmGuide.reset();
  sampleMs=slowMs=0;previousDraw=false;
  currentWake?.dispose();currentWake=undefined;
  wakeAtlas?.dispose();wakeAtlas=undefined;
  currentModel?.dispose();currentModel=undefined;
  exhibit?.dispose();exhibit=undefined;
  dataThread?.dispose();dataThread=undefined;
  wakeVideo?.dispose();wakeVideo=undefined;
  wakeGroup.visible=false;index=next;
  camera=orthographicCamera;
  if(controls)controls.object=camera;
  element('viewport').classList.toggle('field-view',next===0);
  const c=chapters[next];
  document.body.dataset.chapter=c.id;
  dataThread=mountDataThread(document.querySelector('.workbench')!, panel, next);
  const heading=element('chapter-head');
  heading.classList.toggle('stage-intro',next===0);
  element('wake-specs').hidden=next!==0;
  const title=element('title');
  title.textContent=c.name;
  if(next===0){
    const accent=document.createElement('span');
    accent.textContent='涡脱落';
    title.replaceChildren('圆柱尾流',accent);
    element('viewport').prepend(heading);
  }else{
    document.querySelector('.workbench')!.before(heading);
  }
  element('chapter-en').textContent=String(next+1).padStart(2,'0')+' / '+c.en.toUpperCase();
  element('subtitle').textContent=c.subtitle;element('panel-title').textContent=c.panel;
  exhibit=mountExhibit(next,Boolean(renderer)||next===6,step=>{
    explore();
    panel.dispatchEvent(new CustomEvent('flowscope-process-select',{detail:{index:step}}));
    invalidate();
  });
  element('panel-kicker').textContent=next===0?'FIELD INSPECTOR':'MODEL INSPECTOR';
  const tag=element('source-tag');tag.className='source-tag'+(next?' concept':'');
  tag.textContent=next===1?'C04 输入 / 编码示意':next===3?'解码结构 / 解析示例':next?'架构 / 合成演示':'读取 C04…';
  element('stage-tag').textContent=c.en.toUpperCase();
  delete element('stage-tag').dataset.step;
  element('stage-time').textContent='';
  const legend=element('legend');
  legend.replaceChildren();legend.classList.toggle('fm-legend',next===5);
  if(next===5&&renderer)legend.innerHTML='<span><i class="past"></i>已完成</span><span><i class="active"></i>本步增量</span><span><i class="future"></i>待积分</span>';
  updateProjectionControl();
  document.querySelectorAll<HTMLButtonElement>('.chapter-btn').forEach((b,i)=>{if(i===index)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');});
  if(chapterButtons.scrollWidth>chapterButtons.clientWidth){
    const selected=chapterButtons.children[index] as HTMLElement;
    const selectedBox=selected.getBoundingClientRect(), navBox=chapterButtons.getBoundingClientRect();
    if(selectedBox.left<navBox.left)chapterButtons.scrollLeft+=selectedBox.left-navBox.left;
    else if(selectedBox.right>navBox.right)chapterButtons.scrollLeft+=selectedBox.right-navBox.right;
  }
  document.querySelectorAll<HTMLButtonElement>('#ticks button').forEach((b,i)=>b.classList.toggle('active',i===index));
  details.replaceChildren();panel.replaceChildren();loading.hidden=true;
  resetCamera();invalidate();updateTransport();
  if(!renderer){
    element('capture').hidden=next!==6;
    element('projection-toggle').hidden=next!==6;
    element('reset-camera').hidden=next!==6;
  }
  if(!renderer&&next===6){
    fallbackVideo?.pause();
    surface.replaceChildren();
    element('viewport').classList.remove('wake-film');
    currentModel=createModel(next,world,panel,invalidate);
    modelDetails(next);
    if(guideFrame)showGuideFrame();else currentModel.update(0);
    updateModelSource();
    element('footer-state').textContent='同步切面对照 · 离线资源';
    if(playing)playNarration();
    return;
  }
  if(!renderer&&next===5){
    surface.replaceChildren();
    fallbackVideo?.pause();
    const viewport=element('viewport');
    viewport.classList.remove('wake-film');
    element('stage-tag').textContent='潜状态投影';
    element('camera-hint').textContent='点选步骤查看计算';
    element('footer-state').textContent='二维交互视图 · 离线资源';
    currentModel=createFmFallback(panel,surface,invalidate);
    modelDetails(next);
    if(guideFrame)showGuideFrame();else currentModel.update(0);
    if(playing)playNarration();
    return;
  }
  if(!renderer){
    voice.pause();
    element('stage-tag').textContent='本地演示视频';element('camera-hint').textContent='使用视频控件播放';
    showFallback(next===0&&!guideFrame);return;
  }
  try{
    if(!next){
      loading.textContent='正在读取 C04 体场…';loading.hidden=false;
      cachedWake??=createWake(wakeGroup,invalidate).catch(e=>{cachedWake=undefined;throw e;});
      const wake=await cachedWake;
      if(ticket!==version)return;
      wakeGroup.visible=true;currentWake=wakeControls(wake,panel,details,invalidate,explore,guide.starts[1]-guide.starts[0],
        ()=>renderer?wake.warmStart(renderer,camera,scene):Promise.resolve());
      wakeAtlas=mountWakeAtlas(guideTransport);
      if(qualityLevel)currentWake.quality(qualityLevel);
      if(guideFrame||guided||elapsed>guide.starts[0])showGuideFrame();
    }else{
      currentModel=createModel(next,world,panel,invalidate);
      modelDetails(next);
      if(guideFrame)showGuideFrame();else currentModel.update(0);
      updateModelSource();
    }
  }catch(e){
    if(ticket!==version)return;
    tag.textContent='场景不可用';loading.hidden=false;
    loading.textContent=e instanceof Error?e.message:String(e);
    const retry=document.createElement('button');retry.type='button';retry.textContent='重新加载本章';retry.onclick=()=>void chapter(index);
    panel.append(retry);
  }
  invalidate();
}
function navigate(to:number){
  const entering=to!==index;
  explore();
  elapsed=guide.starts[to];
  void chapter(to);
  history.replaceState(null,'','#'+chapters[to].id);
  if(entering)window.scrollTo(0,0);
}
document.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach(b=>b.addEventListener('click',()=>navigate(Number(b.dataset.nav))));
element('next').addEventListener('click',()=>navigate((index+1)%chapters.length));
clock.addEventListener('input',()=>{
  const targetTime=Number(clock.value)/8399*DURATION;
  explore();
  elapsed=targetTime;
  if(chapterFromTime()!==index)void chapter(chapterFromTime(),true);
  else if(wakeVideo)showFallback(false);
  else if(fallbackVideo?.isConnected)setVideoChapter();
  showGuideFrame();updateTransport();invalidate();
});
element('tour').addEventListener('click',()=>{if(guided){if(index===0)navigate(0);else explore();}else togglePlay();});
element('play').addEventListener('click',togglePlay);
panel.addEventListener('pointerdown',()=>{if(guided||filmGuide.active)explore();});
panel.addEventListener('keydown',()=>{if(guided||filmGuide.active)explore();});
surface.addEventListener('pointerdown',()=>{if(filmGuide.active)explore();});
element('viewport').addEventListener('fm-explore',()=>{if(guided)explore();});
details.addEventListener('pointerdown',()=>{if(guided)explore();});
details.addEventListener('keydown',()=>{if(guided)explore();});
element<HTMLSelectElement>('rate').onchange=e=>{rate=Number((e.target as HTMLSelectElement).value);voice.playbackRate=rate;if(fallbackVideo)fallbackVideo.playbackRate=rate;};
element('mute').onclick=()=>{muted=!muted;voice.muted=muted;if(fallbackVideo)fallbackVideo.muted=muted;element('mute').setAttribute('aria-pressed',String(muted));element('mute').textContent=muted?'旁白关':'旁白开';};
element('reset-camera').onclick=resetCamera;
element('projection-toggle').onclick=toggleProjection;
element('fullscreen').onclick=()=>{
  const viewport=element('viewport');
  // Keep local playback and single-step controls accessible alongside the image.
  const target=index===0||exhibit?viewport.closest<HTMLElement>('.scene-column')!:
    index===5?viewport.closest<HTMLElement>('.workbench')!:viewport;
  if(document.fullscreenElement)void document.exitFullscreen();
  else if(target.classList.contains('expanded'))target.classList.remove('expanded');
  else void target.requestFullscreen().catch(()=>target.classList.add('expanded'));
};
element('capture').onclick=()=>{
  const native=surface.querySelector<HTMLCanvasElement>('canvas[data-model-capture]');
  if(!renderer&&!native)return;
  if(!native)drawScene();
  const src=native??renderer!.domElement;
  const image=document.createElement('canvas');image.width=src.width;image.height=src.height+80;
  const ctx=image.getContext('2d')!;
  ctx.fillStyle='#f7fbfe';ctx.fillRect(0,0,image.width,image.height);
  ctx.fillStyle=index===0?'#071b31':'#071c32';ctx.fillRect(0,0,image.width,src.height);
  ctx.drawImage(src,0,0);
  const logo=element<HTMLImageElement>('brand-logo');
  const logoWidth=Math.min(140,image.width*.22);
  let titleX=18;
  if(logo.complete&&logo.naturalWidth){
    const logoHeight=logoWidth*logo.naturalHeight/logo.naturalWidth;
    ctx.drawImage(logo,16,src.height+(80-logoHeight)/2,logoWidth,logoHeight);
    titleX=Math.ceil(logoWidth+36);
  }
  ctx.fillStyle='#142f49';ctx.font='600 20px "Microsoft YaHei",sans-serif';
  ctx.fillText('FlowScope 3D   /   '+chapters[index].name,titleX,src.height+31,image.width-titleX-12);
  ctx.font='13px "Microsoft YaHei",sans-serif';ctx.fillText((currentWake?.caption || element('source-tag').textContent)+'   ·   V2.0',titleX,src.height+55,image.width-titleX-12);
  image.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='FlowScope-3D-'+chapters[index].id+'.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);},'image/png');
};
const library=[
 ['观看 4K 展示短片','30 秒 · 七章配音','./film.html'],
 ['下载 4K 展示短片','MP4 · 3840 × 2160','./film.html?download=1'],
 ['七章网页互动分镜','文本','./library/interaction-script.md'],
 ['深海智人品牌标志原图','PNG','./assets/brand/sealien-logo.png'],
 ['观看原版完整讲解','5 分 33 秒 · 1080p','./film.html?edition=full'],
 ['七章完整中文旁白','M4A','./assets/guide.m4a?v=r16'],
 ['C04 涡脱落 · 8 秒全程回放','120 FPS · MP4','./assets/wake-compact-120.mp4'],
 ['C04 涡脱落 · 0–60 s 物理时间','MP4','./assets/wake-0-60.mp4'],
 ['可编辑演示文稿','PPTX','./library/presentation.pptx'],
 ['七章架构图','SVG','./library/architecture.svg'],
 ['架构图打印版','PDF','./library/architecture.pdf'],
 ['逐镜旁白稿与时间码','文本','./library/narration.md?v=r16'],
 ['原版 C04 快速回放 · 6.2 秒','MP4','./assets/c04-fallback.mp4'],
 ['原版潜空间透视台','V1.4 · HTML','./references/latent-v1.4.html'],
 ['原始预训练架构图','V1.2 · SVG','./references/architecture-v1.2.svg'],
 ['C04 数据清单','JSON','./data/manifest.json'],
 ['C04 逐点核验记录','JSON','./data/verification.json'],
 ['导入真实潜空间','说明','./library/latent.md'],
 ['导入模型预测','说明','./library/prediction.md']
];
element('resources-list').innerHTML=library.map(([name,type,path])=>`<a href="${path}" target="_blank" rel="noopener">${name}<small>${type} ↗</small></a>`).join('');
const dialog=element<HTMLDialogElement>('resources-dialog');
element('resources').onclick=()=>dialog.showModal();
element('close-dialog').onclick=()=>dialog.close();
window.addEventListener('hashchange',()=>{const i=chapters.findIndex(c=>'#'+c.id===location.hash);if(i>=0&&i!==index)navigate(i);});

function animate(stamp:number){
  if(disposed||document.hidden){previousStamp=0;previousDraw=false;return;}
  insideFrame=true;
  const interval=previousStamp?stamp-previousStamp:0;
  previousStamp=stamp;
  if(playing){
    const media=fallbackVideo?.isConnected?fallbackVideo:!voiceFailed?voice:undefined;
    if(media&&!media.paused)elapsed=media.currentTime;
    else if(!fallbackVideo?.isConnected&&(voiceFailed||voice.ended))elapsed=Math.min(DURATION,elapsed+Math.min(interval/1000,.2)*rate);
    if(chapterFromTime()!==index)void chapter(chapterFromTime());
    showGuideFrame();
    if(elapsed>=DURATION)playing=false;
    if(!playing||stamp-transportStamp>=60){updateTransport();transportStamp=stamp;}
    if(currentModel)dirty=true;
  }else currentWake?.idle(stamp);
  currentWake?.tick(stamp/1000);
  const moving=controls?.update();
  let draw=Boolean(renderer&&dirty);
  if(draw&&softwareGL){
    // Limit outstanding software draws. Queuing work at desktop refresh rate
    // can otherwise stall chapter disposal while the CPU rasterizer catches up.
    draw=stamp-lastSoftwareDraw>=15;
    if(draw&&softwareFence){
      draw=softwareGL.clientWaitSync(softwareFence,0,0)!==softwareGL.TIMEOUT_EXPIRED;
      if(draw){softwareGL.deleteSync(softwareFence);softwareFence=null;}
    }
  }
  if(draw){
    if(previousDraw)adaptQuality(interval);
    dirty=false;drawScene();currentWake?.drawn(stamp);
    if(softwareGL){
      softwareFence=softwareGL.fenceSync(softwareGL.SYNC_GPU_COMMANDS_COMPLETE,0);
      softwareGL.flush();lastSoftwareDraw=stamp;
    }
  } else if(!renderer)dirty=false;
  previousDraw=draw;
  insideFrame=false;
  if(dirty||playing||moving||currentWake?.animating())scheduleFrame();
  else {previousStamp=0;previousDraw=false;stopWorkerClock();}
}
installRenderer();
if(renderer)element('footer-state').textContent=softwareGL?'WebGL2 · 软件渲染轻量显示':'WebGL2 · 离线资源';
const initial=safeIndex(chapters.findIndex(c=>c.id===location.hash.slice(1)));
elapsed=guide.starts[initial];void chapter(initial);
scheduleFrame();
document.addEventListener('visibilitychange',()=>{
  previousStamp=0;previousDraw=false;timerPaced=false;lastDisplayTick=0;pacedDeadline=0;regularDisplayTicks=0;
  if(document.hidden){
    stopWorkerClock();
    window.cancelAnimationFrame(displayCallback);displayCallback=0;
    window.clearTimeout(lateTimer);pendingFrame=false;
  }else invalidate();
});
window.addEventListener('pagehide',e=>{stopWorkerClock();if(!e.persisted){disposed=true;voice.pause();wakeAtlas?.dispose();wakeVideo?.dispose();mediaUrls.forEach(url=>URL.revokeObjectURL(url));currentModel?.dispose();currentWake?.dispose();cachedWake?.then(w=>w.dispose()).catch(()=>{});controls?.dispose();renderer?.dispose();}});
