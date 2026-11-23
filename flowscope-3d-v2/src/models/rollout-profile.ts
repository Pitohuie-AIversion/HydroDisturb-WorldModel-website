import type { WakeManifest } from '../wake';
import type { Slice } from './rollout-plot';

export function drawRolloutProfile(canvas:HTMLCanvasElement, caption:HTMLElement, truth:Slice|undefined, prediction:Float32Array|undefined, row:number, meta:WakeManifest|undefined, channel:string, exact:boolean){
  const width=canvas.clientWidth;
  if(!width)return;
  const height=118,dpr=Math.min(devicePixelRatio||1,2);
  canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
  const c=canvas.getContext('2d')!;c.scale(dpr,dpr);c.clearRect(0,0,width,height);
  if(!truth||!meta){caption.textContent='读取真实切片后显示沿 X 的剖面。';return;}
  const j=Math.min(truth.height-1,Math.round(row/truth.lod)), count=truth.width,start=j*count;
  const xVals=meta.axes_m.X,xMin=xVals[0],xMax=xVals[(count-1)*truth.lod],unit=meta.units[channel];
  const peak=(arr:ArrayLike<number>)=>{
    let value=-Infinity, idx=-1;
    for(let i=0;i<count;i++){const n=start+i;if(!Number.isFinite(truth.values[n]))continue;const v=arr[n];if(v>value&&Number.isFinite(v)){value=v;idx=i;}}
    return idx<0?undefined:{value,x:xVals[idx*truth.lod]};
  };
  const left=38,right=width-9,top=17,bottom=height-23;
  // One range for both profiles; include out-of-range imported samples instead of clipping peaks.
  let lo=truth.range[0],hi=truth.range[1];
  for(let i=0;i<count;i++){
    const n=start+i;if(!Number.isFinite(truth.values[n]))continue;
    const a=truth.values[n],b=prediction?.[n];lo=Math.min(lo,a);hi=Math.max(hi,a);
    if(b!==undefined&&Number.isFinite(b)){lo=Math.min(lo,b);hi=Math.max(hi,b);}
  }
  const posX=(x:number)=>left+(x-xMin)/(xMax-xMin)*(right-left);
  const posY=(v:number)=>bottom-(v-lo)/(hi-lo||1)*(bottom-top);
  c.font='10px Consolas,"Microsoft YaHei",monospace';c.fillStyle='#4c6e85';c.textAlign='left';
  c.fillText(unit,left,11);
  for(let tick=0;tick<3;tick++){
    const v=lo+(hi-lo)*tick/2,y=posY(v);
    c.strokeStyle='#d3e4ee';c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();
    c.textAlign='right';c.fillText(String(+v.toPrecision(2)),left-4,y+3);
  }
  c.textAlign='left';c.fillText(xMin.toFixed(2),left,bottom+16);
  c.textAlign='right';c.fillText(xMax.toFixed(2)+' m',right,bottom+16);
  c.textAlign='center';c.fillText('X', (left+right)/2,bottom+16);
  function path(arr:ArrayLike<number>,color:string,dash:number[]){
    c.beginPath();let gap=true;
    for(let i=0;i<count;i++){
      const n=start+i,v=arr[n];
      if(!Number.isFinite(truth!.values[n])||!Number.isFinite(v)){gap=true;continue;}
      const x=posX(xVals[i*truth!.lod]),y=posY(v);
      if(gap)c.moveTo(x,y);else c.lineTo(x,y);
      gap=false;
    }
    c.strokeStyle=color;c.lineWidth=2;c.setLineDash(dash);c.stroke();c.setLineDash([]);
    const p=peak(arr);
    if(p){c.fillStyle=color;c.beginPath();c.arc(posX(p.x),posY(p.value),2.7,0,Math.PI*2);c.fill();}
    return p;
  }
  const a=path(truth.values,'#0076ae',[]),b=prediction?path(prediction,'#a24d33',[5,3]):undefined;
  const y=meta.axes_m.Y[j*truth.lod],fmt=(n:number)=>String(+n.toPrecision(4));
  caption.textContent='Y = '+y.toFixed(3)+' m · '+(a?(exact?'真值峰值 ':'前档参照峰值 ')+fmt(a.value)+' '+unit+'，X = '+a.x.toFixed(3)+' m。':'该行无有效样本。')+
    (a&&b?' 预测峰值 '+fmt(b.value)+' '+unit+'，X = '+b.x.toFixed(3)+' m。峰值差 '+fmt(b.value-a.value)+' '+unit+'，峰位 ΔX = '+(b.x-a.x).toFixed(3)+' m。':'');
}
