import type {Chapter} from './shared';
import {ordinaryTrajectory,steps,stepSize,teachingVelocity} from './fm-math';
import {mountFmLesson,type FmFrame} from './fm-lesson';
import {fmColors as color} from './fm-colors';

// The same Euler states remain inspectable if the browser cannot create a WebGL context.
export function createFmFallback(panel:HTMLElement,surface:HTMLElement,changed:()=>void):Chapter {
  const {states}=ordinaryTrajectory();
  const canvas=document.createElement('canvas');
  canvas.className='fm-fallback-plot';
  canvas.setAttribute('aria-label','D0 与 D1 的二维教学轨迹');
  const controls=document.createElement('section');
  controls.className='model-controls';
  panel.replaceChildren(controls);
  surface.replaceChildren(canvas);
  const ctx=canvas.getContext('2d')!;
  let state:FmFrame={k:0,phase:0,fraction:0,atEnd:false};
  let hits:number[][]=[];
  function draw(frame:FmFrame) {
    state=frame;
    const {width:w,height:h}=canvas.getBoundingClientRect();
    if(!w||!h)return;
    const pixels=Math.min(2,window.devicePixelRatio||1);
    const cw=Math.round(w*pixels),ch=Math.round(h*pixels);
    if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
    ctx.setTransform(pixels,0,0,pixels,0,0);
    // Leave the stage background visible through the planar projection.
    ctx.clearRect(0,0,w,h);
    const left=Math.max(40,w*.1),right=w-Math.max(28,w*.07);
    const top=Math.max(25,h*.12),bottom=h-Math.max(35,h*.1);
    const x=(d:number)=>left+(d-.12)/.99*(right-left);
    const y=(d:number)=>bottom-(d+.44)/.84*(bottom-top);
    function stroke(ax:number,ay:number,bx:number,by:number){
      ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();
    }
    function arrow(ax:number,ay:number,bx:number,by:number,size:number) {
      const angle=Math.atan2(by-ay,bx-ax);
      stroke(ax,ay,bx,by);
      ctx.beginPath();ctx.moveTo(bx,by);
      ctx.lineTo(bx-size*Math.cos(angle-.42),by-size*Math.sin(angle-.42));
      ctx.lineTo(bx-size*Math.cos(angle+.42),by-size*Math.sin(angle+.42));
      ctx.closePath();ctx.fill();
    }
    ctx.font='12px Consolas, monospace';
    ctx.lineWidth=1;ctx.setLineDash([]);ctx.fillStyle=color.muted;ctx.textAlign='center';
    for(const value of [.2,.4,.6,.8,1]){
      ctx.strokeStyle=color.grid;stroke(x(value),top,x(value),bottom);
      ctx.fillText(value.toFixed(1),x(value),bottom+17);
    }
    ctx.textAlign='right';
    for(const value of [-.4,-.2,0,.2,.4]){
      ctx.strokeStyle=value===0?color.axis:color.grid;stroke(left,y(value),right,y(value));
      ctx.fillText(value.toFixed(1),left-7,y(value)+4);
    }
    ctx.fillText('D0',right,bottom+33);ctx.fillText('D1',left-6,top-7);
    const {k,phase,atEnd,fraction}=frame;
    hits=states.map(z=>[x(z[0]),y(z[1])]);
    const fill=ctx.createLinearGradient(0,top,0,bottom);
    fill.addColorStop(0,'rgba(0,152,220,.42)');fill.addColorStop(1,'rgba(0,152,220,.025)');
    ctx.fillStyle=fill;
    ctx.beginPath();ctx.moveTo(hits[0][0],bottom);
    for(const [px,py] of hits)ctx.lineTo(px,py);
    ctx.lineTo(hits.at(-1)![0],bottom);ctx.closePath();ctx.fill();
    if(phase===2&&!atEnd){
      ctx.strokeStyle=ctx.fillStyle=color.samples;ctx.lineWidth=1;ctx.globalAlpha=.58;
      for(const a of [.2,.36,.52,.68,.84,1])for(const b of [-.28,-.12,.04,.20]){
        const v=teachingVelocity([a,b,states[k][2]],k*stepSize);
        const ax=x(a),ay=y(b),dx=x(a+v[0]*stepSize)-ax,dy=y(b+v[1]*stepSize)-ay;
        const scale=Math.min(22,w*.033)/Math.hypot(dx,dy);
        arrow(ax,ay,ax+dx*scale,ay+dy*scale,3);
      }
      ctx.globalAlpha=1;
    }
    hits.slice(0,-1).forEach(([ax,ay],i)=>{
      const [bx,by]=hits[i+1];
      const future=i>k||(!atEnd&&i===k&&phase<2),current=i===k&&!atEnd&&phase>=2;
      ctx.lineWidth=future?1.6:3;ctx.setLineDash(future?[5,5]:[]);
      ctx.fillStyle=ctx.strokeStyle=current?color.active:future?color.prospective:color.complete;
      if(current)arrow(ax,ay,bx,by,10);else stroke(ax,ay,bx,by);
    });
    ctx.setLineDash([]);
    hits.forEach(([ax,ay],i)=>{
      ctx.fillStyle=i===steps&&atEnd||i===k+1&&!atEnd&&phase>=2?color.active:i<=k||atEnd?color.complete:color.prospective;
      ctx.beginPath();ctx.arc(ax,ay,i===k||i===steps&&atEnd?5:3.5,0,Math.PI*2);ctx.fill();
    });
    const [ax,ay]=hits[k],[bx,by]=hits[k+1];
    const cursorX=ax+(bx-ax)*fraction,cursorY=ay+(by-ay)*fraction;
    ctx.fillStyle=color.paper;ctx.strokeStyle=color.paper;ctx.lineWidth=1.3;
    ctx.beginPath();ctx.arc(cursorX,cursorY,3,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(cursorX,cursorY,8.5,0,Math.PI*2);ctx.stroke();
  }
  const lesson=mountFmLesson(controls,surface,changed,draw,'D0 · D1 二维投影');
  const resize=new ResizeObserver(()=>draw(state));
  resize.observe(canvas);
  canvas.onclick=e=>{
    const rect=canvas.getBoundingClientRect(),cx=e.clientX-rect.left,cy=e.clientY-rect.top;
    const idx=hits.findIndex(([px,py])=>Math.hypot(px-cx,py-cy)<=12);
    if(idx>=0)lesson.seek(idx/steps);
  };
  return {
    update:lesson.update,
    pick(){},
    dispose(){lesson.dispose();resize.disconnect();canvas.remove();controls.remove();}
  };
}
