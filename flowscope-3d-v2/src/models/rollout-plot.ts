import type { loadTruthSlice, WakeManifest } from '../wake';

export type Slice = Awaited<ReturnType<typeof loadTruthSlice>>;
export const fieldColors = ['#051228','#0a203e','#102e60','#123d79','#0b4e8c','#075e9e','#0072b4','#008bd0','#0098dc','#12b7de','#66dfed','#c8f5ea','#fff5bf'];
export const errorColors = ['#101f3b','#554677','#b26782','#ee9776','#ffcf8d','#fff3cf'];
type Point = {x:number;y:number};
type Project = (x:number,y:number,z?:number)=>Point;
type Ctx = CanvasRenderingContext2D;
const blue='#46caff', mint='#9cf6e4', pale='#d9f6ff', muted='#91b4ce';
export type RolloutView = {
  base:number; k:number; horizon:number; phase:number; channel:string;
  meta?:WakeManifest; truth?:Slice; prediction?:Float32Array; error?:Float32Array;
  source:'simulated'|'imported'; errorMax:number; showError:boolean; row:number; loading:boolean;
};

function stroke(c:Ctx, pts:Point[], color:string, width=1, dash:number[]=[]){
  c.beginPath();pts.forEach((p,i)=>i?c.lineTo(p.x,p.y):c.moveTo(p.x,p.y));
  c.strokeStyle=color;c.lineWidth=width;c.setLineDash(dash);c.stroke();c.setLineDash([]);
}
function words(c:Ctx,value:string,x:number,y:number,size=12,color=muted,weight=500,align:CanvasTextAlign='left',mono=false){
  c.font=weight+' '+size+'px '+(mono?'Consolas,"Microsoft YaHei",monospace':'"Segoe UI","Microsoft YaHei",sans-serif');
  c.textAlign=align;c.textBaseline='middle';c.fillStyle=color;c.fillText(value,x,y);
}
function makeMap(values:ArrayLike<number>,truth:Slice,limits:readonly number[],error=false){
  const image=document.createElement('canvas');image.width=truth.width;image.height=truth.height;
  const c=image.getContext('2d')!, px=c.createImageData(image.width,image.height);
  const colors=(error?errorColors:fieldColors).map(color=>parseInt(color.slice(1),16));
  for(let j=0;j<truth.height;j++)for(let i=0;i<truth.width;i++){
    const n=j*truth.width+i, offset=4*((truth.height-1-j)*truth.width+i);
    const v=values[n];
    if(!Number.isFinite(v)||!Number.isFinite(truth.values[n])){px.data.set([10,25,42,255],offset);continue;}
    const t=Math.max(0,Math.min(1,(v-limits[0])/(limits[1]-limits[0]||1)))*(colors.length-1);
    const a=Math.min(colors.length-2,Math.floor(t)), f=t-a;
    for(let ch=0;ch<3;ch++){const shift=16-8*ch;px.data[offset+ch]=((colors[a]>>shift)&255)*(1-f)+((colors[a+1]>>shift)&255)*f;}
    px.data[offset+3]=255;
  }
  c.putImageData(px,0,0);return image;
}

// Draw actual iso-value crossings on top of the physical colour scale.
// Restrict the overlay to valid quads, including the cylinder mask.
function contourMap(values:ArrayLike<number>,truth:Slice,limits:readonly number[]){
  const factor=truth.width<160?4:2, image=document.createElement('canvas');
  image.width=truth.width*factor;image.height=truth.height*factor;
  const c=image.getContext('2d')!;c.scale(factor,factor);
  c.lineWidth=.58;c.strokeStyle='rgba(216,250,255,.48)';
  const corners=[[0,0],[1,0],[1,1],[0,1]], n=truth.width;
  for(let level=1;level<22;level++){
    const threshold=limits[0]+level*(limits[1]-limits[0])/22;
    c.beginPath();
    for(let j=0;j<truth.height-1;j++)for(let i=0;i<n-1;i++){
      const idx=j*n+i,samples=[values[idx],values[idx+1],values[idx+n+1],values[idx+n]];
      if(samples.some(v=>!Number.isFinite(v)))continue;
      let start:Point|undefined;
      for(let side=0;side<4;side++){
        const next=(side+1)%4,a=samples[side],b=samples[next];
        if((a>=threshold)===(b>=threshold))continue;
        const t=(threshold-a)/(b-a),p=corners[side],q=corners[next];
        const x=i+.5+p[0]+(q[0]-p[0])*t,y=truth.height-j-.5-p[1]-(q[1]-p[1])*t;
        if(start){c.moveTo(start.x,start.y);c.lineTo(x,y);start=undefined;}else start={x,y};
      }
    }
    c.stroke();
  }
  return image;
}

// All physical plates, profile lines and hit tests use this same camera.
function projector(cx:number,cy:number,width:number,angle:number,elevation:number,perspective:boolean):Project{
  const ca=Math.cos(angle),sa=Math.sin(angle),ce=Math.cos(elevation),se=Math.sin(elevation);
  return (u,v,z=0)=>{
    const x=u-.5, y=(v-.5)*.5, depth=x*sa+y*ca;
    const scale=perspective?2.1/(2.1+depth*ce-z*se):1;
    return {x:cx+(x*ca-y*sa)*width*scale,y:cy-(depth*se+z*ce)*width*scale};
  };
}
function projectMap(c:Ctx, image:HTMLCanvasElement, at:Project, perspective:boolean){
  const w=image.width,h=image.height;
  if(!perspective){
    const a=at(0,1),b=at(1,1),d=at(0,0);
    c.save();c.transform((b.x-a.x)/w,(b.y-a.y)/w,(d.x-a.x)/h,(d.y-a.y)/h,a.x,a.y);
    c.drawImage(image,0,0);c.restore();return;
  }
  // Subdivide both axes for the projective lens. The orthographic path uses one draw.
  for(let j=0;j<6;j++)for(let i=0;i<12;i++){
    const u=i/12,v=j/6,ww=w/12,hh=h/6;
    const a=at(u,1-v),b=at(u+1/12,1-v),d=at(u,1-v-1/6);
    c.save();c.transform((b.x-a.x)/ww,(b.y-a.y)/ww,(d.x-a.x)/hh,(d.y-a.y)/hh,a.x,a.y);
    c.drawImage(image,u*w,v*h,ww,hh,0,0,ww+.4,hh+.4);c.restore();
  }
}
function frame(c:Ctx,at:Project,z:number,color:string,dash:number[]=[]){
  stroke(c,[[0,0],[1,0],[1,1],[0,1],[0,0]].map(([x,y])=>at(x,y,z)),color,1,dash);
}
function grid(c:Ctx,at:Project,z:number,color:string,nx:number,ny:number){
  for(let i=0;i<=nx;i++)stroke(c,[at(i/nx,0,z),at(i/nx,1,z)],color);
  for(let j=0;j<=ny;j++)stroke(c,[at(0,j/ny,z),at(1,j/ny,z)],color);
}
function scale(c:Ctx,x:number,y:number,w:number,colors:string[],limits:readonly number[],unit:string){
  const g=c.createLinearGradient(x,y,x+w,y);
  colors.forEach((color,i)=>g.addColorStop(i/(colors.length-1),color));
  c.fillStyle=g;c.fillRect(x,y,w,3);words(c,String(+limits[0].toPrecision(3)),x,y+14,10,muted,500,'left',true);
  words(c,String(+limits[1].toPrecision(3))+' '+unit,x+w,y+14,10,muted,500,'right',true);
}
function profileTrace(c:Ctx,x:number,y:number,width:number,height:number,state:RolloutView){
  const truth=state.truth;if(!truth)return;
  const row=Math.min(truth.height-1,Math.round(state.row/truth.lod)),start=row*truth.width;
  let low=Infinity,high=-Infinity;
  for(let i=0;i<truth.width;i++){
    if(!Number.isFinite(truth.values[start+i]))continue;
    for(const value of [truth.values[start+i],truth.step===state.base+state.k?state.prediction?.[start+i]:undefined]){
      if(value!==undefined&&Number.isFinite(value)){low=Math.min(low,value);high=Math.max(high,value);}
    }
  }
  if(!Number.isFinite(low))return;
  const drawLine=(values:ArrayLike<number>,color:string,dash:number[])=>{
    let path:Point[]=[];
    for(let i=0;i<truth.width;i++){
      const v=values[start+i];
      if(!Number.isFinite(v)||!Number.isFinite(truth.values[start+i])){if(path.length)stroke(c,path,color,1.6,dash);path=[];continue;}
      path.push({x:x+i/(truth.width-1)*width,y:y+height-(v-low)/(high-low||1)*height});
    }
    if(path.length)stroke(c,path,color,1.6,dash);
  };
  for(const frac of [0,.5,1])stroke(c,[{x,y:y+height*frac},{x:x+width,y:y+height*frac}],'rgba(123,185,208,.20)');
  drawLine(truth.values,blue,[]);if(truth.step===state.base+state.k&&state.prediction)drawLine(state.prediction,'#ffba89',[4,3]);
}
export function createRolloutPlot(surface:HTMLElement,onRow:(r:number)=>void,onStep:(k:number)=>void){
  const canvas=document.createElement('canvas');canvas.className='rollout-plot';canvas.dataset.modelCapture='';
  canvas.setAttribute('role','img');canvas.setAttribute('aria-label','C04 真实切片、模型输出与四帧滑动窗口。拖动旋转，同位置点选剖线。');
  surface.append(canvas);
  const c=canvas.getContext('2d')!, abort=new AbortController(), opt={signal:abort.signal};
  let state:RolloutView|undefined, truthMap:HTMLCanvasElement|undefined, otherMap:HTMLCanvasElement|undefined;
  let truthContours:HTMLCanvasElement|undefined,otherContours:HTMLCanvasElement|undefined;
  let cachedTruth:Slice|undefined,cachedOther:Float32Array|undefined;
  let w=0,h=0,angle=.21,elevation=.96,zoom=1,perspective=false,animation=0;
  let poses:Project[]=[], rail:{x:number;y:number;w:number}|undefined;
  let down:{x:number;y:number;angle:number;elevation:number;dragged:boolean}|undefined;
  function draw(){
    if(!state||!w||!h)return;
    const s=state, truth=s.truth, dpr=canvas.width/w;
    c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,w,h);
    const small=w<580, stacked=small&&h>345, margin=small?14:Math.max(18,w*.028);
    const area=w-2*margin, baseStep=s.base+s.k, unit=s.meta?.units[s.channel]??(s.channel==='p'?'Pa':'m/s');
    const wash=c.createRadialGradient(w*.37,h*.46,3,w*.45,h*.45,w*.60);wash.addColorStop(0,'rgba(0,152,220,.12)');wash.addColorStop(1,'rgba(0,125,183,0)');
    c.fillStyle=wash;c.fillRect(0,0,w,h);
    const top=small?18:Math.max(24,h*.075);
    const gap=small?14:28, leftW=stacked?area:(area-gap)*(s.prediction?.5:.56), rightW=stacked?area:area-gap-leftW;
    const xs=[margin,stacked?margin:margin+leftW+gap], widths=[leftW,rightW];
    const compact=h<325;
    const fifoY=h-(compact?60:small?74:85), floorY=fifoY-24;
    const chartBottom=floorY-22;
    const exact=truth?.step===baseStep;
    poses=[];
    for(let side=0;side<2;side++){
      const x=xs[side],width=widths[side], hasPrediction=side===1&&!!s.prediction, noResult=side===1&&!hasPrediction;
      const sectionTop=stacked?top+side*(chartBottom-top+30)/2:top;
      const rangeY=stacked?sectionTop+(chartBottom-top-30)/2:chartBottom;
      const volumeTop=sectionTop+(stacked?5:small?33:36);
      const plateY=(volumeTop+rangeY)/2;
      const maxWidthByHeight=Math.max(46,(rangeY-volumeTop)/.76);
      const sourceLabel=s.source==='imported'?'导入预测':s.k===0?'模拟初值':'模拟预测';
      const name=side===0?(exact?'C04 真实流场':'C04 归档参照'):hasPrediction?(s.showError?sourceLabel+' · 绝对误差':sourceLabel):'预测切片';
      words(c,name,x,sectionTop,small?15:21,side===0?pale:s.phase===1||s.phase===3?mint:pale,650);
      const waiting=s.loading?'载入中':s.source==='imported'?'等待匹配切片':'模拟切片未载入';
      const desc=side===0?(truth?'step '+truth.step+'  /  '+truth.time_s.toFixed(2)+' s':s.loading?'正在读取归档':'无可用切片'):
        (hasPrediction?'step '+baseStep+'  /  '+(exact?truth!.time_s:(s.meta?.frames[s.meta.modelReferenceFrame].time_s??50.04)+s.k*.06).toFixed(2)+' s':waiting);
      words(c,desc,stacked?x+width:x,stacked?sectionTop:sectionTop+(small?20:24),small?10:12,side===0?blue:muted,500,stacked?'right':'left',true);
      let plateW=Math.min(width*.92,maxWidthByHeight)*zoom;
      if(s.prediction)plateW=Math.min(leftW*.92,rightW*.92,maxWidthByHeight)*zoom;
      const at=projector(x+width/2,plateY,plateW,angle,elevation,perspective);poses.push(at);
      const zmin=truth&&s.meta?(s.meta.axes_m.Z[0]-truth.z_m)/(s.meta.axes_m.X.at(-1)!-s.meta.axes_m.X[0]):-.164;
      const zmax=truth&&s.meta?(s.meta.axes_m.Z.at(-1)!-truth.z_m)/(s.meta.axes_m.X.at(-1)!-s.meta.axes_m.X[0]):.164;
      c.save();c.beginPath();c.rect(x-2,volumeTop-3,width+4,rangeY-volumeTop+2);c.clip();
      grid(c,at,zmin,'rgba(78,175,218,.14)',10,5);
      frame(c,at,zmin,'rgba(100,189,221,.36)');
      for(const [xx,yy] of [[0,0],[1,0],[1,1],[0,1]])stroke(c,[at(xx,yy,zmin),at(xx,yy,zmax)],'rgba(109,203,238,.42)',1,[3,4]);
      if(side===0&&truthMap){projectMap(c,truthMap,at,perspective);if(truthContours)projectMap(c,truthContours,at,perspective);}
      else if(hasPrediction&&otherMap){projectMap(c,otherMap,at,perspective);if(otherContours)projectMap(c,otherContours,at,perspective);}
      else grid(c,at,0,'rgba(77,168,218,.37)',12,6);
      frame(c,at,0,noResult?'#4584a4':'#99e6fd');
      frame(c,at,zmax,'rgba(92,175,216,.40)',[4,5]);
      if(!side&&truth&&s.meta&&!small){
        const min=s.meta.axes_m.X[0],max=s.meta.axes_m.X.at(-1)!;
        for(const m of [0,1,2]){
          const u=(m-min)/(max-min),a=at(u,0,zmin),b=at(u,-.025,zmin);
          stroke(c,[a,b],'#7ca6bd');words(c,String(m)+' m',b.x,b.y+6,9,muted,500,'center',true);
        }
      }
      if(truth&&(!side||hasPrediction)){
        const rowIndex=Math.min(truth.height-1,Math.round(s.row/truth.lod)), fraction=(rowIndex+.5)/truth.height;
        const a=at(0,fraction),b=at(1,fraction);
        stroke(c,[a,b],'#031b29',3);stroke(c,[a,b],mint,1.65,[5,3]);
        for(const p of [a,b]){c.fillStyle=mint;c.beginPath();c.arc(p.x,p.y,2.7,0,Math.PI*2);c.fill();}
      }
      if(noResult&&s.phase===3&&truth){
        const p=at(.5,.5),pw=Math.max(72,plateW*.58),ph=Math.max(27,pw*.23);
        c.fillStyle='#0a2439ef';c.fillRect(p.x-pw/2-6,p.y-ph/2-17,pw+12,ph+25);
        words(c,'归档剖线 · '+waiting,p.x,p.y-ph/2-7,small?9:11,pale,600,'center');
        profileTrace(c,p.x-pw/2,p.y-ph/2,pw,ph,s);
      }else if(noResult){
        const p=at(.52,.54);const tag=s.phase===1?'Decoder':waiting;c.font='600 '+(small?11:13)+'px "Microsoft YaHei",sans-serif';
        const tw=c.measureText(tag).width+16;c.fillStyle='#0b293f';c.fillRect(p.x-tw/2,p.y-12,tw,24);
        words(c,tag,p.x,p.y,small?11:13,s.phase===1?mint:'#b6d4e7',600,'center');
        if(s.phase===1){
          const source=at(.13,.55),out=at(.81,.55);
          words(c,'ẑ, b̂',source.x,source.y,12,blue,700,'center',true);
          stroke(c,[{x:source.x+13,y:source.y},{x:p.x-tw/2-2,y:p.y}],blue,1.5);
          stroke(c,[{x:p.x+tw/2+2,y:p.y},{x:out.x-11,y:out.y}],mint,1.5);
          words(c,s.channel,out.x,out.y,15,mint,700,'center',true);
        }
      }else if(!side&&!small){
        const origin=at(0,0,zmin),xx=at(.21,0,zmin),yy=at(0,.44,zmin),zz=at(0,0,zmax);
        for(const [end,key] of [[xx,'X'],[yy,'Y'],[zz,'Z']] as const){
          stroke(c,[origin,end],blue,1.2);words(c,key,end.x-3,end.y-5,9,pale,600,'right',true);
        }
      }
      c.restore();
      const limits=truth?.range??s.meta?.display_ranges[s.channel];
      if(limits&&!noResult)scale(c,x,rangeY,width,side&&s.showError?errorColors:fieldColors,side&&s.showError?[0,s.errorMax]:limits,unit);
      else if(noResult){
        stroke(c,[{x,y:rangeY},{x:x+width,y:rangeY}],'#34546c',1,[4,5]);
        words(c,'ẑ, b̂   →   Decoder   →   '+s.channel,x,rangeY+14,small?9:11,muted,500,'left',true);
      }
    }
    const rowY=fifoY+12, boxW=small?Math.min(59,area/6.3):Math.min(90,area/6.8), boxH=small?29:34;
    const boardLeft=margin, target=s.base+Math.max(1,s.k), pitch=boxW+Math.min(14,area*.016);
    words(c,'FIFO · L = 4',boardLeft,fifoY-8,small?10:12,s.phase===0||s.phase===2?mint:muted,600,'left',true);
    const after=s.phase===2,before=s.phase===0;
    words(c,after?'写入 step '+target:before?'读取前四帧':s.k?'本步写回后的历史窗':'初始历史窗',boardLeft+Math.min(area*.31,113),fifoY-8,small?10:11,muted);
    const end=after?target:before?target-1:(s.k?target:s.base);
    for(let j=0;j<4;j++){
      const xx=boardLeft+j*pitch, step=end-3+j, future=step>s.base, newest=j===3&&(after||s.k>0&&!before);
      c.fillStyle=newest?'#0875a4':future?'#0b4463':'#10354b';c.fillRect(xx,rowY,boxW,boxH);
      c.fillStyle=newest?mint:future?blue:'#5d99b7';c.fillRect(xx,rowY,3,boxH);
      words(c,String(step),xx+boxW/2,rowY+boxH/2,small?13:17,newest?'#fff':pale,650,'center',true);
      if(j<3)words(c,'›',xx+boxW+(pitch-boxW)/2,rowY+boxH/2,12,muted,600,'center');
    }
    if(after)words(c,'移出 '+(target-4)+'   →   保留三帧   →   写入 '+target,boardLeft,rowY+boxH+13,10,blue,500,'left',true);
    const tx=boardLeft+3*pitch+boxW+Math.min(30,area*.04), tw=w-margin-tx;
    if(tw>53){
      const trackerWidth=!small&&truth?tw*.37:tw;
      words(c,'k '+s.k+' / '+s.horizon,tx,rowY+(small?5:7),small?10:13,pale,600,'left',true);
      const ry=rowY+boxH-4;
      stroke(c,[{x:tx,y:ry},{x:tx+trackerWidth,y:ry}],'#31516b',2);stroke(c,[{x:tx,y:ry},{x:tx+trackerWidth*s.k/s.horizon,y:ry}],blue,2);
      c.fillStyle=blue;c.beginPath();c.arc(tx+trackerWidth*s.k/s.horizon,ry,3.5,0,Math.PI*2);c.fill();
      rail={x:tx,y:ry,w:trackerWidth};
      if(!small&&truth&&s.meta){
        const px=tx+trackerWidth+Math.min(tw*.10,72),pw=w-margin-px;
        words(c,'X 剖线   Y = '+s.meta.axes_m.Y[Math.min(rowLimit(truth),Math.round(s.row/truth.lod)*truth.lod)].toFixed(3)+' m',px,fifoY-8,11,muted,500,'left',true);
        if(s.prediction&&exact)words(c,'真值 ━   '+(s.source==='simulated'?'模拟':'预测')+' ┄',px+pw,fifoY-8,11,pale,500,'right');
        profileTrace(c,px,rowY,pw,boxH-2,s);
      }
    }
  }
  function rowLimit(t:Slice){return (t.height-1)*t.lod;}
  function schedule(){if(!animation)animation=requestAnimationFrame(()=>{animation=0;draw();});}
  function fit(){
    w=canvas.clientWidth;h=canvas.clientHeight;const ratio=Math.min(2,window.devicePixelRatio||1);
    canvas.width=Math.max(1,Math.round(w*ratio));canvas.height=Math.max(1,Math.round(h*ratio));draw();
  }
  const resize=new ResizeObserver(fit);resize.observe(canvas);fit();
  function update(v:RolloutView){
    state=v;
    if(v.truth!==cachedTruth){
      cachedTruth=v.truth;truthMap=v.truth?makeMap(v.truth.values,v.truth,v.truth.range):undefined;
      truthContours=v.truth?contourMap(v.truth.values,v.truth,v.truth.range):undefined;
    }
    const values=v.showError?v.error:v.prediction;
    if(values!==cachedOther){
      cachedOther=values;otherMap=values&&v.truth?makeMap(values,v.truth,v.showError?[0,v.errorMax]:v.truth.range,v.showError):undefined;
      otherContours=values&&v.truth&&!v.showError?contourMap(values,v.truth,v.truth.range):undefined;
    }
    if(v.truth&&v.truth!==lastDrawnTruth){lastDrawnTruth=v.truth;draw();}else schedule();
  }
  let lastDrawnTruth:Slice|undefined;
  function locate(e:PointerEvent){const b=canvas.getBoundingClientRect();return{x:e.clientX-b.left,y:e.clientY-b.top};}
  canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;const p=locate(e);down={...p,angle,elevation,dragged:false};canvas.setPointerCapture(e.pointerId);},opt);
  canvas.addEventListener('pointermove',e=>{if(!down)return;const p=locate(e), dx=p.x-down.x,dy=p.y-down.y;
    if(Math.hypot(dx,dy)>4)down.dragged=true;if(!down.dragged)return;
    angle=Math.max(-1.5,Math.min(1.5,down.angle+dx*.006));elevation=Math.max(.28,Math.min(1.45,down.elevation-dy*.006));schedule();
  },opt);
  canvas.addEventListener('pointercancel',()=>{down=undefined;},opt);
  canvas.addEventListener('pointerup',e=>{
    const drag=down;down=undefined;if(!drag||drag.dragged||!state)return;const p=locate(e);
    if(rail&&Math.abs(p.y-rail.y)<17&&p.x>=rail.x-5&&p.x<=rail.x+rail.w+5){onStep(Math.round((p.x-rail.x)/rail.w*state.horizon));return;}
    const truth=state.truth;if(!truth)return;
    for(const [side,at] of poses.entries()){
      if(side&&!state.prediction)continue;
      // Invert the projective map numerically, then snap to the loaded sample row.
      let u=.5,v=.5;
      for(let i=0;i<6;i++){const q=at(u,v),a=at(u+.001,v),b=at(u,v+.001),ax=a.x-q.x,ay=a.y-q.y,bx=b.x-q.x,by=b.y-q.y;
        const det=ax*by-ay*bx;if(Math.abs(det)<1e-8)break;
        u+=.001*((p.x-q.x)*by-(p.y-q.y)*bx)/det;v+=.001*(ax*(p.y-q.y)-ay*(p.x-q.x))/det;
      }
      if(u>=0&&u<=1&&v>=0&&v<=1){onRow(Math.max(0,Math.min(truth.height-1,Math.floor(v*truth.height)))*truth.lod);break;}
    }
  },opt);
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.62,Math.min(1.65,zoom*Math.exp(-e.deltaY*.001)));schedule();},{...opt,passive:false});
  document.getElementById('reset-camera')?.addEventListener('click',()=>{angle=.21;elevation=.96;zoom=1;schedule();},opt);
  const projection=document.getElementById('projection-toggle');
  projection?.addEventListener('click',()=>{
    perspective=!perspective;
    projection.textContent=perspective?'透视':'正交';
    projection.setAttribute('aria-pressed',String(!perspective));
    projection.title=perspective?'切换为正交视角':'切换为透视视角';projection.setAttribute('aria-label',projection.title);
    schedule();
  },opt);
  return {update,dispose(){cancelAnimationFrame(animation);abort.abort();resize.disconnect();canvas.remove();}};
}
