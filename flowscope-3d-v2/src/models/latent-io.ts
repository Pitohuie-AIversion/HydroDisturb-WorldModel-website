export interface LatentSourceFrame {
  step:number;
  time_s:number;
  stats6:number[];
  source_sha256:string;
}
export interface LatentCache {
  frame:LatentSourceFrame;
  checkpoint:string;
  norm:'per_token_no_affine'|'off_ablation';
  values:Float32Array;
}

const nFeatures=256*8*12*24;
const hashPattern=/^[0-9a-f]{64}$/i;
const magic='FSLAT2\r\n';

export async function readLatent(file:File, archive:LatentSourceFrame[]):Promise<LatentCache> {
  if(file.size<12+nFeatures*4||file.size>12+32768+nFeatures*4)throw Error('缓存大小与单帧 256×8×12×24 FP32 不符。');
  const bytes=await file.arrayBuffer();
  const utf8=new TextDecoder('utf-8',{fatal:true});
  if(utf8.decode(bytes.slice(0,8))!==magic)throw Error('需要 FlowScope V2 潜变量缓存。');
  const length=new DataView(bytes).getUint32(8,true);
  const offset=12+length;
  if(!length||length%4!==0||length>32768||bytes.byteLength-offset!==nFeatures*4)throw Error('缓存头或 FP32 载荷长度错误。');
  const m=JSON.parse(utf8.decode(bytes.slice(12,offset)));
  if(m.schema!=='flowscope.clean-latent.v1'||m.dataset!=='C04'||m.name!=='z_clean'||m.layout!=='CZYX'||
      JSON.stringify(m.shape)!=='[256,8,12,24]'||m.dtype!=='float32_le'||m.unit!=='1'||m.training_noise!==false)throw Error('潜状态的类型、形状、轴序、单位或导出噪声约定不相符。');
  if(!['per_token_no_affine','off_ablation'].includes(m.rmsnorm)||!hashPattern.test(m.checkpoint_sha256)||!hashPattern.test(m.payload_sha256))throw Error('缓存缺少 RMSNorm 状态、checkpoint 或载荷摘要。');
  const frame=archive.find(f=>f.step===m.step);
  if(!frame||!Number.isFinite(m.time_s)||Math.abs(frame.time_s-m.time_s)>1e-6||
      frame.source_sha256.toLowerCase()!==String(m.source_sha256).toLowerCase())throw Error('此缓存的 CFD 帧、时标或源文件哈希与归档不符。');
  const body=bytes.slice(offset);
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',body));
  const hex=Array.from(digest,x=>x.toString(16).padStart(2,'0')).join('');
  if(hex!==m.payload_sha256.toLowerCase())throw Error('潜变量载荷 SHA-256 校验失败。');
  const values=new Float32Array(nFeatures);
  const view=new DataView(body);
  for(let i=0;i<values.length;i++){
    const value=view.getFloat32(i*4,true);
    if(!Number.isFinite(value))throw Error('潜变量包含非有限激活。');
    values[i]=value;
  }
  return {frame,checkpoint:m.checkpoint_sha256,norm:m.rmsnorm,values};
}
