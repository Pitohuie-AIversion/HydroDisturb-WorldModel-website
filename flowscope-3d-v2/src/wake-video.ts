import {compactSeconds,indexAtTime} from './wake-timing';
import {mountWakeTransport} from './wake-presentation';
type Snapshot = {time_s:number; step:number};
const compact60='wake-compact.mp4',compact120='wake-compact-120.mp4';

async function supportedCompactMovie(){
  try{
    const info=await navigator.mediaCapabilities.decodingInfo({type:'file',video:{
      contentType:'video/mp4; codecs="avc1.640020"',width:674,height:578,bitrate:4800000,framerate:120,
    }});
    if(info.supported&&info.smooth)return compact120;
  }catch{/* Older browsers can play the standard compact movie. */}
  return compact60;
}

export function mountWakeVideo(surface:HTMLElement, panel:HTMLElement) {
  const video=document.createElement('video');
  video.muted=true;
  video.playsInline=true;
  video.preload='auto';
  video.setAttribute('aria-label','C04 固定视角三维涡脱落，0 至 60 秒');
  surface.replaceChildren(video);
  const transport=mountWakeTransport();
  panel.innerHTML=`
    <div class="readings">
      <div class="reading"><small>雷诺数 Re</small><b>126,167</b></div>
      <div class="reading"><small>圆柱直径 D</small><b>0.30 m</b></div>
      <div class="reading"><small>原始网格 Z × Y × X</small><b>64×96×192</b></div>
      <div class="reading"><small>归档时间步</small><b id="source-step">1 / 1001</b></div>
    </div>
    <p class="note" id="representation">固定视角录像使用 C04 的 81 个三维归档。8 秒回放在相邻归档图像间渐变，颜色表示展向涡量。</p>
    <p class="note" id="wake-video-status" role="status"></p>`;
  const get=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
  const cycle=get<HTMLButtonElement>('cycle'), speed=get<HTMLSelectElement>('wake-rate');
  const time=get<HTMLInputElement>('physical-time'), clock=get('physical-clock'), step=get('source-step');
  const status=get('wake-video-status');
  const stageTime=document.getElementById('stage-time'), stageTag=document.getElementById('stage-tag');
  const stop=new AbortController(), options={signal:stop.signal};
  let snapshots:Snapshot[]=[], presented=-1, pendingSeek=0;
  let dense:ReturnType<typeof transport.setFrames>,focusEnd:number|undefined;
  const mediaUrls=new Map<string,Promise<string>>();
  const supportedMovie=supportedCompactMovie();
  let activeFile='',standardMovie=false;
  let compact=true, switching=true, loadVersion=0;
  let requested=true, finished=false, callback=0, startupTimer=0;
  let presentedFirst=false;
  const playbackRate=()=>compact?1:Number(speed.value);
  function mediaTime(physical:number){
    if(!compact||snapshots.length<2||physical===0)return physical;
    // Seek just inside this encoded frame. Chromium can round an exact frame
    // boundary down by a microsecond and decode the preceding interpolation.
    return compactSeconds*indexAtTime(snapshots,physical)/(snapshots.length-1)+.0001;
  }

  function present(t:number) {
    if(!snapshots.length)return;
    const i=indexAtTime(snapshots,t+1e-6);
    if(i===presented)return;
    presented=i;
    transport.markFrame(i,snapshots.length-1);
    const sample=snapshots[i];
    clock.textContent=sample.time_s.toFixed(2)+' s';
    time.value=String(sample.time_s);
    time.setAttribute('aria-valuetext',clock.textContent);
    step.textContent=sample.step+' / '+snapshots.at(-1)!.step;
    if(stageTime)stageTime.textContent=clock.textContent+' / 60 s';
    if(stageTag)stageTag.dataset.step=String(sample.step);
  }
  function presentMedia(t:number){
    // A late decoded frame must not overwrite a paused selection or the endpoint.
    if(!requested||switching||!snapshots.length)return;
    if(!compact){
      if(focusEnd!==undefined && t>=focusEnd-1e-5){
        const endpoint=focusEnd;focusEnd=undefined;pause();seek(endpoint);
      }else present(t);
      return;
    }
    const last=snapshots.length-1;
    const position=Math.min(last,Math.max(0,t/compactSeconds*last));
    const left=Math.min(last,Math.floor(position+1e-5));
    const a=snapshots[left].time_s;
    present(a);
    if(stageTime){
      const blend=position-left;
      stageTime.textContent=left<last&&blend>.001
        ?'≈ '+(a+blend*(snapshots[left+1].time_s-a)).toFixed(2)+' s / 60 s'
        :a.toFixed(2)+' s / 60 s';
    }
  }
  function syncButton() {
    cycle.textContent=requested?'Ⅱ 暂停体场':finished?'↺ 从头播放':'▷ 播放体场';
    cycle.setAttribute('aria-pressed',String(requested));
  }
  async function play() {
    if(!requested||switching||stop.signal.aborted||video.readyState<1||!presentedFirst)return;
    try {
      await video.play();
    } catch(error) {
      if(stop.signal.aborted || (error instanceof DOMException && error.name==='AbortError'))return;
      requested=false;
      syncButton();
    }
  }
  function pause() {
    requested=false;
    video.pause();
    syncButton();
  }
  function seek(t:number) {
    pendingSeek=t;
    finished=t>=60;
    if(!switching&&video.readyState>=1)video.currentTime=mediaTime(t);
    present(t);
    syncButton();
  }
  function seekSelection() {
    focusEnd=undefined;
    pause();
    const t=Number(time.value);
    const sample=snapshots.reduce<Snapshot|undefined>((best,frame)=>
      !best||Math.abs(frame.time_s-t)<Math.abs(best.time_s-t)?frame:best,undefined);
    seek(sample?.time_s??t);
  }
  function stepArchive(direction:number){
    if(!snapshots.length)return;
    focusEnd=undefined;
    pause();
    seek(snapshots[Math.min(snapshots.length-1,Math.max(0,presented+direction))].time_s);
  }
  get('wake-prev').addEventListener('click',()=>stepArchive(-1),options);
  get('wake-next').addEventListener('click',()=>stepArchive(1),options);
  time.addEventListener('keydown',event=>{
    const direction=event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:0;
    if(direction){event.preventDefault();stepArchive(direction);}
  },options);
  function playSequence(start:number,rate:string,end?:number){
    if(!snapshots.length)return;
    speed.value=rate;
    const nextCompact=rate==='compact';
    focusEnd=end===undefined?undefined:snapshots[end].time_s;
    requested=true;finished=false;
    pendingSeek=snapshots[start].time_s;
    if(compact!==nextCompact){
      compact=nextCompact;present(pendingSeek);syncButton();void loadMovie();
    }else{
      video.playbackRate=playbackRate();seek(pendingSeek);void play();
    }
  }
  get('wake-whole').addEventListener('click',()=>playSequence(0,'compact'),options);
  get('wake-focus').addEventListener('click',()=>{
    if(dense)playSequence(dense.start,'0.5',dense.end);
  },options);
  cycle.addEventListener('click',()=>{
    if(requested){pause();return;}
    if(finished)seek(0);
    requested=true;
    syncButton();
    void play();
  },options);
  speed.addEventListener('change',()=>{
    focusEnd=undefined;
    const next=speed.value==='compact';
    if(next===compact){video.playbackRate=playbackRate();return;}
    pendingSeek=snapshots[presented]?.time_s??pendingSeek;
    compact=next;
    void loadMovie();
  },options);
  time.addEventListener('input',seekSelection,options);
  video.addEventListener('loadedmetadata',()=>{
    if(switching)return;
    video.playbackRate=playbackRate();
    if(pendingSeek>0)video.currentTime=mediaTime(pendingSeek);
  },options);
  function startAfterFirstFrame() {
    if(switching||presentedFirst)return;
    presentedFirst=true;
    window.clearTimeout(startupTimer);
    void play();
  }
  video.addEventListener('loadeddata',()=>{
    // Also start on browsers that suspend frame callbacks for paused videos.
    if(!presentedFirst)startupTimer=window.setTimeout(startAfterFirstFrame,180);
    else void play();
  },options);
  video.addEventListener('ended',()=>{
    requested=false;
    finished=true;
    present(60);
    syncButton();
  },options);
  video.addEventListener('seeked',()=>presentMedia(video.currentTime),options);
  function onFrame(_now:number, metadata:VideoFrameCallbackMetadata) {
    if(stop.signal.aborted)return;
    if(!video.seeking)presentMedia(metadata.mediaTime);
    startAfterFirstFrame();
    callback=video.requestVideoFrameCallback(onFrame);
  }
  if(typeof video.requestVideoFrameCallback==='function')callback=video.requestVideoFrameCallback(onFrame);
  else video.addEventListener('timeupdate',()=>presentMedia(video.currentTime),options);

  function mediaError() {
    if(stop.signal.aborted)return;
    if(compact&&activeFile===compact120&&!standardMovie){
      standardMovie=true;
      pendingSeek=snapshots[presented]?.time_s??pendingSeek;
      void loadMovie();
      return;
    }
    pause();
    status.innerHTML='录像加载失败。<a href="./assets/wake-0-60.mp4">打开 C04 完整录像 ↗</a>';
  }
  video.addEventListener('error',()=>{if(!switching)mediaError();},options);
  const fetchLocal=async (path:string)=>{
      const response=await fetch(path,options);
      if(!response.ok)throw new Error(response.statusText);
      return response;
  };
  const archive=fetchLocal('./data/manifest.json').then(r=>r.json() as Promise<{frames:Snapshot[]}>);
  async function loadMovie(){
    const ticket=++loadVersion;
    switching=true;presentedFirst=false;
    window.clearTimeout(startupTimer);
    video.pause();
    try{
      const filename=compact?(standardMovie?compact60:await supportedMovie):'wake-0-60.mp4';
      if(ticket!==loadVersion||stop.signal.aborted)return;
      activeFile=filename;
      if(!mediaUrls.has(filename)){
        mediaUrls.set(filename,fetchLocal('./assets/'+filename).then(r=>r.blob()).then(blob=>URL.createObjectURL(blob)));
      }
      const [url,manifest]=await Promise.all([mediaUrls.get(filename)!,archive]);
      if(stop.signal.aborted||ticket!==loadVersion)return;
      if(!snapshots.length){
        snapshots=manifest.frames;
        dense=transport.setFrames(snapshots);
      }
      present(pendingSeek);
      switching=false;
      video.defaultPlaybackRate=playbackRate();
      video.src=url;
    }catch{
      if(ticket===loadVersion)mediaError();
    }
  }
  void loadMovie();
  return {
    dispose() {
      stop.abort();
      window.clearTimeout(startupTimer);
      if(callback)video.cancelVideoFrameCallback(callback);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      transport.dispose();
      mediaUrls.forEach(entry=>{void entry.then(url=>URL.revokeObjectURL(url)).catch(()=>{});});
      if(stageTag)delete stageTag.dataset.step;
      if(stageTime)stageTime.textContent='';
    }
  };
}
