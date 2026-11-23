import * as T from 'three';
import {loadTruthSlice,loadWakeManifest} from '../wake';
import {Stage} from './shared';
import {caption,ice,muted,type Domain} from './spatial-geometry';

const channelNames=['ũ','ṽ','w̃','p̃'];
const fields=['u','v','w','p'];
const colors=['#061f49','#093e77','#006aa8','#0098dc','#5de5ff','#efffff'].map(c=>new T.Color(c));
function swatch(t:number,color:T.Color){
  const v=T.MathUtils.clamp(t,0,.999999)*(colors.length-1),i=Math.floor(v);
  color.copy(colors[i]).lerp(colors[i+1],v-i).convertLinearToSRGB();
}

/** Normalized inputs use one fixed ±2σ intensity scale in this chapter. */
export function observationPlane(s:Stage,group:T.Group,box:Domain){
  const canvas=document.createElement('canvas'),texture=new T.CanvasTexture(canvas);
  texture.colorSpace=T.SRGBColorSpace;
  const material=new T.MeshBasicMaterial({map:texture,side:T.DoubleSide,transparent:true,opacity:.98,depthWrite:false});
  const field=new T.Mesh(new T.PlaneGeometry(box.w,box.h),material);group.add(field);field.visible=false;
  const legend=s.controls.ownerDocument.createElement('canvas');
  legend.width=128;legend.height=2;const legendCtx=legend.getContext('2d')!,grad=legendCtx.createLinearGradient(0,0,128,0);
  colors.forEach((c,i)=>grad.addColorStop(i/(colors.length-1),'#'+c.getHexString()));legendCtx.fillStyle=grad;legendCtx.fillRect(0,0,128,2);
  const barMap=new T.CanvasTexture(legend);barMap.colorSpace=T.SRGBColorSpace;
  const bar=new T.Mesh(new T.PlaneGeometry(.86,.038),new T.MeshBasicMaterial({map:barMap,side:T.DoubleSide}));
  bar.position.set(box.x,-1.18,.25);group.add(bar);
  const neg=caption(group,'−2σ',[box.x-.61,-1.18,.25],.18,muted),pos=caption(group,'+2σ',[box.x+.61,-1.18,.25],.18,ice);
  const sub=caption(group,'C04 输入切面 · 归一化幅值',[box.x,1.15,0],.23,muted);
  let pending=0,lastKey='',text='正在加载真实输入切面';
  const ctx=canvas.getContext('2d')!,rgb=new T.Color();
  return {
    get caption(){return text;},
    update(z:number,channel:number,done:()=>void){
      const key=z+'-'+channel;
      if(lastKey===key)return;
      lastKey=key;const version=++pending;
      field.visible=bar.visible=neg.visible=pos.visible=sub.visible=false;
      text='';
      if(channel>=4)return;
      const zIndex=z*8+4;
      void loadWakeManifest().then(async m=>{
        const f=m.frames[m.modelReferenceFrame];
        const slice=await loadTruthSlice(m.modelReferenceFrame,fields[channel],zIndex,2);
        if(version!==pending||!s.alive)return;
        const width=slice.width,height=slice.height,norm=Math.max(f.stats6[channel===3?5:4],1e-12),mean=f.stats6[channel];
        canvas.width=width;canvas.height=height;
        const pixels=ctx.createImageData(width,height);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const raw=slice.values[y*width+x],j=((height-y-1)*width+x)*4;
          if(!Number.isFinite(raw))continue;
          const a=((raw-mean)/norm+2)/4;
          swatch(a,rgb);
          pixels.data[j]=Math.round(rgb.r*255);pixels.data[j+1]=Math.round(rgb.g*255);pixels.data[j+2]=Math.round(rgb.b*255);pixels.data[j+3]=255;
        }
        ctx.putImageData(pixels,0,0);texture.needsUpdate=true;
        field.position.set(box.x,0,(slice.zIndex/64-.5)*box.d);
        field.visible=bar.visible=neg.visible=pos.visible=sub.visible=true;
        text=`C04 实际输入 ${channelNames[channel]} · t=${f.time_s.toFixed(2)} s · Z=${slice.zIndex} · 固定范围 −2σ 至 +2σ。`;
        done();s.changed();
      }).catch(()=>{
        if(version!==pending||!s.alive)return;
        text='真实输入切面未加载，显示圆柱 SDF 等距线。';done();s.changed();
      });
    }
  };
}

