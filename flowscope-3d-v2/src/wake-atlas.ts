import {loadMidplanePreview, loadWakeManifest} from './wake';
import {palette} from './chapters';

type Landmark = {step:number; x:number; y:number; x_m:number; y_m:number; omega_z:number};

/** Same C04 cut for both tracks. Ring positions are signed vorticity peaks from the archived u,v. */
export function mountWakeAtlas(before:HTMLElement) {
  const gallery=document.createElement('section');
  gallery.className='wake-atlas';
  gallery.setAttribute('aria-label','真实横流速度的时间切片');
  gallery.hidden=true;
  before.before(gallery);
  const events=new AbortController();
  let selectedStep:number|undefined;
  function highlight(){
    gallery.querySelectorAll<HTMLButtonElement>('button').forEach(button=>{
      button.setAttribute('aria-pressed',String(Number(button.dataset.wakeLandmark)===selectedStep));
    });
  }

  async function populate(){
    const [manifest, catalog]=await Promise.all([
      loadWakeManifest(),
      fetch('./assets/wake-landmarks.json',{signal:events.signal}).then(async response=>{
        if(!response.ok)throw new Error('涡迹索引不可用');
        return await response.json() as {landmarks:Landmark[]};
      })
    ]);
    const frames=manifest.frames;
    if(events.signal.aborted)return;
    gallery.innerHTML='<header><h2>跟住两侧的涡迹</h2><p>同一截面 Z = 32，底色为横流速度 <i>v</i>。圆环标出展向涡量的局部峰，点击可回看。</p><div class="atlas-scale"><i></i><span></span></div></header>';
    const scale=gallery.querySelector<HTMLElement>('.atlas-scale i')!;
    scale.style.background='linear-gradient(90deg,'+palette.join(',')+')';
    gallery.querySelector('.atlas-scale span')!.textContent=manifest.display_ranges.v.join(' … ')+' '+manifest.units.v;
    const cards=await Promise.all(catalog.landmarks.map(async (mark,i)=>{
      const frame=frames.find(item=>item.step===mark.step)!;
      const strip=await loadMidplanePreview(frame);
      try {
        const slice=document.createElement('canvas');
        const width=strip.width/4, height=strip.height;
        slice.width=384; slice.height=192;
        const ctx=slice.getContext('2d')!;
        ctx.drawImage(strip,width,0,width,height,0,0,slice.width,slice.height);
        const stride=manifest.grid_zyx[2]/width;
        const cx=(mark.x/stride+.5)/width*slice.width;
        const cy=(1-(mark.y/stride+.5)/height)*slice.height;
        ctx.beginPath();ctx.arc(cx,cy,7.5,0,Math.PI*2);ctx.strokeStyle='#071c32';ctx.lineWidth=4;ctx.stroke();
        ctx.strokeStyle='white';ctx.lineWidth=2;ctx.stroke();
        const button=document.createElement('button');
        button.type='button';
        button.dataset.wakeLandmark=String(mark.step);
        const side=mark.omega_z>0?'下侧正涡':'上侧负涡';
        button.setAttribute('aria-label','查看 '+frame.time_s.toFixed(2)+' 秒的'+side+'截面');
        button.title='X = '+mark.x_m+' m，Y = '+mark.y_m+' m，ωz = '+mark.omega_z+' s⁻¹';
        const time=document.createElement('span');
        time.textContent=side+' · '+frame.time_s.toFixed(2)+' s';
        const position=document.createElement('small');
        position.textContent=(i%2?'下游位置':'近尾流位置')+'　X = '+mark.x_m.toFixed(3)+' m';
        time.append(position);
        button.append(slice,time);
        button.addEventListener('click',()=>{
          const timeline=document.querySelector<HTMLInputElement>('#physical-time');
          if(!timeline)return;
          selectedStep=mark.step;highlight();
          if(!timeline.dispatchEvent(new CustomEvent('wake-atlas-frame',{cancelable:true,detail:mark.step})))return;
          timeline.value=String(frame.time_s);
          timeline.dispatchEvent(new Event('input',{bubbles:true}));
        },{signal:events.signal});
        return button;
      }finally{strip.close();}
    }));
    if(events.signal.aborted)return;
    gallery.append(...cards);
    highlight();
    gallery.hidden=false;
  }
  void populate().catch(()=>gallery.remove());
  return {
    mark(step?:number) {
      if(step!==selectedStep){selectedStep=step;highlight();}
    },
    dispose(){events.abort();gallery.remove();}
  };
}
