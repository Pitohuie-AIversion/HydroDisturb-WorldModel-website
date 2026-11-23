import * as T from 'three';
import {Stage, arrow, line, marker, type Point} from './shared';
import {ordinaryTrajectory, steps, stepSize, teachingVelocity, type Features} from './fm-math';
import {fmColors as color} from './fm-colors';
import {mountFmLesson} from './fm-lesson';
export {createFmFallback} from './fm-plot';
import './fm.css';
import '../fm-presentation.css';

// One affine mapping for knots, background axes and local velocity samples.
const position = (z:Features):Point => [
  -3.23 + (z[0] - .2) * 8.35,
  z[1] * 3.75,
  (z[2] - .18) * 4.4,
];
const floorD1 = -.36;

function plotLabel(root:T.Group,text:string,point:Point,size:number,ink:string) {
  const canvas=document.createElement('canvas');
  const ctx=canvas.getContext('2d')!;
  const font='600 56px "Segoe UI","Microsoft YaHei",sans-serif';
  ctx.font=font;
  canvas.width=Math.ceil(ctx.measureText(text).width)+24;
  canvas.height=86;
  ctx.font=font;
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';
  ctx.lineWidth=7;ctx.strokeStyle='#0a2037';ctx.fillStyle=ink;
  ctx.strokeText(text,canvas.width/2,44);ctx.fillText(text,canvas.width/2,44);
  const map=new T.CanvasTexture(canvas);
  map.colorSpace=T.SRGBColorSpace;
  const sprite=new T.Sprite(new T.SpriteMaterial({map,depthTest:false,depthWrite:false,toneMapped:false}));
  sprite.scale.set(size*canvas.width/canvas.height,size,1);
  sprite.renderOrder=12;
  sprite.position.set(...point);
  root.add(sprite);
  return sprite;
}

function featureGrid(root:T.Group) {
  const base:Features = [.14,floorD1,.01];
  const p = (x:number,y:number,z:number):Point => position([x,y,z]);
  const grid:Point[] = [];
  for (const x of [.2,.4,.6,.8,1]) {
    grid.push(p(x,base[1],base[2]),p(x,.31,base[2]));
    grid.push(p(x,base[1],base[2]),p(x,base[1],.45));
  }
  for (const y of [-.2,0,.2]) grid.push(p(base[0],y,base[2]),p(1.07,y,base[2]));
  for (const z of [.15,.3,.45]) grid.push(p(base[0],base[1],z),p(1.07,base[1],z));
  const geometry=new T.BufferGeometry().setFromPoints(grid.map(v=>new T.Vector3(...v)));
  root.add(new T.LineSegments(geometry,new T.LineBasicMaterial({color:color.grid})));
  const origin=position(base);
  for (const end of [p(1.09,base[1],base[2]),p(base[0],.37,base[2]),p(base[0],base[1],.49)]) {
    line(root,[origin,end],color.axis);
  }
  plotLabel(root,'D0',p(1.11,base[1],base[2]),.24,color.paper);
  plotLabel(root,'D1',p(base[0],.395,base[2]),.24,color.paper);
  plotLabel(root,'D2',p(base[0],base[1]-.06,.49),.24,color.paper);
  for (const x of [.2,.6,1]) plotLabel(root,x.toFixed(1),p(x,base[1]-.05,base[2]),.18,color.muted);
  for (const y of [-.2,0,.2]) plotLabel(root,y.toFixed(1),p(base[0]-.035,y,base[2]),.18,color.muted);
}

/** Drop each Euler knot to its (D0,D2) position on the floor, keeping its depth. */
function projectToFloor(root:T.Group,states:Features[]) {
  const top=states.map(position);
  const floor=states.map(([x,,z])=>position([x,floorD1,z]));
  const vertices:number[]=[], shades:number[]=[], indices:number[]=[];
  const sky=new T.Color(color.brand);
  for(let i=0;i<top.length;i++){
    vertices.push(...top[i],...floor[i]);
    shades.push(sky.r,sky.g,sky.b,.44,sky.r,sky.g,sky.b,.025);
    if(i<top.length-1){
      const a=2*i;
      indices.push(a,a+1,a+2,a+2,a+1,a+3);
    }
  }
  const mesh=new T.BufferGeometry();
  mesh.setAttribute('position',new T.Float32BufferAttribute(vertices,3));
  mesh.setAttribute('color',new T.Float32BufferAttribute(shades,4));
  mesh.setIndex(indices);
  const material=new T.MeshBasicMaterial({
    vertexColors:true,side:T.DoubleSide,transparent:true,depthWrite:false,toneMapped:false,
  });
  const ribbon=new T.Mesh(mesh,material);
  ribbon.renderOrder=-1;
  root.add(ribbon);
  line(root,floor,'#326387');
  const verticals=top.flatMap((p,i)=>[new T.Vector3(...p),new T.Vector3(...floor[i])]);
  root.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(verticals),
    new T.LineBasicMaterial({color:'#286382',transparent:true,opacity:.7})));
}

function selectedKnot(root:T.Group){
  const tile=document.createElement('canvas');
  tile.width=tile.height=128;
  const ctx=tile.getContext('2d')!;
  const glow=ctx.createRadialGradient(64,64,8,64,64,62);
  glow.addColorStop(0,'rgba(0,152,220,.50)');
  glow.addColorStop(1,'rgba(0,152,220,0)');
  ctx.fillStyle=glow;ctx.fillRect(0,0,128,128);
  ctx.strokeStyle=color.paper;ctx.lineWidth=3;
  ctx.beginPath();ctx.arc(64,64,41,0,2*Math.PI);ctx.stroke();
  const map=new T.CanvasTexture(tile);
  map.colorSpace=T.SRGBColorSpace;
  const ring=new T.Sprite(new T.SpriteMaterial({map,depthTest:false,depthWrite:false,toneMapped:false}));
  ring.scale.setScalar(.53);
  ring.renderOrder=6;
  root.add(ring);
  return ring;
}

// Sample a plane through the active state. The short blue glyphs show field
// direction. The selected amber arrow alone encodes the full Euler increment.
function localField(z:Features,tau:number) {
  const vertices:T.Vector3[]=[];
  const side=new T.Vector3(),direction=new T.Vector3(),normal=new T.Vector3(0,0,1);
  for (const x of [.2,.36,.52,.68,.84,1]) for (const y of [-.28,-.12,.04,.20]) {
    const start:Features=[x,y,z[2]];
    const v=teachingVelocity(start,tau);
    const end:Features=[start[0]+stepSize*v[0],start[1]+stepSize*v[1],start[2]+stepSize*v[2]];
    const a=new T.Vector3(...position(start)),b=new T.Vector3(...position(end));
    direction.subVectors(b,a).normalize();
    side.crossVectors(direction,normal).normalize();
    b.copy(a).addScaledVector(direction,.30);
    const base=b.clone().addScaledVector(direction,-.07);
    vertices.push(a,b,b,base.clone().addScaledVector(side,.033),b,base.clone().addScaledVector(side,-.033));
  }
  return new T.LineSegments(new T.BufferGeometry().setFromPoints(vertices),
    new T.LineBasicMaterial({color:color.samples,transparent:true,opacity:.59,depthWrite:false}));
}

export function flowMatching(s:Stage) {
  const {states}=ordinaryTrajectory();
  const vectors=states.map(z=>new T.Vector3(...position(z)));
  const surface=document.getElementById('canvas-shell')!;
  // This chapter uses the calibrated feature grid as its backdrop.
  s.root.children.forEach(child=>child.visible=false);
  featureGrid(s.root);
  projectToFloor(s.root,states);
  const floorKey=document.createElement('span');
  floorKey.innerHTML='<i class="fm-floor-key"></i>底面投影';
  floorKey.title='蓝带连接各个潜状态及其在 D0–D2 底面的位置';
  document.getElementById('legend')?.append(floorKey);
  const segments=states.slice(0,-1).map((z,k)=>{
    const a=position(z), b=position(states[k+1]);
    const future=line(s.root,[a,b],color.prospective,true);
    const done=arrowLine(a,b);
    const active=new T.Group();
    arrow(active,a,b,color.active,.038);
    const field=localField(z,k*stepSize);
    s.root.add(done,active,field);
    return {future,done,active,field};
  });
  function arrowLine(a:Point,b:Point) {
    const start=new T.Vector3(...a),end=new T.Vector3(...b);
    const delta=end.clone().sub(start);
    const stroke=new T.Mesh(new T.CylinderGeometry(.023,.023,delta.length(),10),new T.MeshBasicMaterial({color:color.complete}));
    stroke.position.copy(start).lerp(end,.5);
    stroke.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),delta.normalize());
    return stroke;
  }
  const knots=vectors.map((v,i)=>{
    const dot=marker(s.root,color.complete,i===0||i===steps?.095:.066);
    dot.position.copy(v);
    return dot;
  });
  const cursor=marker(s.root,'#fff5e3',.085);
  const selection=selectedKnot(s.root);
  const startLabel=plotLabel(s.root,'当前 zₖ',[0,0,0],.25,color.paper);
  const endLabel=plotLabel(s.root,'下一状态 zₖ₊₁',[0,0,0],.25,color.active);
  const finalLabel=plotLabel(s.root,'τ = 1 · 输出 ẑₜ₊₁',[0,0,0],.26,color.paper);
  finalLabel.position.copy(vectors[steps]).y+=.30;
  const lesson=mountFmLesson(s.controls,surface,s.changed,({k,fraction,phase,atEnd})=>{
    segments.forEach(({future,done,active,field},i)=>{
      future.visible=i>k||(i===k&&phase<2&&!atEnd);
      done.visible=i<k||atEnd;
      active.visible=i===k&&phase>=2&&!atEnd;
      field.visible=i===k&&phase===2&&!atEnd;
    });
    knots.forEach((dot,i)=>{
      const destination=(atEnd&&i===steps)||(!atEnd&&i===k+1&&phase>=2);
      dot.material.color.set(destination?color.active:i===k?color.paper:i<k||atEnd?color.complete:color.prospective);
      dot.scale.setScalar(i===k||i===k+1?1.32:1);
    });
    cursor.position.lerpVectors(vectors[k],vectors[k+1],fraction);
    cursor.visible=!atEnd&&fraction>.025&&fraction<.975;
    selection.position.copy(cursor.position);
    const up=vectors[k+1].y>=vectors[k].y?1:-1;
    startLabel.position.copy(vectors[k]);startLabel.position.y-=up*.32;
    endLabel.position.copy(vectors[k+1]);endLabel.position.y+=up*.32;
    startLabel.visible=!atEnd;
    endLabel.visible=!atEnd&&phase>=2;
    finalLabel.visible=atEnd;
  }, 'D0 · D1 · D2 三维投影');
  knots.forEach((dot,i)=>s.targets.set(dot,()=>lesson.seek(i/steps)));
  s.animate=lesson.update;
  s.onDispose=()=>{
    lesson.dispose();
    floorKey.remove();
  };
}
