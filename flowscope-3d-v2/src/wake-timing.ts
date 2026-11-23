export const compactSeconds=8;
export const guideEndHold=.45;
export const wakeSpeedOptions='<option value="compact" selected>全程 8 秒</option><option value="0.5">物理 0.5×</option><option value="1">物理 1×</option><option value="2">物理 2×</option><option value="4">物理 4×</option>';

export function indexAtTime(frames:ReadonlyArray<{time_s:number}>,time:number){
  let lo=0,hi=frames.length-1;
  while(lo<hi){
    const mid=Math.ceil((lo+hi)/2);
    if(frames[mid].time_s<=time+1e-8)lo=mid;else hi=mid-1;
  }
  return lo;
}
