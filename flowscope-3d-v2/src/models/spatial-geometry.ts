import * as T from 'three';
import {Stage,type Point} from './shared';
import {readFocus,writeFocus} from './focus';

export const blue='#0098dc', ice='#a8edff', white='#edfaff', amber='#ffc467', muted='#73aaca', navy='#073553';
export type Focus=ReturnType<typeof readFocus>;

export function stroke(parent:T.Object3D,pairs:number[],color:string,opacity=1){
  const geo=new T.BufferGeometry();
  geo.setAttribute('position',new T.Float32BufferAttribute(pairs,3));
  const mat=new T.LineBasicMaterial({color,transparent:opacity<1,opacity,depthWrite:false});
  const obj=new T.LineSegments(geo,mat);parent.add(obj);return obj;
}

export function segments(points:Point[]){
  const coords:number[]=[];
  for(let i=1;i<points.length;i++)coords.push(...points[i-1],...points[i]);
  return coords;
}

export function caption(parent:T.Object3D,title:string,position:Point,size=.24,color=white){
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d')!;
  const font='600 64px "Segoe UI", "Microsoft YaHei", sans-serif';
  ctx.font=font;
  canvas.width=Math.ceil(ctx.measureText(title).width)+24; canvas.height=96;
  ctx.font=font;ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
  ctx.strokeStyle='#041d32';ctx.lineWidth=8;ctx.strokeText(title,canvas.width/2,50);
  ctx.fillStyle=color;ctx.fillText(title,canvas.width/2,50);
  const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;
  const sprite=new T.Sprite(new T.SpriteMaterial({map:tex,depthTest:false,depthWrite:false}));
  sprite.position.set(...position);sprite.scale.set(size*canvas.width/canvas.height,size,1);
  sprite.renderOrder=18;parent.add(sprite);return sprite;
}

export function plate(parent:T.Object3D,w:number,h:number,d:number,tint:string,opacity:number){
  const geo=new T.BoxGeometry(w,h,d);
  const body=new T.Mesh(geo,new T.MeshBasicMaterial({color:tint,transparent:true,opacity,depthWrite:false}));
  const edges=new T.LineSegments(new T.EdgesGeometry(geo),new T.LineBasicMaterial({color:tint,transparent:true,opacity:Math.min(1,opacity+.4),depthWrite:false}));
  body.add(edges);parent.add(body);return body;
}

export interface Domain{x:number;w:number;h:number;d:number}

export function blockCenter(box:Domain,f:Focus):Point{
  return [box.x+((f.x+.5)/24-.5)*box.w,((f.y+.5)/12-.5)*box.h,((f.z+.5)/8-.5)*box.d];
}
export function tokenBounds(f:Focus){
  return `Z ${8*f.z}–${8*f.z+7} · Y ${8*f.y}–${8*f.y+7} · X ${8*f.x}–${8*f.x+7}`;
}

export function cylinder(parent:T.Object3D,box:Domain){
  const radius=box.w/24,center=box.x-box.w/3;
  const solid=new T.Mesh(new T.CylinderGeometry(radius,radius,box.d+.014,48),new T.MeshStandardMaterial({color:'#469ab9',metalness:.38,roughness:.52}));
  solid.rotation.x=Math.PI/2;solid.position.x=center;parent.add(solid);
  const ring:number[]=[];
  for(const z of [-box.d/2-.011,box.d/2+.011]){
    const loop:Point[]=Array.from({length:65},(_,i)=>[center+radius*Math.cos(i*Math.PI/32),radius*Math.sin(i*Math.PI/32),z]);
    ring.push(...segments(loop));
  }
  stroke(parent,ring,ice,.87);
}

export function domainFrame(parent:T.Object3D,box:Domain){
  const edges=new T.EdgesGeometry(new T.BoxGeometry(box.w,box.h,box.d));
  const boxLines=new T.LineSegments(edges,new T.LineBasicMaterial({color:'#3e89ad',opacity:.57,transparent:true,depthWrite:false}));
  boxLines.position.x=box.x;parent.add(boxLines);
}

export function focusSlice(s:Stage,parent:T.Group,box:Domain,select:(f:Focus)=>void){
  const plane=new T.Mesh(new T.PlaneGeometry(box.w,box.h),new T.MeshBasicMaterial({color:blue,side:T.DoubleSide,transparent:true,opacity:0,depthWrite:false}));
  plane.position.x=box.x;parent.add(plane);
  const marker=plate(parent,box.w/24,box.h/12,box.d/8,amber,.42);
  const ticks:number[]=[];
  const dx=box.w/48+.035,dy=box.h/24+.035;
  for(const i of [-1,1])for(const j of [-1,1]){
    const x=i*dx,y=j*dy;
    ticks.push(x-i*.055,y,.006,x,y,.006,x,y,.006,x,y-j*.055,.006);
  }
  const registration=stroke(marker,ticks,white);registration.position.z=box.d/16;
  function update(f:Focus){
    const p=blockCenter(box,f);
    marker.position.set(...p);plane.position.z=p[2];
  }
  s.targets.set(plane,hit=>{
    const p=parent.worldToLocal(hit.point.clone()),f=readFocus();
    const x=T.MathUtils.clamp(Math.floor(((p.x-box.x)/box.w+.5)*24),0,23);
    const y=T.MathUtils.clamp(Math.floor((p.y/box.h+.5)*12),0,11);
    // Ignore solid cylinder centers using the same physical X/Y domain as C04.
    if(Math.hypot((x+.5)*.15-.6,(y+.5)*.15-.9)<=.15)return;
    writeFocus({...f,x,y});select(readFocus());s.changed();
  });
  update(readFocus());return update;
}

export function registerSteps(s:Stage,choose:(index:number)=>void){
  const panel=s.controls.parentElement!;
  const listener=(event:Event)=>{
    const index=(event as CustomEvent<{index:number}>).detail?.index;
    if(Number.isInteger(index)&&index>=0&&index<4){choose(index);s.changed();}
  };
  panel.addEventListener('flowscope-process-select',listener);
  const prior=s.onDispose;
  s.onDispose=()=>{prior?.();panel.removeEventListener('flowscope-process-select',listener);};
}
export function reportStep(s:Stage,index:number){
  s.controls.dispatchEvent(new CustomEvent('flowscope-process-state',{bubbles:true,detail:{index}}));
}

export function cleanStage(s:Stage){
  for(const child of s.root.children)child.visible=false;
}

