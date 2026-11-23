import * as T from 'three';
import type {Point} from './shared';

export const sea = {
  blue:'#0098dc', ice:'#95e5ff', white:'#eefaff', gold:'#ffc36c',
  muted:'#84aabf', line:'#24516b', deep:'#0b2a40',
};

// The plot is parallel to the default lens. Volume geometry inside it still
// has depth and follows the user's orbit in free view.
export function instrument(parent:T.Object3D) {
  // These scientific plates have their own axes and connectors.
  parent.children.forEach(child=>{if(child instanceof T.LineLoop)child.visible=false;});
  const board=new T.Group();
  board.lookAt(3.2,2.7,9.7);
  parent.add(board);
  return board;
}

export function caption(parent:T.Object3D, title:string, at:Point, height:number,
                        color=sea.white, align:'left'|'center'|'right'='left', mono=false) {
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('2d')!;
  const font=mono?'600 68px Consolas,"Microsoft YaHei",monospace':'600 68px "Segoe UI","Microsoft YaHei",sans-serif';
  const texture=new T.CanvasTexture(canvas);
  texture.colorSpace=T.SRGBColorSpace;
  texture.minFilter=T.LinearMipmapLinearFilter;
  const sprite=new T.Sprite(new T.SpriteMaterial({map:texture,depthTest:false,depthWrite:false,toneMapped:false}));
  sprite.center.x=align==='left'?0:align==='right'?1:.5;
  sprite.position.set(...at);sprite.renderOrder=15;
  let last:string|undefined;
  function write(value:string) {
    if(value===last)return;
    context.font=font;
    const width=Math.max(4,Math.ceil(context.measureText(value).width+12));
    if(last!==undefined&&canvas.width!==width)texture.dispose();
    last=value;canvas.width=width;canvas.height=98;
    context.font=font;context.textBaseline='middle';context.fillStyle=color;
    context.fillText(value,5,50);texture.needsUpdate=true;
    sprite.userData.letterWidth=height*canvas.width/canvas.height;
    sprite.scale.set(sprite.userData.letterWidth/(sprite.userData.stretch??1),height,1);
  }
  write(title);parent.add(sprite);
  return {sprite,write};
}

export function processSelector(controls:HTMLElement, steps:number, select:(index:number)=>void, changed:()=>void) {
  let active=-1, currentTime=NaN, manualTime=NaN;
  function enter(index:number) {
    if(index===active)return;
    active=index;select(index);
    controls.dispatchEvent(new CustomEvent('flowscope-process-state',{bubbles:true,detail:{index}}));
  }
  const panel=controls.parentElement!;
  const onSelect=(event:Event)=>{
    const index=(event as CustomEvent<{index:number}>).detail?.index;
    if(!Number.isInteger(index)||index<0||index>=steps)return;
    manualTime=currentTime;enter(index);changed();
  };
  panel.addEventListener('flowscope-process-select',onSelect);
  return {
    jump(index:number){manualTime=currentTime;enter(index);changed();},
    update(p:number) {
      currentTime=p;
      if(p!==manualTime)enter(Math.min(steps-1,Math.floor(p*steps)));
    },
    dispose(){panel.removeEventListener('flowscope-process-select',onSelect);},
  };
}

export function segments(parent:T.Object3D, paths:Point[][], color:string, opacity=1) {
  const vertices:number[]=[];
  for(const path of paths) for(let i=1;i<path.length;i++) vertices.push(...path[i-1],...path[i]);
  const geometry=new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(vertices,3));
  const lines=new T.LineSegments(geometry,new T.LineBasicMaterial({color,opacity,transparent:opacity<1,depthWrite:false}));
  parent.add(lines);return lines;
}

export function sheet(parent:T.Object3D, at:Point, width:number, height:number, color:string, opacity:number) {
  const mesh=new T.Mesh(new T.PlaneGeometry(width,height),new T.MeshBasicMaterial({color,opacity,transparent:true,depthWrite:false,side:T.DoubleSide}));
  mesh.position.set(...at);parent.add(mesh);return mesh;
}

export function rectangle(x0:number,y0:number,x1:number,y1:number,z=0):Point[] {
  return [[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z],[x0,y0,z]];
}
