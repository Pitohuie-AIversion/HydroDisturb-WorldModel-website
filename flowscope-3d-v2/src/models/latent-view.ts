import * as T from 'three';
import {Stage, type Point} from './shared';
import {caption, instrument, rectangle, sea, segments, sheet} from './instrument';

const nx=24, ny=12, nz=8, channels=256, total=nx*ny*nz;
const dx=.153,dy=.146,dz=.28;
const at=(x:number,y:number,z:number)=>new T.Vector3((x-11.5)*dx,(y-5.5)*dy,(z-3.5)*dz);
const cloudLow=new T.Color('#174567'), cloudHigh=new T.Color('#54cfff');
const sliceLow=new T.Color('#177bac'), sliceHigh=new T.Color('#e3fbff');
const signColor=new T.Color(), matrix=new T.Matrix4();

export function latentView(s:Stage, pickToken:(i:number)=>void, pickChannel:(i:number)=>void) {
  const board=instrument(s.root);
  const spatial=new T.Group(),response=new T.Group();board.add(spatial,response);
  const volume=new T.Group();volume.position.set(-2.02,-.02,0);volume.rotation.set(.29,-.52,-.064);volume.scale.y=.89;spatial.add(volume);
  const centres=Array.from({length:total},(_,i)=>at(i%nx,Math.floor(i/nx)%ny,Math.floor(i/(nx*ny))));
  const dots=new T.InstancedMesh(new T.SphereGeometry(1,7,4),new T.MeshBasicMaterial({color:'white'}),total);
  dots.instanceMatrix.setUsage(T.DynamicDrawUsage);
  volume.add(dots);s.targets.set(dots,hit=>{if(hit.instanceId!==undefined)pickToken(hit.instanceId);});
  const borders:Point[][]=[];
  const halfW=nx*dx/2, halfH=ny*dy/2;
  for(let z=0;z<nz;z++)borders.push(rectangle(-halfW,-halfH,halfW,halfH,at(0,0,z).z));
  for(const x of [-halfW,halfW])for(const y of [-halfH,halfH])borders.push([[x,y,-3.5*dz],[x,y,3.5*dz]]);
  segments(volume,borders,'#2d7595',.64);
  const plane=sheet(volume,[0,0,0],2*halfW,2*halfH,sea.blue,.13);
  const sliceOutline=segments(volume,[rectangle(-halfW,-halfH,halfW,halfH)],sea.ice);
  const selection=new T.Mesh(new T.SphereGeometry(.061,12,8),new T.MeshBasicMaterial({color:sea.gold,depthTest:false}));
  selection.renderOrder=9;volume.add(selection);
  const ring=new T.Mesh(new T.TorusGeometry(.121,.010,8,40),new T.MeshBasicMaterial({color:sea.gold,depthTest:false}));
  ring.renderOrder=11;spatial.add(ring);
  const connection=segments(board,[[[0,0,0],[0,0,0],[0,0,0],[0,0,0]]],sea.gold,.9);
  connection.material.depthTest=false;connection.renderOrder=8;
  const lead=connection.geometry.getAttribute('position') as T.BufferAttribute;
  caption(spatial,'空间 Token',[-4.30,1.64,0],.34);
  const sliceText=caption(spatial,'',[-4.29,1.37,0],.21,sea.ice,'left',true);
  caption(spatial,'Z / Y / X    8 × 12 × 24',[-4.29,-1.49,0],.20,sea.muted,'left',true);
  const sourceText=caption(spatial,'',[-4.29,-1.78,0],.21,sea.ice);
  caption(response,'通道激活',[.57,1.64,0],.34);
  const valueText=caption(response,'',[4.30,1.64,0],.24,sea.gold,'right',true);
  // The entire trace is plotted on one signed scale. The pick plane maps
  // pointer coordinates to the original channel in CZYX storage order.
  const left=.62,right=4.23,base=.51,amp=.51;
  const plotTop=base+amp,plotBottom=base-amp;
  sheet(response,[(left+right)/2,base,-.07],right-left,amp*2.26,sea.deep,.51);
  const guides:Point[][]=[];
  for(let i=0;i<=4;i++) {
    const x=left+(right-left)*i/4;guides.push([[x,plotBottom,-.04],[x,plotTop,-.04]]);
  }
  for(const y of [plotTop,base,plotBottom])guides.push([[left,y,-.04],[right,y,-.04]]);
  segments(response,guides,sea.line,.95);
  caption(response,'0',[left,-.19,0],.17,sea.muted,'left',true);
  caption(response,'255',[right,-.19,0],.17,sea.muted,'right',true);
  const scaleText=caption(response,'',[(left+right)/2,-.19,0],.17,sea.muted,'center',true);
  const signalCoords=new Float32Array(channels*3),fillCoords=new Float32Array((channels-1)*18);
  const signalGeometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(signalCoords,3));
  const fillGeometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(fillCoords,3));
  const signal=new T.Line(signalGeometry,new T.LineBasicMaterial({color:sea.ice,depthTest:false,transparent:true}));
  const fill=new T.Mesh(fillGeometry,new T.MeshBasicMaterial({color:sea.blue,opacity:.36,transparent:true,depthWrite:false,side:T.DoubleSide}));
  signal.frustumCulled=fill.frustumCulled=false;signal.renderOrder=6;response.add(signal,fill);
  const chartPick=sheet(response,[(left+right)/2,base,.03],right-left,amp*2.24,sea.blue,0);
  s.targets.set(chartPick,hit=>{if(hit.uv)pickChannel(Math.round(T.MathUtils.clamp(hit.uv.x,0,1)*255));});
  const cursor=segments(response,[[[0,plotBottom,.04],[0,plotTop,.04]]],sea.gold);
  cursor.material.transparent=true;cursor.renderOrder=7;
  const sample=new T.Mesh(new T.CircleGeometry(.046,18),new T.MeshBasicMaterial({color:sea.gold,depthTest:false,transparent:true}));
  sample.renderOrder=8;response.add(sample);

  // Probe supervision is at the frame level. No fictitious chart values or
  // trained predictions are derived from the single-token trace above.
  const probeIn=segments(board,[[[-1.47,-1.07,-.23],[-.87,-1.07,-.23],[-.62,-1.22,-.23],[.33,-1.22,-.23],[.59,-.96,0]]],sea.blue);
  const branches=segments(response,[[[.59,-.96,0],[1.10,-.96,0],[1.10,-.75,0],[1.44,-.75,0]],[[1.10,-.96,0],[1.10,-1.29,0],[1.44,-1.29,0]]],sea.blue);
  caption(response,'整帧物理探针',[.58,-.48,0],.23,sea.ice);
  caption(response,'拟能   Ω*',[1.53,-.75,0],.24);
  caption(response,'能谱   E(k)',[1.53,-1.29,0],.24);
  caption(response,'监督目标 · 未提供探针预测',[.58,-1.78,0],.20,sea.muted);
  const featureValues=new Float32Array(channels);
  let lastZ=-1,compact=false;
  function connect() {
    const tip=ring.position.clone().applyMatrix4(spatial.matrix);
    const chart=new T.Vector3(compact?right+.04:left-.035,base,.06).applyMatrix4(response.matrix);
    const route=compact?[tip,new T.Vector3(4.23,tip.y,tip.z),new T.Vector3(4.23,chart.y,.06),chart]:
      [tip,new T.Vector3(.10,tip.y,tip.z),new T.Vector3(.39,base,.06),chart];
    for(let i=0;i<3;i++){lead.setXYZ(i*2,...route[i].toArray());lead.setXYZ(i*2+1,...route[i+1].toArray());}
    lead.needsUpdate=true;connection.geometry.computeBoundingSphere();
  }
  const host=document.getElementById('canvas-shell')!;
  function fit(){
    const {width,height}=host.getBoundingClientRect();if(!width||!height)return;
    compact=width<610&&width/height<1.22;
    spatial.scale.setScalar(compact?1.82:1);response.scale.setScalar(compact?1.97:1);
    spatial.position.set(compact?3.70:0,compact?3.56:0,0);
    response.position.set(compact?-5.19:0,compact?-3.59:0,0);
    board.scale.y=compact?Math.min(1,(9.5*height/width-1.48)/14.26):1;
    spatial.updateMatrix();response.updateMatrix();probeIn.visible=!compact;
    connect();s.changed();
  }
  const observer=new ResizeObserver(fit);observer.observe(host);fit();

  return {
    refresh(token:number, channel:number, value:(i:number,c:number)=>number, recolor:boolean, trained:boolean, normalised:boolean) {
      const x=token%nx,y=Math.floor(token/nx)%ny,z=Math.floor(token/(nx*ny));
      if(recolor||lastZ!==z){
        for(let i=0;i<total;i++){
          const local= Math.floor(i/(nx*ny))===z;
          const intensity=.5+.5*Math.tanh(value(i,channel)*.88);
          const radius=local?.039+intensity*.017:.014+intensity*.016;
          matrix.makeScale(radius,radius,radius).setPosition(centres[i]);dots.setMatrixAt(i,matrix);
          signColor.copy(local?sliceLow:cloudLow).lerp(local?sliceHigh:cloudHigh,intensity);
          dots.setColorAt(i,signColor);
        }
        dots.instanceMatrix.needsUpdate=true;dots.instanceColor!.needsUpdate=true;lastZ=z;
      }
      plane.position.z=sliceOutline.position.z=centres[token].z;selection.position.copy(centres[token]);
      volume.updateMatrix();ring.position.copy(centres[token]).applyMatrix4(volume.matrix);
      connect();
      sliceText.write('Z '+String(z).padStart(2,'0')+'   /   Y '+String(y).padStart(2,'0')+'   /   X '+String(x).padStart(2,'0'));
      sourceText.write((trained?'训练缓存':'合成激活')+'   ·   '+(normalised?'RMSNorm':'原始尺度'));
      let maxAbs=0;
      for(let i=0;i<channels;i++){featureValues[i]=value(token,i);maxAbs=Math.max(maxAbs,Math.abs(featureValues[i]));}
      const ceiling=maxAbs===0?1:maxAbs;
      for(let i=0;i<channels;i++){
        const u=left+(right-left)*i/255,v=base+amp*featureValues[i]/ceiling;
        signalCoords.set([u,v,.02],i*3);
        if(i>0){const a=signalCoords[(i-1)*3],b=signalCoords[(i-1)*3+1];
          fillCoords.set([a,base,0,a,b,0,u,v,0,a,base,0,u,v,0,u,base,0],(i-1)*18);}
      }
      signalGeometry.attributes.position.needsUpdate=true;fillGeometry.attributes.position.needsUpdate=true;
      cursor.position.x=signalCoords[channel*3];sample.position.set(cursor.position.x,signalCoords[channel*3+1],.05);
      const n=featureValues[channel];valueText.write('C'+String(channel).padStart(3,'0')+'   '+(n>=0?'+':'')+n.toFixed(2));
      scaleText.write('±'+ceiling.toPrecision(3)+'  /  256 维');
    },
    dispose(){observer.disconnect();},
    stage(index:number) {
      plane.material.opacity=index===0?.20:.105;
      signal.material.color.set(index===1?sea.white:sea.ice);
      branches.material.color.set(index===2?sea.gold:sea.blue);probeIn.material.color.copy(branches.material.color);
    },
    animate(p:number) {ring.scale.setScalar(1+.10*Math.sin(p*6*Math.PI));},
  };
}
