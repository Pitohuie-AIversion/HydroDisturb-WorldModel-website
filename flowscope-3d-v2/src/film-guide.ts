import type {Chapter} from './models/shared';
import {readFocus,writeFocus} from './models/focus';

export type FilmShot = {id:string;chapter:number;startFrame:number;frames:number;subStarts:number[]};
export type FilmGuide = {starts:number[];duration:number;fps?:number;shots?:FilmShot[]};
export type WakePose = {fraction:number;landmark?:number};

const modelStages:Record<string,number> = {
  enc_input:0,enc_s2c1:1,enc_s2c2:2,enc_token:3,
  lat_position:0,lat_raw:1,lat_norm:1,lat_probe:2,
  dec_expand:0,dec_curl:1,dec_stats:2,dec_mask:3,
  time_prefix:0,time_clean:1,time_q1:2,time_q2:2,time_q3:2,time_q4:2,time_training:3,
  roll_history:0,roll_decode:1,roll_fifo:2,roll_profile:3
};

/** Use the movie's 30 fps edit points, including the two spoken phrases of an FM step. */
export function createFilmGuide(guide:FilmGuide,panel:HTMLElement) {
  let previous='';
  let filmModel:Chapter|undefined;
  const fps=guide.fps??30;
  const wakeFrames=guide.shots?.find(s=>s.id==='wake.play')?.frames??240;
  // Match the rounded boundaries of the 81 archived samples in the movie.
  const archiveStarts=Array.from({length:81},(_,i)=>{
    const n=i*(wakeFrames-15)/80,low=Math.floor(n);
    return n-low===.5?low+low%2:Math.round(n);
  });
  function range(name:string,value:number) {
    const input=panel.querySelector<HTMLInputElement>('[data-range="'+name+'"]');
    if(!input||input.valueAsNumber===value)return;
    input.valueAsNumber=value;
    input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function press(group:string,value:number) {
    const button=panel.querySelector<HTMLButtonElement>('button[data-'+group+'="'+value+'"]');
    if(button&&button.getAttribute('aria-pressed')!=='true')button.click();
  }
  function check(selector:string,value:boolean) {
    const input=panel.querySelector<HTMLInputElement>(selector);
    if(!input||input.checked===value)return;
    input.checked=value;input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function setup(index:number,id:string,stage:number) {
    if(index>=1&&index<=3) {
      const f=readFocus();
      if(f.x!==8||f.y!==6||f.z!==4)writeFocus({z:4,y:6,x:8});
    }
    if(index===1) {
      press('layer',stage);
      range('coarse',Math.floor(68/2**stage));range('focus-z',4);
    }
    if(index===2) {
      range('x',8);range('y',6);range('z',4);range('channel',37);
      press('frame',3);check('[data-norm]',id!=='lat_raw');
    }
    if(index===3) {
      for(const flag of ['c2s','curl','stats','mask'])check('[data-flag='+flag+']',true);
      range('focus-z',4);
    }
    if(index===4) {
      const picked=/time_q([1-4])/.exec(id);
      press('slot',1);press('mode',Number(id==='time_training'));press('query',picked?Number(picked[1])-1:3);
    }
    if(index===6) {
      press('horizon',0);press('field',0);press('compare',0);
      range('k',Math.min(stage,2));range('profile-row',48);
    }
    panel.dispatchEvent(new CustomEvent('flowscope-process-select',{detail:{index:stage}}));
  }
  return {
    get active(){return !!filmModel;},
    reset(){previous='';filmModel?.useFilmData?.(false);filmModel=undefined;},
    show(index:number,seconds:number,model:Chapter|undefined,moveWake:(pose:WakePose)=>void) {
      const frame=Math.min(Math.round(guide.duration*fps)-1,Math.floor(seconds*fps+1e-6));
      const shot=guide.shots?.find(s=>s.chapter===index+1&&s.startFrame<=frame&&frame<s.startFrame+s.frames);
      if(!shot)return false;
      const offset=Math.max(0,Math.min(shot.frames-1,frame-shot.startFrame));
      const share=offset/Math.max(1,shot.frames-1);
      const {id}=shot;
      const second=shot.subStarts[1]??shot.frames;
      if(index===0) {
        const samples:Record<string,[number,number]>={'wake.lower':[835,847],'wake.upper':[851,867]};
        const pair=samples[id];
        let fraction=0;
        if(id==='wake.play'){
          const next=archiveStarts.findIndex(start=>start>offset);
          const position=next<0?80:next-1+(offset-archiveStarts[next-1])/(archiveStarts[next]-archiveStarts[next-1]);
          fraction=position/80;
        }
        moveWake({fraction,landmark:pair?.[Number(offset>=second)]});
        return true;
      }
      if(!model)return false;
      if(filmModel!==model){filmModel=model;model.useFilmData?.(true);}
      if(index===5) {
        const number=Number(id.match(/^fm\.step([1-8])$/)?.[1]??1);
        let k=number-1,phase=0,fraction=0;
        if(id==='fm.history')phase=1;
        if(id==='fm.velocity')phase=2;
        if(id.startsWith('fm.step')){
          if(offset<second){
            const queryFrames=Math.max(12,Math.min(29,Math.floor(second/4)));
            const historyFrames=Math.max(8,Math.min(18,Math.floor(second/7)));
            phase=number===1?2:offset<queryFrames?0:offset<queryFrames+historyFrames?1:2;
          } else {
            phase=3;
            const end=shot.frames-13;
            fraction=Math.min(1,Math.max(0,(1+Math.floor((offset-end+48)/2))/25));
            if(fraction===1&&k<7){k++;phase=0;fraction=0;}
          }
        }
        if(id==='fm.end'){k=7;phase=3;fraction=1;}
        panel.dispatchEvent(new CustomEvent('fm-guide-pose',{detail:{k,phase,fraction}}));
        return true;
      }
      const stage=modelStages[id];
      if(stage===undefined)return false;
      if(index!==6){
        const progress=id==='dec_curl'?.251+.245*Math.min(59,offset)/59:(stage+.99*share)/(index===2?3:4);
        model.update(progress);
      }
      if(previous!==id){setup(index,id,stage);previous=id;}
      if(index===1)range('offset',id==='enc_s2c1'?Math.min(7,Math.floor(offset/14)):0);
      if(id==='roll_profile')range('profile-row',48+Math.min(8,Math.floor(offset/8)));
      return true;
    }
  };
}
