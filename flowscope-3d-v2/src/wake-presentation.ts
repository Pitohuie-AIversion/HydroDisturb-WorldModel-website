import {wakeSpeedOptions} from './wake-timing'
import './wake-presentation.css'

export interface ArchiveTime {time_s:number; step:number}

/** Find the longest run at the archive's fastest acquisition cadence. */
export function denseWindow(frames:ReadonlyArray<ArchiveTime>) {
  const deltas=frames.slice(1).map((f,i)=>Math.round((f.time_s-frames[i].time_s)*1e4))
  const smallest=Math.min(...deltas)
  let start=0, bestStart=0, bestEnd=0
  for(let i=0;i<deltas.length;i++){
    if(deltas[i]!==smallest){start=i+1;continue}
    if(i+1-start>bestEnd-bestStart){bestStart=start;bestEnd=i+1}
  }
  return bestEnd-bestStart>=4 && bestEnd-bestStart<frames.length-1
    ? {start:bestStart,end:bestEnd} : undefined
}

export function mountWakeTransport() {
  const bar=document.createElement('section')
  bar.className='wake-timeline'
  bar.setAttribute('aria-label','C04 物理时间回放')
  bar.innerHTML=`
    <div class="wake-time-buttons">
      <button id="cycle" type="button" aria-pressed="true">Ⅱ 暂停体场</button>
      <button id="wake-prev" type="button" aria-label="上一归档帧" title="上一归档帧">‹</button>
      <button id="wake-next" type="button" aria-label="下一归档帧" title="下一归档帧">›</button>
    </div>
    <div class="wake-time-track">
      <label for="physical-time">物理时间 <output id="physical-clock">0.00 s</output></label>
      <input type="range" id="physical-time" min="0" max="60" step="0.06" value="0" aria-label="归档物理时间">
      <svg class="wake-ruler" viewBox="0 0 1000 5" preserveAspectRatio="none" aria-hidden="true"><path fill="none" vector-effect="non-scaling-stroke"/></svg>
      <div class="slider-ticks" aria-hidden="true"><span>0 s</span><span>15</span><span>30</span><span>45</span><span>60 s</span></div>
    </div>
    <div class="wake-time-modes">
      <label for="wake-rate">播放速度 <select id="wake-rate">${wakeSpeedOptions}</select></label>
      <div class="wake-replay-options"><button id="wake-whole" type="button" title="从 0 秒开始，按 8 秒全程回放">↺ 全程</button><button id="wake-focus" type="button" hidden></button></div>
    </div>`
  document.getElementById('viewport')!.after(bar)
  const focus=bar.querySelector<HTMLButtonElement>('#wake-focus')!
  const timeline=bar.querySelector<HTMLElement>('.wake-time-track')!
  const previous=bar.querySelector<HTMLButtonElement>('#wake-prev')!
  const next=bar.querySelector<HTMLButtonElement>('#wake-next')!
  let positions: number[]=[]
  return {
    element:bar,
    setFrames(frames:ReadonlyArray<ArchiveTime>){
      const span=frames.at(-1)!.time_s-frames[0].time_s
      if(span>0){
        positions=frames.map(frame=>(frame.time_s-frames[0].time_s)/span)
        const marks=positions.map(t=>'M'+(t*1000).toFixed(2)+' 0v4')
        bar.querySelector('.wake-ruler path')!.setAttribute('d',marks.join(''))
      }
      const dense=denseWindow(frames)
      focus.hidden=!dense
      if(dense){
        focus.textContent='慢看 '+frames[dense.start].time_s.toFixed(2)+'–'+frames[dense.end].time_s.toFixed(2)+' s'
        focus.title='以物理 0.5 倍速播放这段连续的 '+(dense.end-dense.start+1)+' 个归档帧'
      }
      return dense
    },
    markFrame(frame:number,last:number){
      previous.disabled=frame<=0
      next.disabled=frame>=last
      timeline.style.setProperty('--wake-progress',((positions[frame]??0)*100).toFixed(2)+'%')
    },
    dispose(){bar.remove()}
  }
}
