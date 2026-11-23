import * as T from 'three';
import {Stage,buttons,check,range,selectButton,type Point} from './shared';
import {readFocus,writeFocus} from './focus';
import {archivedMaskPlane} from './spatial-masks';
import {amber,blue,ice,white,muted,caption,plate,stroke,segments,cleanStage,domainFrame,cylinder,focusSlice,tokenBounds,registerSteps,reportStep} from './spatial-geometry';

const domain={x:1.53,w:4.64,h:2.32,d:1.55};
const {w,h,d}=domain,scale=w/3.6;
const originX=domain.x-w/3, radius=.15, delta=.01875;
const pos=(x:number,y:number,z:number):Point=>[originX+x*scale,y*scale,z];
function psi(x:number,y:number){
  const aroundCylinder=y*(1-radius*radius/(x*x+y*y));
  // Smoothly switch on a synthetic downstream disturbance beyond the cylinder.
  const downstream=Math.max(0,x-.24),onset=1-Math.exp(-6*downstream*downstream);
  return aroundCylinder+.17*onset*Math.exp(-y*y/.16)*Math.sin(5.8*downstream);
}
function curl(x:number,y:number){
  return [(psi(x,y+delta)-psi(x,y-delta))/(2*delta),-(psi(x+delta,y)-psi(x-delta,y))/(2*delta)];
}
// The displayed streamfunction is analytic, steady and extruded along Z. The
// center differences above give u and v; this planar example has w=0.
function streamline(seed:number,z:number):Point[]{
  const path:Point[]=[];let x=-.6,y=seed;
  const dx=.03;
  for(let k=0;k<=120;k++,x+=dx){
    path.push(pos(x,y,z));
    const [u,v]=curl(x,y);
    const midY=y+.5*dx*v/Math.max(.015,u);
    const [um,vm]=curl(x+dx/2,midY);
    y+=dx*vm/Math.max(.015,um);
  }
  return path;
}

function potentialContours(group:T.Group){
  const coords:number[]=[];
  // Equal contour intervals in the demonstration vector potential A=(0,0,ψ).
  for(let level=-.7;level<=.701;level+=.07){
    if(Math.abs(level)<.02)continue;
    const path:Point[]=[];
    for(let k=0;k<=65;k++){
      const x=-.60+k*1.6/65;
      let y=Math.sign(level)*Math.max(Math.abs(level),.16);
      for(let n=0;n<10;n++){
        const den=x*x+y*y;
        const derivative=1+radius*radius*(y*y-x*x)/(den*den);
        const error=psi(x,y)-level;
        y-=error/Math.max(.15,derivative);
      }
      path.push(pos(x,y,-d/2));
    }
    coords.push(...segments(path));
  }
  return stroke(group,coords,'#66d9ff',.92);
}

function readoutField(group:T.Group){
  const flowPts:number[]=[],colors:number[]=[],glints:number[]=[],vectors:number[]=[];
  const dark=new T.Color('#126b9b'),light=new T.Color('#b0f8ff'),tint=new T.Color();
  const sliceDepths=[-.66,-.17,.62];
  const orbitPaths:Point[][]=[];
  const ribbonVertices:number[]=[],ribbonColors:number[]=[];
  sliceDepths.forEach((z,zi)=>{
    for(let i=0;i<25;i++){
      const seed=(i-12)*.068;
      if(Math.abs(seed)<.015)continue;
      const p=streamline(seed,z);
      const edge=Math.max(0,1-Math.abs(seed)/.84),front=(zi+1)/3;
      for(let k=1;k<p.length;k++){
        flowPts.push(...p[k-1],...p[k]);
        const near=Math.exp(-Math.abs(p[k][0]-originX)*.85);
        const selected= i%4===1 || i%4===3&&zi===4;
        const lum=(selected?.20:.025)+.20*near+.18*front+.10*edge;
        tint.copy(dark).lerp(light,Math.min(1,lum));
        colors.push(tint.r,tint.g,tint.b,tint.r,tint.g,tint.b);
      }
      if([7,10,14,17].includes(i)){
        const neighbor=streamline(seed+.036,z),shade=new T.Color();
        for(let k=1;k<p.length;k++){
          ribbonVertices.push(...p[k-1],...p[k],...neighbor[k],...p[k-1],...neighbor[k],...neighbor[k-1]);
          const slope=Math.min(1,Math.abs(p[k][1]-p[k-1][1])/.022);
          shade.set(zi===2?'#0098dc':'#065390').lerp(new T.Color(zi===2?'#bcefff':'#4cb8ec'),.18+.76*slope);
          for(let j=0;j<6;j++)ribbonColors.push(shade.r,shade.g,shade.b);
        }
      }
      if(zi===2&&(i===10||i===14||i===5||i===19)){
        glints.push(...segments(p));
        orbitPaths.push(p);
        for(const k of [8,18,39,65,91,111]){
          const [x,y,z0]=p[k],angle=Math.atan2(p[k+1][1]-y,p[k+1][0]-x);
          const len=.085;
          for(const a of [angle+.5,angle-.5])vectors.push(x-len*Math.cos(a),y-len*Math.sin(a),z0+.015,x,y,z0+.015);
        }
      }
    }
  });
  const field=stroke(group,flowPts,white);
  field.geometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));field.material.vertexColors=true;
  const ribbons=new T.BufferGeometry();
  ribbons.setAttribute('position',new T.Float32BufferAttribute(ribbonVertices,3));
  ribbons.setAttribute('color',new T.Float32BufferAttribute(ribbonColors,3));
  const surface=new T.Mesh(ribbons,new T.MeshBasicMaterial({side:T.DoubleSide,vertexColors:true,transparent:true,opacity:.94,depthWrite:false}));
  group.add(surface);
  stroke(group,glints,ice,.94);stroke(group,vectors,white,.98);
  return orbitPaths;
}

function expansion(group:T.Group){
  const bounds:{x:number;w:number;h:number}[]=[];
  for(let i=0;i<4;i++){
    const x=-3.92+i*.88,w=.24+i*.155,h=.46+i*.37;
    bounds.push({x,w,h});
    const pane=plate(group,w,h,.07,i===0?ice:blue,.48);pane.position.set(x,.02,0);pane.rotation.y=-.56;
    const grid:number[]=[],n=2**(i+1);
    for(let j=1;j<n;j++){const v=j/n-.5;grid.push(v*w,-h/2,.038,v*w,h/2,.038,-w/2,v*h,.038,w/2,v*h,.038);}
    stroke(pane,grid,ice,.72);
    caption(group,i===0?'z':'×2',[x,-1.22,.06],.20,i===0?ice:muted);
  }
  const conduit:number[]=[];
  for(let i=0;i<3;i++)for(const offset of [-.48,-.24,0,.24,.48]){
    const a=bounds[i],b=bounds[i+1];
    conduit.push(a.x+.11,.02+a.h*offset,0,b.x-.13,.02+b.h*offset,0);
  }
  stroke(group,conduit,blue,.85);
  caption(group,'C2S 空间展开',[-2.76,1.19,0],.29,white);
  caption(group,'C256 → C128 → C64 → C32',[-2.76,.91,0],.20,muted);
}

function differentiateMask(group:T.Group){
  const excluded:number[]=[]; const step=.01875;
  for(const z of [d/2+.021,-d/2-.018]){
    for(let ix=-10;ix<10;ix++)for(let iy=-10;iy<10;iy++){
      const x=(ix+.5)*step,y=(iy+.5)*step;
      if(Math.hypot(x,y)<=radius)continue;
      if([[1,0],[-1,0],[0,1],[0,-1]].every(([a,b])=>Math.hypot(x+a*step,y+b*step)>radius))continue;
      const [xx,yy,zz]=pos(x,y,z);
      excluded.push(xx-.009,yy,zz,xx+.009,yy,zz,xx,yy-.009,zz,xx,yy+.009,zz);
    }
  }
  stroke(group,excluded,amber);
}

const stages=[
  ['空间展开','三级 C2S 将潜网格逐轴放大 2 倍，恢复到 64 × 96 × 192。相邻通道依次填入八个子格。'],
  ['矢量势 → 速度','示例取 A*=(0,0,ψ)，在内部格点做中心差分。ũ = Dᵧψ，ṽ = −Dₓψ，本例 w̃ = 0。压力由独立分支给出。'],
  ['恢复物理单位','b 提供 μu、μv、μw、μp、σuvw、σp。速度场共用 σuvw，压力使用独立尺度 σp。'],
  ['筛选有效区域','C04 当前切面用蓝色标出有效流体，金色标出可读出场值但不满足导数模板的格点。圆柱邻域还用十字标注了缺失邻点的位置。'],
];

export function decoder(s:Stage){
  cleanStage(s);
  const root=s.root,c2s=new T.Group(),operator=new T.Group(),stats=new T.Group(),mask=new T.Group();
  const inputStage=new T.Group(),physicalStage=new T.Group();
  root.add(inputStage,physicalStage);inputStage.add(c2s);physicalStage.add(operator,stats,mask);expansion(c2s);
  const frame=new T.Group(),field=new T.Group();physicalStage.add(frame,field);
  domainFrame(frame,domain);cylinder(frame,domain);
  const paths=readoutField(field);potentialContours(operator);differentiateMask(mask);
  // A separate pressure wire joins the statistics at the physical readout.
  const bypass:Point[]=[[-1.31,.78,-.05],[-1.14,1.28,-.13],[-.65,1.42,-.13],[2.95,1.42,-.13],[3.69,1.16,-.13]];
  stroke(operator,segments(bypass),'#4aafd6',.9);
  caption(operator,'p̃ · 压力支路',[1.22,1.50,-.13],.23,ice);
  caption(physicalStage,'u · v · w · p',[3.00,1.64,-.13],.27,white);
  // Six taps at the baseline identify the independent affine readout statistics.
  for(let i=0;i<6;i++){
    const body=plate(stats,.115,.115,.052,i<4?ice:amber,.9);
    body.position.set(-.74+i*.145,-1.51,-.04);
  }
  caption(stats,'b[6]',[-1.11,-1.50,-.04],.21,amber);
  stroke(stats,segments([[.13,-1.51,-.04],[2.78,-1.51,-.04],[3.56,-1.13,.12]]),amber,.92);
  const tracer=new T.InstancedMesh(new T.SphereGeometry(.025,8,5),new T.MeshBasicMaterial({color:ice}),paths.length*2);
  frame.add(tracer);const particle=new T.Object3D();
  function trace(p:number){
    for(let i=0;i<paths.length;i++)for(let k=0;k<2;k++){
      const path=paths[i],t=((p*2+.19*i+.5*k)%1)*(path.length-1),j=Math.floor(t);
      particle.position.set(...path[j]).lerp(new T.Vector3(...path[Math.min(j+1,path.length-1)]),t-j);
      particle.updateMatrix();tracer.setMatrixAt(2*i+k,particle.matrix);
    }
    tracer.instanceMatrix.needsUpdate=true;
  }
  s.controls.innerHTML='<h3>物理解码</h3>'+buttons(['C2S','Curl','统计','掩码'],'decoder-step')+
    check('三级通道到空间重排','c2s')+check('矢量势与 Curl / 压力支路','curl')+check('六维统计旁路','stats')+check('差分边界标记','mask')+
    range('追踪块的 Z 层',0,7,readFocus().z,'focus-z')+'<div class="mc-reading"></div>';

  const layers={c2s,curl:operator,stats,mask};
  const input=s.get<HTMLInputElement>('[data-range=focus-z]');
  const track=focusSlice(s,physicalStage,domain,()=>refresh());
  const showBoundary=archivedMaskPlane(s,mask,domain,true);
  // Draw a full-size halo on the plane of the currently inspected operator.

  const pulse:Point[][]=[
    [[-3.98,-.44,0],[-3.98,-.61,0],[-1.27,-1.06,0],[-1.27,-.91,0]],
    [[-.37,-.28,d/2+.025],[-.37,-.35,d/2+.025],[.32,-.35,d/2+.025],[.32,-.28,d/2+.025]],
    [[-.84,-1.6,-.04],[-.84,-1.67,-.04],[.11,-1.67,-.04],[.11,-1.6,-.04]],
  ];
  const stepLabels=[
    '通道 → 八个子格', 'ũ = Dᵧ A*z     ṽ = −Dₓ A*z', 'Û = μ + σuvw · Ũ', '金色十字 · 模板越界',
  ].map(value=>caption(physicalStage,value,[1.34,-1.78,.0],.22,ice));
  const brackets=pulse.map((points,i)=>stroke(i===0?inputStage:physicalStage,segments(points),amber));
  let current=0,manualAt=-1,progress=0,compact=false;
  const host=document.getElementById('canvas-shell')??document.getElementById('viewport')!;
  function layout(){
    const bounds=host.getBoundingClientRect();
    compact=bounds.width<620&&bounds.width/bounds.height<1.38;
    const sourceScale=!compact?1:current===0?1.68:1.22;
    const fieldScale=!compact?1:current===0?1.46:1.68;
    inputStage.scale.setScalar(sourceScale);physicalStage.scale.setScalar(fieldScale);
    inputStage.position.set(compact?2.62*sourceScale:0,compact?2.12:0,0);
    physicalStage.position.set(compact?-1.50*fieldScale:0,compact?-1.49:0,0);
    s.changed();
  }
  function refresh(){
    const f=readFocus();track(f);showBoundary(f,current===3);input.value=String(f.z);s.get('[data-out=focus-z]').textContent=String(f.z);
    const key=Object.keys(layers)[current] as keyof typeof layers;
    stepLabels.forEach((label,i)=>label.visible=i===current);
    field.traverse(object=>{
      const mat=(object as T.Mesh).material as T.Material|undefined;
      if(!mat)return;
      const tone=mat.userData.flowOpacity??mat.opacity;mat.userData.flowOpacity=tone;
      mat.transparent=true;mat.opacity=tone*(current===3?.18:1);mat.depthWrite=false;
    });
    brackets.forEach((b,i)=>b.visible=current===i&&layers[key].visible);
    s.get('.mc-reading').innerHTML=`<b>${stages[current][0]}</b><span>${stages[current][1]}</span><p>同一 Token (${f.z}, ${f.y}, ${f.x}) → 物理格点 ${tokenBounds(f)}。点击流体区可移动追踪块。</p><p>矢量势和流线采用含下游周期扰动的解析示例演示离散 Curl，未加载训练模型场。</p>`;
  }
  function select(i:number,manual=false){
    if(manual)manualAt=progress;
    current=i;layout();selectButton(s.controls,'decoder-step',i);refresh();reportStep(s,i);
  }
  for(const [id,group] of Object.entries(layers)){
    const box=s.get<HTMLInputElement>('[data-flag='+id+']');
    s.on(box,'change',()=>{group.visible=box.checked;refresh();s.changed();});
  }
  s.on(input,'input',()=>{writeFocus({...readFocus(),z:input.valueAsNumber});refresh();s.changed();});
  s.controls.querySelectorAll<HTMLButtonElement>('[data-decoder-step]').forEach((button,i)=>s.on(button,'click',()=>{select(i,true);s.changed();}));
  registerSteps(s,i=>select(i,true));select(0);trace(0);
  const observer=new ResizeObserver(layout);observer.observe(host);const prior=s.onDispose;
  s.onDispose=()=>{prior?.();observer.disconnect();};
  s.animate=p=>{progress=p;const i=Math.min(3,Math.floor(p*4));if(i!==current&&(manualAt<0||Math.abs(p-manualAt)>.16))select(i);trace(p);};
}

