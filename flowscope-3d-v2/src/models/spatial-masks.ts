import * as T from 'three';
import {loadWakeManifest,type WakeFrame} from '../wake';
import {Stage} from './shared';
import {type Domain,type Focus} from './spatial-geometry';

type Kind='valid'|'derivative';
const requests=new Map<string,Promise<Uint8Array>>();
function loadMask(frame:WakeFrame,kind:Kind){
  const file=frame.assets.masks[kind];
  const previous=requests.get(file.path);
  if(previous)return previous;
  const fetchMask=(async()=>{
    const result=await fetch(new URL('./data/'+file.path,document.baseURI));
    if(!result.ok)throw Error('C04 掩码未加载');
    const bytes=await result.arrayBuffer();
    if(bytes.byteLength!==file.bytes)throw Error('C04 掩码文件大小不符');
    if(globalThis.crypto?.subtle){
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      if(Array.from(hash,n=>n.toString(16).padStart(2,'0')).join('')!==file.sha256)throw Error('C04 掩码校验失败');
    }
    const raw=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    if(raw.length!==64*96*192/8)throw Error('C04 掩码形状不符');
    return raw;
  })().catch(error=>{requests.delete(file.path);throw error;});
  requests.set(file.path,fetchMask);return fetchMask;
}
const getBit=(data:Uint8Array,id:number)=>(data[id>>3]>>(id&7))&1;

export function archivedMaskPlane(s:Stage,parent:T.Object3D,box:Domain,stencil:boolean){
  const canvas=document.createElement('canvas');canvas.width=192;canvas.height=96;
  const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;tex.magFilter=T.NearestFilter;
  const mat=new T.MeshBasicMaterial({map:tex,side:T.DoubleSide,transparent:true,depthWrite:false});
  const plane=new T.Mesh(new T.PlaneGeometry(box.w,box.h),mat);parent.add(plane);plane.visible=false;
  let valid:Uint8Array|undefined,derivative:Uint8Array|undefined,lastZ=-1,focus:Focus|undefined,enabled=false;
  function redraw(){
    if(!focus)return;
    plane.visible=enabled&&!!valid&&(!stencil||!!derivative);
    if(!plane.visible||!valid)return;
    const z=focus.z*8+4;
    if(z===lastZ)return;
    lastZ=z;
    plane.position.set(box.x,0,(z/64-.5)*box.d+.002);
    const ctx=canvas.getContext('2d')!,img=ctx.createImageData(192,96);
    for(let y=0;y<96;y++)for(let x=0;x<192;x++){
      const id=(z*96+y)*192+x,ofs=4*((95-y)*192+x),fluid=getBit(valid,id);
      const missing=stencil&&fluid&&derivative&&!getBit(derivative,id);
      const c=fluid?(missing?[255,186,67,255]:[0,152,220,stencil?82:136]):[13,34,54,225];
      img.data.set(c,ofs);
    }
    ctx.putImageData(img,0,0);tex.needsUpdate=true;
  }
  void loadWakeManifest().then(async m=>{
    const frame=m.frames[m.modelReferenceFrame];
    [valid,derivative]=await Promise.all([loadMask(frame,'valid'),stencil?loadMask(frame,'derivative'):Promise.resolve(undefined)]);
    if(!s.alive)return;redraw();s.changed();
  }).catch(()=>{if(s.alive)plane.visible=false;});
  return (f:Focus,on:boolean)=>{focus=f;enabled=on;redraw();};
}

