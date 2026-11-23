import {loadTruthSlice, loadWakeManifest, readAsset} from '../wake';

const channels = ['u', 'v', 'w', 'p'] as const;
type Channel = typeof channels[number];
type Frame = { k:number; step:number; time_s:number; path:string; bytes:number; sha256:string };
type Manifest = {
  schema:string; provenance:string; start_step:number; start_time_s:number; dt_s:number; source_sha256:string;
  grid_zyx:number[]; z_index:number; shape_yx:number[]; channels:Channel[]; units:string[]; frames:Frame[];
};
const root = new URL('./data/simulated-rollout/', document.baseURI);
let indexRequest: Promise<Manifest> | undefined;
const cached = new Map<number, Promise<Float32Array>>();

function loadIndex() {
  return indexRequest ??= Promise.all([fetch(new URL('manifest.json', root)), loadWakeManifest()])
    .then(async ([response, c04]) => {
      if (!response.ok) throw Error('模拟预测清单读取失败');
      const info:Manifest = await response.json();
      const initial = c04.frames[c04.modelReferenceFrame];
      if (info.schema !== 'flowscope.simulated-rollout.v1' || info.provenance !== 'synthetic-passive-transport' ||
          info.source_sha256 !== initial.source_sha256 || info.start_step !== initial.step ||
          info.start_time_s !== initial.time_s || Math.abs(info.dt_s - .06) > 1e-8 ||
          info.grid_zyx.join() !== c04.grid_zyx.join() || info.z_index !== 32 ||
          info.shape_yx.join() !== c04.grid_zyx.slice(1).join() ||
          info.channels.join() !== channels.join() || info.units.join() !== channels.map(ch => c04.units[ch]).join() ||
          info.frames.length !== 101 || !info.frames.every((f, k) => f.k === k &&
            f.step === info.start_step + k && Math.abs(f.time_s - info.start_time_s - k * info.dt_s) < 1e-6)) {
        throw Error('模拟预测的网格、物理时刻或 C04 起始场标识不匹配');
      }
      return info;
    }).catch(error => { indexRequest = undefined; throw error; });
}

export async function loadSimulatedSlice(k:number, channel:Channel, lod = 2):Promise<Float32Array> {
  if (!Number.isInteger(k) || k < 0 || k > 100 || ![1, 2, 4].includes(lod)) throw Error('模拟预测索引无效');
  const info = await loadIndex();
  if (k === 0 && lod > 1) {
    // The archive stores preview LODs as FP16. Match its rounding for the shared initial state.
    const manifest = await loadWakeManifest();
    return (await loadTruthSlice(manifest.modelReferenceFrame, channel, info.z_index, lod)).values;
  }
  const [height, width] = info.shape_yx;
  let request = cached.get(k);
  if (!request) {
    request = readAsset(info.frames[k], root).then(async bytes => {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const raw = await new Response(stream).arrayBuffer();
      if (raw.byteLength !== 4 * channels.length * height * width) throw Error('模拟预测切片尺寸无效');
      return new Float32Array(raw);
    });
    cached.set(k, request);
    if (cached.size > 6) cached.delete(cached.keys().next().value!);
    const thisRequest = request;
    void request.catch(() => { if (cached.get(k) === thisRequest) cached.delete(k); });
  }
  const planes = await request;
  const offset = channels.indexOf(channel) * width * height;
  if (lod === 1) return planes.subarray(offset, offset + width * height);
  const values = new Float32Array((width / lod) * (height / lod));
  let i = 0;
  for (let y = 0; y < height; y += lod) {
    for (let x = 0; x < width; x += lod) values[i++] = planes[offset + y * width + x];
  }
  return values;
}
