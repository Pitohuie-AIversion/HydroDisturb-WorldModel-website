import * as T from 'three';
import {Stage, buttons, selectButton, type Point} from './shared';
import {caption, instrument, processSelector, rectangle, sea, segments, sheet} from './instrument';

const slots=[
  ['Text','文本指令或空标记。推理只使用已给出的描述。'],
  ['Physics','已知的雷诺数、几何与边界参数。'],
  ['Step','目标物理步长 Δt 与物理时间。生成时间 τ 单独进入 Query。'],
  ['Action','已观测动作或下一步已知的外部控制。'],
  ['Regime','从截至所选时刻的历史状态推断流态。'],
];
const times=['t−3','t−2','t−1','t'], targets=['t−2','t−1','t','t+1'];
const xs=[-2.18,-1.05,.08,1.21], cleanY=.92, queryY=-.64;

export function temporal(s:Stage) {
  const board=instrument(s.root);
  const titles=new T.Group();board.add(titles);
  caption(titles,'Clean',[-4.31,.96,0],.48);
  caption(titles,'历史轨',[-4.29,.56,0],.25,sea.ice);
  caption(titles,'Query',[-4.31,-.58,0],.48);
  caption(titles,'生成轨',[-4.29,-.99,0],.25,sea.ice);
  caption(titles,'每帧条件',[-4.30,-1.72,0],.22,sea.muted);
  caption(titles,'同层 K/V',[-4.29,.05,0],.23,sea.muted);
  segments(titles,[[[-3.18,1.77,0],[-3.18,-1.26,0]],[[-4.30,-1.39,0],[4.27,-1.39,0]]],sea.line,.70);
  // Each Clean measure carries its own five prefix slots, spatial-token
  // sheet, and two rails for K/V. The strands depict token flow, not data.
  const measures=xs.map((x,j)=>{
    const group=new T.Group();group.position.set(x,0,0);board.add(group);
    caption(group,times[j],[0,1.68,0],.30,sea.white,'center',true);
    const prefixes=slots.map((_,k)=>{
      const px=(k-2)*.136;
      const pip=new T.Mesh(new T.CircleGeometry(.043,12),new T.MeshBasicMaterial({color:sea.ice}));
      pip.position.set(px,1.38,.05);group.add(pip);
      const pad=sheet(group,[px,1.38,.06],.13,.16,sea.blue,0);
      s.targets.set(pad,()=>chooseSlot(k));
      return pip;
    });
    const surface=sheet(group,[0,cleanY,-.06],.89,.59,sea.deep,.75);
    const waves:Point[][]=[];
    for(let k=0;k<9;k++){
      const points:Point[]=[];
      for(let n=0;n<=32;n++){
        const f=n/32, v=(k-4)*.047;
        const wave=Math.sin(Math.PI*f)*Math.sin(f*7.4+k*.48+j*.91)*.089;
        points.push([-.423+f*.846,cleanY+v+wave,.015+.008*Math.cos(f*8+k)]);
      }
      waves.push(points);
    }
    const strands=segments(group,waves,sea.ice);
    strands.material.transparent=true;strands.renderOrder=5;
    const boundary=segments(group,[rectangle(-.46,.615,.46,1.225)],sea.blue,.90);
    const kv=segments(group,[[[-.38,.51,0],[.38,.51,0]],[[-.38,.445,0],[.38,.445,0]],[[0,.445,0],[0,.34,0]]],sea.blue);
    return {group,surface,strands,boundary,kv,prefixes};
  });
  // For each selectable forecast origin, the highlighted fan terminates at
  // that Query. It never crosses the selected origin's causal cutoff.
  const paths=xs.map(()=>new T.CubicBezierCurve3());
  const fans=paths.map(()=>segments(board,[Array.from({length:39},()=>[0,0,0] as Point)],sea.ice,.82));
  const pulses=paths.map(()=>{
    const pulse=new T.Mesh(new T.CircleGeometry(.040,14),new T.MeshBasicMaterial({color:sea.white,depthTest:false}));
    pulse.renderOrder=7;board.add(pulse);return pulse;
  });
  const queries=xs.map((x,j)=>{
    const group=new T.Group();group.position.set(x,queryY,0);board.add(group);
    const frame=segments(group,[[[-.375,.16,0],[-.43,.16,0],[-.43,-.16,0],[-.375,-.16,0]],[[.375,.16,0],[.43,.16,0],[.43,-.16,0],[.375,-.16,0]]],sea.muted);
    const targetCaption=caption(group,targets[j],[0,0,.10],.28,sea.ice,'center',true).sprite;
    const hit=sheet(group,[0,0,.08],.96,.50,sea.blue,.12);
    s.targets.set(hit,()=>chooseQuery(j));
    return {group,frame,targetCaption,hit};
  });
  const labels=slots.map(([name],i)=>{
    const x=-2.38+i*1.19;
    const group=new T.Group();group.position.set(x,-1.72,0);board.add(group);
    const pad=sheet(group,[0,0,.015],1.07,.36,sea.blue,.10);
    caption(group,name,[0,0,.06],.24,sea.ice,'center',true);
    s.targets.set(pad,()=>chooseSlot(i));return {group,pad};
  });
  const heads=new T.Group();board.add(heads);
  caption(heads,'统计头',[3.11,1.20,0],.24,sea.muted);
  caption(heads,'b̂',[3.09,.85,0],.51);
  caption(heads,'速度头',[3.11,-.36,0],.24,sea.muted);
  caption(heads,'vθ',[3.09,-.72,0],.51);
  const headLines=segments(heads,[[[2.75,cleanY,0],[3.00,cleanY,0]],[[2.87,cleanY+.072,0],[3.0,cleanY,0],[2.87,cleanY-.072,0]],[[2.75,queryY,0],[3.0,queryY,0]],[[2.87,queryY+.072,0],[3.0,queryY,0],[2.87,queryY-.072,0]]],sea.ice);
  const route=segments(board,[Array.from({length:6},()=>[0,0,0] as Point),Array.from({length:6},()=>[0,0,0] as Point)],sea.blue,.92);
  const routePos=route.geometry.attributes.position as T.BufferAttribute;
  const trainingBranch=new T.Group();board.add(trainingBranch);
  const teachRoutes:Point[][]=[];
  for(const [y,end] of [[1.47,1.03],[-1.17,-.84]]) {
    for(let i=0;i<4;i++)teachRoutes.push([[4.07,y+(end-y)*i/4,0],[4.07,y+(end-y)*(i+.52)/4,0]]);
    teachRoutes.push([[4.07,end,0],[3.74,end,0]],[[3.82,end+.057,0],[3.74,end,0],[3.82,end-.057,0]]);
  }
  segments(trainingBranch,teachRoutes,sea.gold);
  caption(trainingBranch,'b 真值',[4.08,1.67,0],.20,sea.gold,'right');
  caption(trainingBranch,'速度标签 v*',[4.26,-1.23,0],.20,sea.gold,'right');
  const maskText=caption(board,'',[0,-1.08,.07],.19,sea.gold,'center');
  s.controls.innerHTML='<h3>双轨因果检查</h3>'+buttons(['推理','训练'],'mode')+
    '<div class="mc-caption">选择 Query 的目标时刻</div>'+buttons(targets,'query')+
    '<div class="mc-reading"><b data-mask></b><p data-track></p></div>'+
    '<div class="mc-caption">每帧的五个条件前缀</div>'+buttons(slots.map(([name])=>name),'slot')+
    '<div class="mc-reading"><b data-slot-title></b><p data-slot-info></p></div>';
  const phone=new T.Group();board.add(phone);
  caption(phone,'Clean · 历史轨',[-4.30,4.56,0],.49);
  caption(phone,'同层 K / V',[4.30,4.56,0],.36,sea.ice,'right');
  caption(phone,'Query · 生成轨',[-4.30,-.90,0],.45);
  const mobileRead=caption(phone,'',[4.30,-.90,0],.38,sea.gold,'right');
  const mobileHeads=caption(phone,'Clean → 统计头 b̂',[-4.30,-1.99,0],.38,sea.ice);
  const mobileQueryHead=caption(phone,'Query → 速度头 vθ',[4.30,-1.99,0],.38,sea.ice,'right');
  const teacher=new T.Group();phone.add(teacher);
  caption(teacher,'← b 真值监督',[-4.30,-2.48,0],.33,sea.gold);
  caption(teacher,'← v* 监督',[4.30,-2.48,0],.33,sea.gold,'right');
  caption(phone,'每帧的五个条件前缀',[-4.30,-3.30,0],.39,sea.ice);
  segments(phone,[[[-4.30,-1.49,0],[4.30,-1.49,0]],[[-4.30,-2.91,0],[4.30,-2.91,0]]],sea.line);
  const narrowXs=[-3.16,-1.05,1.05,3.16];
  let compact=false,training=false,chosen=1,query=3,phase=0;
  function refresh(){
    selectButton(s.controls,'mode',Number(training));selectButton(s.controls,'slot',chosen);selectButton(s.controls,'query',query);
    trainingBranch.visible=training&&!compact;teacher.visible=training;
    for(const text of [mobileHeads,mobileQueryHead])text.sprite.material.color.set(phase===3?'#ffffff':'#afdaee');
    labels.forEach(({pad},i)=>{pad.material.color.set(i===chosen?sea.gold:sea.blue);pad.material.opacity=i===chosen?.36:.10;});
    measures.forEach((m,i)=>{
      const allowed=i<=query;
      m.strands.material.color.set(allowed?phase===1?sea.white:sea.ice:'#2e5066');
      m.surface.material.color.set(allowed?'#07344f':'#091d29');
      m.boundary.material.color.set(allowed?sea.blue:'#294654');
      m.kv.material.color.set(allowed?phase===2?sea.gold:sea.ice:'#294654');
      m.prefixes.forEach((pip,k)=>{pip.material.color.set(allowed?k===chosen?sea.gold:phase===0?sea.ice:sea.blue:'#294654');pip.scale.setScalar(phase===0?1.30:k===chosen?1.18:.88);});
      const path=paths[i];
      if(compact){
        path.v0.set(narrowXs[i],.95+.34*1.62,.05);path.v1.set(narrowXs[i],.73,.05);
        path.v2.set(narrowXs[query],.95-i*.09,.06);path.v3.set(narrowXs[query],.20,.06);
      }else{
        path.v0.set(xs[i],.34,.05);path.v1.set(xs[i],.03,.05);
        path.v2.set(xs[query],-.07-.03*(query-i),.06);path.v3.set(xs[query],queryY+.20,.06);
      }
      const points=path.getPoints(38);const attr=fans[i].geometry.attributes.position as T.BufferAttribute;
      for(let k=0;k<38;k++){attr.setXYZ(2*k,...points[k].toArray());attr.setXYZ(2*k+1,...points[k+1].toArray());}
      attr.needsUpdate=true;fans[i].geometry.computeBoundingSphere();fans[i].visible=pulses[i].visible=allowed;
      fans[i].material.color.set(phase===2?sea.gold:sea.ice);
      queries[i].frame.material.color.set(i===query?sea.gold:sea.line);
      queries[i].hit.material.color.set(i===query?sea.gold:sea.deep);queries[i].hit.material.opacity=i===query?.24:.35;
      queries[i].targetCaption.material.color.set(i===query?'#ffffff':'#a2c3d1');
    });
    // Both heads end at the same forecast horizon. The top one never reads Query.
    // Go around later frames and Query slots when inspecting an earlier
    // cutoff. Neither output consumes a later token on the way to its head.
    for(const [j,y] of [cleanY,queryY].entries()){
      const z=-.075, x=xs[query]+.46;
      const bypass=query===3?y:j===0?1.27:-.92;
      const path:Point[]=[[x,y,z],[x+.06,y,z],[x+.06,bypass,z],[2.48,bypass,z],[2.48,y,z],[2.76,y,z]];
      for(let k=0;k<5;k++){routePos.setXYZ(10*j+2*k,...path[k]);routePos.setXYZ(10*j+2*k+1,...path[k+1]);}
    }
    routePos.needsUpdate=true;route.geometry.computeBoundingSphere();
    headLines.material.color.set(phase===3?sea.gold:sea.ice);
    const span=query===0?times[0]:times[0]+' … '+times[query];
    mobileRead.write((query+1)+' / 4 帧可读');
    maskText.write('Query '+targets[query]+'   ←   '+(query+1)+' 帧 K/V');
    s.get('[data-mask]').textContent='Query '+targets[query]+' 读取 '+span+' 的同层 Clean K/V（'+(query+1)+'/4 帧）';
    s.get('[data-track]').textContent=training?'训练使用下一帧真值构造插值 zτ 和速度标签 v*。未来 b 只监督统计头，统计头只读历史。':'因果掩码按查询位置截断所示窗口。最终的下一步 Query 从 zτ=z_t、τ=0 起步，读取四帧历史，每次积分更新后重新计算。';
    s.get('[data-slot-title]').textContent='槽位 '+chosen+' · '+slots[chosen][0];
    s.get('[data-slot-info]').textContent=slots[chosen][1];
    s.controls.dataset.query=String(query);s.controls.dataset.readable=times.slice(0,query+1).join(',');
  }
  const process=processSelector(s.controls,4,i=>{phase=i;refresh();},s.changed);
  function chooseSlot(i:number){chosen=i;process.jump(0);refresh();s.changed();}
  function chooseQuery(i:number){query=i;process.jump(2);refresh();s.changed();}
  s.controls.querySelectorAll<HTMLElement>('[data-slot]').forEach((b,i)=>s.on(b,'click',()=>chooseSlot(i)));
  s.controls.querySelectorAll<HTMLElement>('[data-query]').forEach((b,i)=>s.on(b,'click',()=>chooseQuery(i)));
  s.controls.querySelectorAll<HTMLElement>('[data-mode]').forEach((b,i)=>s.on(b,'click',()=>{training=i===1;process.jump(3);refresh();s.changed();}));
  const pos=new T.Vector3();
  s.animate=p=>{
    process.update(p);
    for(let i=0;i<=query;i++)pulses[i].position.copy(paths[i].getPoint((p*4+i*.20)%1,pos));
  };
  // Spread the score across a wide projection screen while preserving the
  // aspect of glyphs. On narrow screens it keeps the base camera framing.
  const host=document.getElementById('canvas-shell')!;
  function fitScore(){
    const bounds=host.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    compact=bounds.width<610&&bounds.width/bounds.height<1.22;
    const stretch=T.MathUtils.clamp((bounds.width/bounds.height)*4.4/9.5,1,1.65);
    board.scale.x=stretch;
    board.scale.y=compact?Math.min(1.03,(9.5*bounds.height/bounds.width-1.48)/9.38):1;
    phone.visible=compact;titles.visible=heads.visible=route.visible=maskText.sprite.visible=!compact;
    measures.forEach((m,i)=>{m.group.position.set(compact?narrowXs[i]:xs[i],compact?.95:0,0);m.group.scale.setScalar(compact?1.62:1);});
    queries.forEach((q,i)=>{q.group.position.set(compact?narrowXs[i]:xs[i],compact?-.1:queryY,0);q.group.scale.setScalar(compact?1.72:1);});
    labels.forEach(({group},i)=>{group.position.set(compact?-3.48+i*1.74:-2.38+i*1.19,compact?-4.05:-1.72,0);group.scale.setScalar(compact?1.54:1);});
    refresh();
    board.traverse(object=>{
      if(object instanceof T.Sprite&&object.userData.letterWidth){
        object.userData.stretch=stretch;object.scale.x=object.userData.letterWidth/stretch;
      }
    });
    s.changed();
  }
  const observer=new ResizeObserver(fitScore);observer.observe(host);fitScore();
  s.onDispose=()=>{process.dispose();observer.disconnect();};
  refresh();s.animate(0);
}

export {flowMatching} from './fm';
