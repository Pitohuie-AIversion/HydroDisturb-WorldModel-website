import * as T from 'three';
import './models/panel.css';
import { Stage, type Chapter } from './models/shared';
import { encoder, decoder } from './models/spatial';
import { latent } from './models/latent';
import { temporal, flowMatching } from './models/temporal';
import { rollout } from './models/rollout';

export function createModel(index:number,group:T.Group,panel:HTMLElement,changed:()=>void):Chapter {
  const build=[encoder,latent,decoder,temporal,flowMatching,rollout][index-1];
  if(!build)throw new RangeError('模型章节索引需为 1–6。');
  const s=new Stage(group,panel,changed);
  try{build(s);}catch(e){s.dispose();throw e;}
  return s;
}
