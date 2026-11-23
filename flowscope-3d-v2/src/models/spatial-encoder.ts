import * as T from 'three';
import {Stage,buttons,range,selectButton} from './shared';
import {readFocus,writeFocus} from './focus';
import {observationPlane} from './spatial-observation';
import {archivedMaskPlane} from './spatial-masks';
import {amber,blue,ice,white,muted,caption,plate,stroke,segments,cleanStage,domainFrame,cylinder,focusSlice,tokenBounds,blockCenter,registerSteps,reportStep,type Focus} from './spatial-geometry';

const layers=[
  {name:'Stem',shape:[64,96,192],before:6,after:32},
  {name:'S2C 1',shape:[32,48,96],before:32,after:64},
  {name:'S2C 2',shape:[16,24,48],before:64,after:128},
  {name:'S2C 3',shape:[8,12,24],before:128,after:256},
];
const domain={x:-2.23,w:3.36,h:1.68,d:1.12};
const inputVars=['ũ','ṽ','w̃','p̃','流体掩码','SDF/D'];

function sdfTexture(){
  const canvas=document.createElement('canvas');canvas.width=576;canvas.height=288;
  const ctx=canvas.getContext('2d')!,img=ctx.createImageData(576,288);
  for(let y=0;y<288;y++)for(let x=0;x<576;x++){
    const r=Math.hypot((x+.5)/160-.6,(144-y-.5)/160);
    const sdf=r-.15,idx=4*(y*576+x);
    const contour=Math.max(0,1-Math.abs((sdf/.09-Math.round(sdf/.09)))/.12);
    const falloff=Math.exp(-Math.max(0,sdf)*1.7);
    img.data[idx]=12+contour*34;
    img.data[idx+1]=70+60*falloff+contour*74;
    img.data[idx+2]=109+57*falloff+contour*79;
    img.data[idx+3]=sdf<0?12:90+falloff*62+contour*47;
  }
  ctx.putImageData(img,0,0);
  const tex=new T.CanvasTexture(canvas);tex.colorSpace=T.SRGBColorSpace;
  return tex;
}

export function encoder(s:Stage){
  cleanStage(s);
  const root=s.root,source=new T.Group(),bank=new T.Group();root.add(source,bank);
  let compact=false;
  s.controls.innerHTML='<h3>空间编码</h3>'+buttons(layers.map(l=>l.name),'layer')+
    range('X 方向的输出格点',0,191,0,'coarse')+range('追踪块的 Z 层',0,7,0,'focus-z')+
    range('展开的输入通道',0,5,0,'offset')+'<div class="mc-reading"></div>';
  const tex=sdfTexture();
  const sections:T.Mesh[]=[];
  for(let j=0;j<5;j++){
    const face=new T.Mesh(new T.PlaneGeometry(domain.w,domain.h),new T.MeshBasicMaterial({map:tex,transparent:true,opacity:j===2?.72:.31,side:T.DoubleSide,depthWrite:false}));
    face.position.set(domain.x,0,domain.d*(j/4-.5));source.add(face);sections.push(face);
  }
  domainFrame(source,domain);cylinder(source,domain);
  const grids=layers.map((_,i)=>{
    const lines:number[]=[],nx=[32,24,16,12][i],ny=nx/2;
    const [x0,x1,y0,y1,z0,z1]=[domain.x-domain.w/2,domain.x+domain.w/2,-domain.h/2,domain.h/2,-domain.d/2,domain.d/2];
    for(let n=0;n<=nx;n++){const x=x0+domain.w*n/nx;lines.push(x,y0,z1,x,y1,z1,x,y1,z1,x,y1,z0);}
    for(let n=0;n<=ny;n++){const y=y0+domain.h*n/ny;lines.push(x0,y,z1,x1,y,z1,x1,y,z1,x1,y,z0);}
    return stroke(source,lines,'#57c4ed',.35);
  });
  const volumeTitle=caption(source,'输入体素域',[domain.x,1.45,0],.34);
  const sdfTitle=caption(source,'圆柱几何 · SDF 等距线',[domain.x,1.15,0],.23,muted);
  const observation=observationPlane(s,source,domain);
  const showMask=archivedMaskPlane(s,source,domain,false);
  const maskTitle=caption(source,'C04 有效流体掩码',[domain.x,1.15,0],.23,muted);

  const slabs:T.Mesh<T.BoxGeometry,T.MeshBasicMaterial>[]=[];
  const displays:T.Group[]=[];
  const stemNames:T.Sprite[]=[],parityNames:T.Sprite[]=[],outputCells:T.Mesh<T.BoxGeometry,T.MeshBasicMaterial>[]=[];
  for(let i=0;i<8;i++){
    const group=new T.Group();
    group.position.set(.35+i*.426,.08+i*.034,-.30+i*.060);
    group.rotation.y=-.55;bank.add(group);
    const body=plate(group,.79,1.66,.047,blue,.34);
    const lines:number[]=[];
    for(let n=1;n<8;n++){const y=-.83+n*1.66/8;lines.push(-.39,y,.026,.39,y,.026);}
    for(let n=1;n<4;n++){const x=-.395+n*.79/4;lines.push(x,-.83,.026,x,.83,.026);}
    stroke(body,lines,ice,.42);
    const sideMark=plate(body,.62,.042,.010,ice,.82);sideMark.position.set(0,.71,.032);
    outputCells.push(plate(group,.085,.095,.013,amber,.92));
    stemNames.push(caption(group,inputVars[i]??'', [0,-1.0,.10],i<4?.23:.18,ice));
    parityNames.push(caption(group,i.toString(2).padStart(3,'0'), [0,-1.0,.10],.19,ice));
    slabs.push(body);displays.push(group);
  }
  const bankTitle=caption(bank,'通道展开',[2.02,1.52,0],.34,white);
  const outputLabels=layers.map((l,i)=>caption(bank,i?`8 × ${l.before} 通道重排 → C${l.after} 投影`:'6 路物理 / 几何输入 → C32 投影',[2.02,1.19,0],.24,muted));

  const cables:Array<T.Line<T.BufferGeometry,T.LineBasicMaterial>>=[];
  for(let i=0;i<8;i++){
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(new Float32Array(39*3),3));
    const obj=new T.Line(geo,new T.LineBasicMaterial({color:ice,transparent:true,opacity:.55,depthWrite:false}));
    obj.frustumCulled=false;root.add(obj); cables.push(obj);
  }
  const markers=new T.InstancedMesh(new T.BoxGeometry(1,1,1),new T.MeshBasicMaterial({color:amber}),8);
  source.add(markers);
  const targetPosition=new T.Object3D();
  const trackBlock=focusSlice(s,source,domain,onFocus);

  // An unbroken scale beneath the slabs shows how the grouped channels enter the projection.
  stroke(bank,segments([[.28,-1.01,0],[.28,-1.11,0],[3.57,-1.11,0],[3.57,-1.01,0]]),muted,.8);
  const layerBtn=s.controls.querySelectorAll<HTMLButtonElement>('[data-layer]');
  const sx=s.get<HTMLInputElement>('[data-range=coarse]'),sz=s.get<HTMLInputElement>('[data-range=focus-z]'),so=s.get<HTMLInputElement>('[data-range=offset]');
  let active=0,offset=0,physicalX=readFocus().x*8+4;
  let progress=0,manualAt=-1;
  function onFocus(f:Focus){physicalX=f.x*8+4;refresh();}
  function refresh(){
    const f=readFocus(),l=layers[active],count=active?8:6;
    offset=Math.min(offset,count-1);
    const cellScale=2**active,x=Math.floor(physicalX/cellScale);
    sx.max=String(l.shape[2]-1);sx.value=String(x);sz.value=String(f.z);so.max=String(count-1);so.value=String(offset);
    s.get('[data-out=coarse]').textContent=String(x);s.get('[data-out=focus-z]').textContent=String(f.z);s.get('[data-out=offset]').textContent=String(offset);
    s.get('[data-range=offset]').setAttribute('aria-label',active?'局部空间偏移组':'输入通道');
    so.parentElement!.querySelector('span')!.textContent=active?'局部空间偏移组':'输入通道';
    const displayChannel=active?1:offset;
    observation.update(f.z,displayChannel,refresh);
    showMask(f,displayChannel===4);maskTitle.visible=displayChannel===4;
    sdfTitle.visible=displayChannel===5||observation.caption.includes('未加载');
    sections.forEach(section=>section.visible=displayChannel===5||observation.caption.includes('未加载'));
    trackBlock(f);
    const center=blockCenter(domain,f);
    center[0]=domain.x+((x+.5)/l.shape[2]-.5)*domain.w;
    const cy=Math.floor((f.y*8+4)/cellScale),cz=Math.floor((f.z*8+4)/cellScale);
    center[1]=((cy+.5)/l.shape[1]-.5)*domain.h;
    center[2]=((cz+.5)/l.shape[0]-.5)*domain.d;
    const outputSize=new T.Vector3(domain.w/l.shape[2],domain.h/l.shape[1],domain.d/l.shape[0]);
    grids.forEach((g,k)=>g.visible=k===active);
    outputLabels.forEach((v,k)=>v.visible=!compact&&k===active);bankTitle.visible=!compact;
    markers.count=count;
    for(let i=0;i<8;i++){
      const selected=i===offset,visible=i<count;
      displays[i].visible=visible;cables[i].visible=visible;
      stemNames[i].visible=active===0;parityNames[i].visible=active>0;
      if(!visible)continue;
      // A Stem lane is one of six input variables. Each subsequent S2C lane is
      // an XYZ parity group carrying every input channel at that local offset.
      const xBit=i&1,yBit=(i>>1)&1,zBit=(i>>2)&1;
      const start=new T.Vector3(...center);
      if(active)start.add(new T.Vector3((xBit-.5)*.5,(yBit-.5)*.5,(zBit-.5)*.5).multiply(outputSize));
      targetPosition.position.copy(start);targetPosition.scale.copy(outputSize).multiplyScalar(active?.43:.90);targetPosition.updateMatrix();
      markers.setMatrixAt(i,targetPosition.matrix);
      const station=displays[i];
      station.position.x=.35+i*(3.00/(count-1));
      const cell=outputCells[i];
      cell.position.set(((x+.5)/l.shape[2]-.5)*.76,((cy+.5)/l.shape[1]-.5)*1.54,.038);
      cell.material.color.set(selected?white:ice);cell.material.opacity=selected?.98:.82;
      station.updateMatrix();
      const finish=cell.position.clone().applyMatrix4(station.matrix);
      const a=start.clone().applyMatrix4(source.matrix),b=finish.applyMatrix4(bank.matrix);
      const bend1=compact?a.clone().add(new T.Vector3(.72,-1.55,.6)):new T.Vector3(center[0]+.42,center[1]+.16,center[2]+.13);
      const bend2=compact?b.clone().add(new T.Vector3(-.34,1.32,.45)):new T.Vector3(-.18+.12*i,-.66+.18*i,1.21-.06*i);
      const path=new T.CubicBezierCurve3(a,bend1,bend2,b);
      const coords=cables[i].geometry.getAttribute('position') as T.BufferAttribute;
      const sample=new T.Vector3();
      for(let n=0;n<39;n++){path.getPoint(n/38,sample);coords.setXYZ(n,sample.x,sample.y,sample.z);}
      coords.needsUpdate=true;
      cables[i].material.color.set(selected?amber:ice);cables[i].material.opacity=selected?1:compact?.24:.43;
      slabs[i].material.color.set(selected?amber:blue);slabs[i].material.opacity=selected?.65:.37;
    }
    markers.instanceMatrix.needsUpdate=true;markers.computeBoundingSphere();
    const offsetText=active?`偏移 (ΔZ, ΔY, ΔX) = (${(offset>>2)&1}, ${(offset>>1)&1}, ${offset&1})，携带 C${l.before}。`:`输入通道 ${inputVars[offset]}，Stem 将 6 路输入投影到 32 通道。`;
    s.get('.mc-reading').innerHTML=`<b>${l.name} · ${l.shape.join(' × ')} · C${l.after}</b><span>${offsetText}</span><p>追踪 Token (Z,Y,X) = (${f.z}, ${f.y}, ${f.x})。输入块 ${tokenBounds(f)}。当前格点对应输入 X ${x*cellScale}–${(x+1)*cellScale-1}。</p><p>${observation.caption} 网格按显示密度抽样。点击圆柱后方可移动追踪块。</p>`;
  }
  function select(i:number,manual=false){if(manual)manualAt=progress;active=i;selectButton(s.controls,'layer',i);refresh();reportStep(s,i);}
  layerBtn.forEach((b,i)=>s.on(b,'click',()=>{select(i,true);s.changed();}));
  slabs.forEach((body,i)=>s.targets.set(body,()=>{offset=i;manualAt=progress;refresh();s.changed();}));
  s.on(sx,'input',()=>{physicalX=Math.min(191,sx.valueAsNumber*2**active+Math.floor(2**active/2));const f=readFocus();writeFocus({...f,x:Math.floor(physicalX/8)});refresh();s.changed();});
  s.on(sz,'input',()=>{writeFocus({...readFocus(),z:sz.valueAsNumber});refresh();s.changed();});
  s.on(so,'input',()=>{offset=so.valueAsNumber;refresh();s.changed();});
  const host=document.getElementById('canvas-shell')??document.getElementById('viewport')!;
  function layout(){
    const bounds=host.getBoundingClientRect();
    compact=bounds.width<620&&bounds.width/bounds.height<1.38;
    source.scale.setScalar(compact?1.78:1);source.position.set(compact?-domain.x*1.78:0,compact?2.02:0,0);
    volumeTitle.position.x=domain.x-(compact?.59:0);
    bank.scale.setScalar(compact?1.91:1);bank.position.set(compact?-1.93*1.91:0,compact?-2.33:0,0);
    source.updateMatrix();bank.updateMatrix();refresh();s.changed();
  }
  layout();registerSteps(s,i=>select(i,true));select(0);
  const observer=new ResizeObserver(layout);observer.observe(host);const prior=s.onDispose;
  s.onDispose=()=>{prior?.();observer.disconnect();};
  s.animate=p=>{progress=p;const i=Math.min(3,Math.floor(p*4));if(i!==active&&(manualAt<0||Math.abs(p-manualAt)>.16))select(i);};
}

