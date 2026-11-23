import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import {createSurfaceLayers,lightWakeSurface,prepareSurfaceBlend,surfaceMesh} from './surface-blend'

type Range = [number, number]
interface Asset { path: string; sha256: string; bytes: number }
export interface WakeFrame {
  step: number
  time_s: number
  source: string
  source_sha256: string
  stats6: number[]
  valid_count: number
  derivative_count: number
  range: Record<string, Range>
  assets: {
    structure: Asset
    structureLow?: Asset
    volume: Record<string, Record<string, Asset>>
    masks: Record<string, Asset>
  }
}
export interface WakeManifest {
  schema: string
  defaultFrame: number
  modelReferenceFrame: number
  grid_zyx: [number, number, number]
  display_ranges: Record<string, Range>
  axes_m: Record<'X' | 'Y' | 'Z', number[]>
  units: Record<string, string>
  time_range_s: Range
  palette: string[]
  frames: WakeFrame[]
}
export type WakeView = 'structure' | 'volume' | 'slice'
export interface Wake {
  manifest: WakeManifest
  update(frame: number, channel: string, view: WakeView, slice: number, lod?: number, presented?: () => void): Promise<void>
  prefetch(frame: number, channel: string, view: WakeView, lod: number): void
  blend(fromFrame: number, phase: number): boolean
  warmStart(renderer:THREE.WebGLRenderer,camera:THREE.Camera,scene:THREE.Scene):Promise<void>
  setQuality(level: number): void
  cancelUpdate(): void
  hideFrame(): void
  setStreamlines(enabled: boolean): Promise<void>
  setSections(enabled:boolean):void
  setProbe(coordinates?:readonly number[]):void
  tick(seconds: number): void
  dispose(): void
}

const dataRoot = new URL('./data/', document.baseURI)
const scale = 8 / 3.6
const extent = new THREE.Vector3(8, 1.8 * scale, 1.2 * scale)
let manifestRequest: Promise<WakeManifest> | undefined

export function loadWakeManifest(): Promise<WakeManifest> {
  if (!manifestRequest) {
    manifestRequest = fetch(new URL('manifest.json', dataRoot)).then(async response => {
      if (!response.ok) throw new Error('C04 数据清单读取失败')
      const manifest = await response.json() as WakeManifest
      if (manifest.schema !== 'flowscope.c04.volumes.v2' || !manifest.frames.length) {
        throw new Error('C04 三维数据清单无效')
      }
      // Before the playback start was split out, defaultFrame selected the
      // mature sample for both the wake viewer and the model chapters.
      return {...manifest, modelReferenceFrame:manifest.modelReferenceFrame ?? manifest.defaultFrame, defaultFrame:0}
    }).catch(error => {
      manifestRequest = undefined
      throw error
    })
  }
  return manifestRequest
}

export async function readAsset(asset: Asset, root = dataRoot, signal?:AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(new URL(asset.path, root),{signal})
  if (!response.ok) throw new Error('C04 资源读取失败 · ' + asset.path)
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength !== asset.bytes) throw new Error('C04 文件大小不符 · ' + asset.path)
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const hex = Array.from(digest, v => v.toString(16).padStart(2, '0')).join('')
    if (hex !== asset.sha256) throw new Error('C04 文件校验失败 · ' + asset.path)
  }
  return bytes
}

interface ScalarVolume {
  values: Float32Array
  nx: number
  ny: number
  nz: number
  lod: number
}
// FP16 conversion table avoids allocating a 4-byte float per texel repeatedly.
const half = Float32Array.from({ length: 65536 }, (_, bits) => {
  const exp = (bits >> 10) & 31, mantissa = bits & 1023, sign = bits >> 15 ? -1 : 1
  if (exp === 31) return mantissa ? NaN : sign * Infinity
  return exp ? sign * (1 + mantissa / 1024) * 2 ** (exp - 15) : sign * mantissa * 2 ** -24
})

const scalarCache = new Map<string, ScalarVolume>()
const scalarRequests = new Map<string, Promise<ScalarVolume>>()

async function loadScalar(manifest: WakeManifest, frame: WakeFrame, channel: string, preferred: number) {
  const lod = [preferred, 2, 4, 1].find(level => frame.assets.volume[level]?.[channel])
  if (!lod) throw new Error('当前帧缺少变量 ' + channel)
  const asset = frame.assets.volume[lod][channel]
  const cached = scalarCache.get(asset.path)
  if (cached) {
    scalarCache.delete(asset.path)
    scalarCache.set(asset.path, cached)
    return cached
  }
  const pending = scalarRequests.get(asset.path)
  if (pending) return pending
  const request = (async () => {
    const compressed = await readAsset(asset)
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
    const buffer = await new Response(stream).arrayBuffer()
    const [nz, ny, nx] = manifest.grid_zyx.map(length => Math.ceil(length/lod))
    const expected = nz * ny * nx * (lod === 1 ? 4 : 2)
    if (buffer.byteLength !== expected) throw new Error('体数据尺寸不符 · ' + asset.path)
    const values = lod === 1 ? new Float32Array(buffer) : new Float32Array(nz * ny * nx)
    if (lod !== 1) {
      const encoded = new Uint16Array(buffer)
      for (let i=0; i<encoded.length; i++) values[i]=half[encoded[i]]
    }
    const volume = { values, nx, ny, nz, lod }
    scalarCache.set(asset.path, volume)
    if (scalarCache.size > 6) scalarCache.delete(scalarCache.keys().next().value!)
    return volume
  })().finally(() => scalarRequests.delete(asset.path))
  scalarRequests.set(asset.path, request)
  return request
}

export async function loadTruthSlice(frameIndex: number, channel: string, zIndex = 32, preferred = 1) {
  const manifest = await loadWakeManifest()
  const frame = manifest.frames[frameIndex]
  if (!frame) throw new Error('缺少指定 CFD 时刻')
  const { values, nx, ny, nz, lod } = await loadScalar(manifest, frame, channel, preferred)
  const z = THREE.MathUtils.clamp(Math.round(zIndex / lod), 0, nz - 1)
  return {
    values: values.slice(z * nx * ny, (z+1) * nx * ny), width: nx, height: ny,
    zIndex: z*lod, z_m: manifest.axes_m.Z[z*lod], lod, range: manifest.display_ranges[channel],
    step: frame.step, time_s: frame.time_s, source_sha256: frame.source_sha256,
  }
}

// The inspector cuts the continuously sampled texture at the selected physical
// plane. Match its linear interpolation and invalid-cell rule in the thumbnails.
// Scientific comparisons above continue to return a discrete archived plane.
export async function loadDisplaySlice(frameIndex: number, channel: string, zIndex: number, preferred: number) {
  const manifest=await loadWakeManifest()
  const field=await loadScalar(manifest,manifest.frames[frameIndex],channel,preferred)
  const z=THREE.MathUtils.clamp(zIndex/field.lod,0,field.nz-1)
  const lower=Math.floor(z), upper=Math.ceil(z)
  const width=field.nx, height=field.ny, size=width*height
  const values=field.values.slice(lower*size,(lower+1)*size)
  if (upper!==lower) {
    const fraction=z-lower, base=upper*size
    for(let i=0;i<size;i++) values[i]+=fraction*(field.values[base+i]-values[i])
  }
  return {width,height,values,range:manifest.display_ranges[channel],zIndex:z*field.lod,interpolated:upper!==lower}
}

interface PreviewIndex {
  schema: string
  z: number
  channels: string[]
  frames: Record<string, Asset & {width:number; height:number; source_sha256:string}>
}
const previewRoot = new URL('./assets/slices/', document.baseURI)
let previewIndex: Promise<PreviewIndex> | undefined

export async function loadMidplanePreview(frame: WakeFrame) {
  previewIndex ??= fetch(new URL('index.json', previewRoot)).then(async response => {
    if (!response.ok) throw new Error('切片索引读取失败')
    const index = await response.json() as PreviewIndex
    if (index.schema !== 'flowscope.c04.midplane.v1' || index.z !== 32 || index.channels.join(',') !== 'u,v,w,p') {
      throw new Error('切片索引不匹配')
    }
    return index
  }).catch(error => { previewIndex=undefined; throw error })
  const asset = (await previewIndex).frames[frame.step]
  if (!asset || asset.source_sha256 !== frame.source_sha256) throw new Error('切片数据来源不匹配')
  const png = await readAsset(asset, previewRoot)
  const image = await createImageBitmap(new Blob([png], {type:'image/png'}))
  if (image.height !== asset.height || image.width !== 4 * asset.width) {
    image.close()
    throw new Error('切片尺寸不匹配')
  }
  return image
}

function worldPoint(x: number, y: number, z: number) {
  return new THREE.Vector3((x - 1.2) * scale, y * scale, -(z + 1.5) * scale)
}

function axisLabel(text: string, at: THREE.Vector3, height=.19) {
  const canvas = document.createElement('canvas')
  canvas.width=240
  canvas.height=60
  const context=canvas.getContext('2d')!
  context.font='600 31px Consolas,"Microsoft YaHei",sans-serif'
  context.fillStyle='#b5ddf2'
  context.textAlign='center'
  context.textBaseline='middle'
  context.lineWidth=5
  context.strokeStyle='rgba(4,21,39,.88)'
  context.strokeText(text,120,30)
  context.fillText(text,120,30)
  const map=new THREE.CanvasTexture(canvas)
  map.colorSpace=THREE.SRGBColorSpace
  const label=new THREE.Sprite(new THREE.SpriteMaterial({map,transparent:true,depthWrite:false,toneMapped:false}))
  label.scale.set(height*4,height,1)
  label.position.copy(at)
  return label
}

function hardware() {
  const result = new THREE.Group()
  const radius = 0.15 * scale, length = 1.2 * scale
  const barrel=new THREE.MeshStandardMaterial({color:0x007bb7,roughness:.32,metalness:.22})
  const endCap=new THREE.MeshStandardMaterial({color:0x11395a,roughness:.48,metalness:.18})
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 64),
    [barrel,endCap,endCap])
  body.rotation.x = Math.PI / 2
  body.position.copy(worldPoint(0,0,-1.5))
  result.add(body)
  const ringGeometry = new THREE.TorusGeometry(radius, .008, 8, 64)
  const ringMat = new THREE.MeshBasicMaterial({color:0x7cdbff})
  for (const end of [-1, 1]) {
    const rim = new THREE.Mesh(ringGeometry, ringMat)
    rim.position.copy(body.position)
    rim.position.z += end * length / 2
    result.add(rim)
  }
  // Draw an open coordinate plane so the spatial reference stays behind the wake.
  const grid:THREE.Vector3[]=[], rulers:THREE.Vector3[]=[]
  const yMin=-.9, zNear=-2.1, zFar=-.9, xMin=-.6, xMax=3
  for(let i=0;i<=12;i++){
    const x=xMin+.30*i
    grid.push(worldPoint(x,yMin,zNear),worldPoint(x,yMin,zFar))
  }
  for(let j=0;j<=4;j++){
    const z=zNear+.30*j
    grid.push(worldPoint(xMin,yMin,z),worldPoint(xMax,yMin,z))
  }
  rulers.push(worldPoint(xMin,yMin,zFar),worldPoint(xMax,yMin,zFar),
    worldPoint(xMin,yMin,zFar),worldPoint(xMin,.9,zFar))
  for(let i=-6;i<=30;i++){
    const x=i*.1, tick=i%5===0?.057:.026
    rulers.push(worldPoint(x,yMin,zFar),worldPoint(x,yMin+tick,zFar))
  }
  for(const [points,opacity] of [[grid,.14],[rulers,.42]] as const){
    result.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({color:0x5aaadd,transparent:true,opacity,depthWrite:false})))
  }
  for(const x of [0,1,2])result.add(axisLabel(String(x),worldPoint(x,yMin+.12,zFar)))
  result.add(axisLabel('X / m',worldPoint(2.78,yMin+.12,zFar),.22),
    axisLabel('Y',worldPoint(xMin,.68,zFar),.22),
    axisLabel('Z',worldPoint(xMin,yMin+.12,-1.66),.22))
  return result
}

function disposeObject(object: THREE.Object3D) {
  const resources = new Set<THREE.Material | THREE.BufferGeometry>()
  object.traverse(item => {
    const mesh = item as THREE.Mesh
    if (mesh.geometry) resources.add(mesh.geometry)
    if (mesh.material) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.forEach(mat => {
        resources.add(mat)
        if ((mat as THREE.SpriteMaterial).isSpriteMaterial) (mat as THREE.SpriteMaterial).map?.dispose()
      })
    }
  })
  resources.forEach(resource => resource.dispose())
  object.removeFromParent()
}

interface StreamLayer {
  object: THREE.Group
  advance(seconds: number): void
}

/** Instantaneous streamlines of one frozen velocity field, integrated in metres. */
function traceStreams(manifest: WakeManifest, fields: ScalarVolume[], quality: number): StreamLayer {
  const {nx,ny,nz,lod}=fields[0]
  const axes=[manifest.axes_m.X,manifest.axes_m.Y,manifest.axes_m.Z]
  const origin=axes.map(axis=>axis[0])
  const pitch=axes.map(axis=>(axis.at(-1)!-axis[0])/(axis.length-1)*lod)
  function velocity(p: THREE.Vector3) {
    const gx=(p.x-origin[0])/pitch[0], gy=(p.y-origin[1])/pitch[1], gz=(p.z-origin[2])/pitch[2]
    const x=Math.floor(gx), y=Math.floor(gy), z=Math.floor(gz)
    if (x<0 || y<0 || z<0 || x+1>=nx || y+1>=ny || z+1>=nz) return
    const u=[0,0,0]
    for(let k=0;k<2;k++) for(let j=0;j<2;j++) for(let i=0;i<2;i++){
      const index=((z+k)*ny+y+j)*nx+x+i
      const weight=(i?gx-x:1-gx+x)*(j?gy-y:1-gy+y)*(k?gz-z:1-gz+z)
      for(let component=0;component<3;component++){
        const v=fields[component].values[index]
        if(!Number.isFinite(v))return
        u[component]+=weight*v
      }
    }
    return new THREE.Vector3(...u)
  }
  const paths: THREE.Vector3[][]=[]
  const segments: number[]=[]
  const dt=.05
  // Upstream seeds on both sides and three span stations. Stop at invalid
  // interpolation stencils, stagnant regions, or the edge of the CFD grid.
  const stations=quality===2 ? [0] : quality===1 ? [-.36,.36] : [-.36,0,.36]
  for(const spanOffset of stations) for(const cross of [-.33,-.18,-.065,.065,.18,.33]){
    const p=new THREE.Vector3(-.5,cross,-1.5+spanOffset)
    const track: THREE.Vector3[]=[]
    for(let i=0;i<250;i++){
      const v1=velocity(p)
      if(!v1||v1.lengthSq()<1e-6)break
      const mid=p.clone().addScaledVector(v1,dt*.5)
      const v2=velocity(mid)
      if(!v2)break
      track.push(worldPoint(p.x,p.y,p.z))
      p.addScaledVector(v2,dt)
    }
    if(track.length<5)continue
    paths.push(track)
    for(let i=1;i<track.length;i++)segments.push(...track[i-1].toArray(),...track[i].toArray())
  }
  const object=new THREE.Group()
  const lines=new THREE.BufferGeometry()
  lines.setAttribute('position',new THREE.Float32BufferAttribute(segments,3))
  object.add(new THREE.LineSegments(lines,new THREE.LineBasicMaterial({
    color:0x67caff,transparent:true,opacity:.52,depthWrite:false,
  })))
  const dots=new THREE.BufferGeometry()
  const positions=new THREE.Float32BufferAttribute(new Float32Array(paths.length*3),3)
  positions.setUsage(THREE.DynamicDrawUsage)
  dots.setAttribute('position',positions)
  const marker=new THREE.Points(dots,new THREE.PointsMaterial({
    size:.052,color:0xbfeeff,depthWrite:false,toneMapped:false,
  }))
  marker.frustumCulled=false
  object.add(marker)
  const interpolated=new THREE.Vector3()
  function advance(seconds:number){
    paths.forEach((path,index)=>{
      const s=(Math.max(0,seconds)/dt+index*19)%(path.length-1)
      const i=Math.floor(s)
      interpolated.lerpVectors(path[i],path[i+1],s-i)
      positions.setXYZ(index,interpolated.x,interpolated.y,interpolated.z)
    })
    positions.needsUpdate=true
  }
  advance(0)
  return {object,advance}
}

function paletteTexture(colors: string[]) {
  const bytes = new Uint8Array(256 * 4)
  const palette = colors.map(hex => Number.parseInt(hex.slice(1), 16))
  for (let i=0; i<256; i++) {
    const pos = i / 255 * (palette.length-1)
    const low = Math.floor(pos), high = Math.min(low+1, palette.length-1)
    for (let c=0; c<3; c++) {
      const shift = 16-8*c
      bytes[4*i+c] = Math.round(THREE.MathUtils.lerp((palette[low]>>shift)&255, (palette[high]>>shift)&255, pos-low))
    }
    bytes[4*i+3] = 255
  }
  const texture = new THREE.DataTexture(bytes, 256, 1, THREE.RGBAFormat)
  texture.minFilter = texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

// RG8 holds scalar and validity separately. At NaN boundaries, discard any
// interpolated sample whose eight-voxel neighbourhood is not entirely valid.
function scalarTexture(field: ScalarVolume, range: Range) {
  const data = new Uint8Array(field.values.length * 2)
  const factor = 255 / (range[1]-range[0])
  for (let i=0; i<field.values.length; i++) {
    const val = field.values[i]
    if (!Number.isFinite(val)) continue
    data[2*i] = Math.max(0, Math.min(255, Math.round((val-range[0])*factor)))
    data[2*i+1] = 255
  }
  const tex = new THREE.Data3DTexture(data, field.nx, field.ny, field.nz)
  tex.format = THREE.RGFormat
  tex.minFilter = tex.magFilter = THREE.LinearFilter
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

const vertexShader = `
  out vec3 localPoint;
  out vec3 rayOrigin;
  void main(){
    localPoint = position;
    vec4 viewPoint = modelViewMatrix * vec4(position,1.);
    // Perspective rays share the eye. Orthographic rays start at each
    // pixel's own XY on the near plane, then travel parallel to view −Z.
    vec3 viewOrigin = vec3(0.);
    if (isOrthographic) {
      float nearZ = (-1. - projectionMatrix[3][2]) / projectionMatrix[2][2];
      viewOrigin = vec3(viewPoint.xy, nearZ);
    }
    rayOrigin = (inverse(modelViewMatrix) * vec4(viewOrigin, 1.)).xyz;
    gl_Position = projectionMatrix * viewPoint;
  }
`
const fragmentShader = `
  precision highp sampler3D;
  uniform sampler3D field;
  uniform sampler2D lut;
  uniform float stride, slicePosition, ambient, sliceMode;
  uniform vec2 opacityWindow;
  uniform mat4 localToClip;
  uniform int nSteps;
  in vec3 localPoint;
  in vec3 rayOrigin;
  out vec4 fragment;
  vec2 bounds(vec3 o, vec3 d) {
    vec3 inv = sign(d+vec3(1e-8))/max(abs(d),vec3(1e-8));
    vec3 a = (-.5-o)*inv, b=(.5-o)*inv;
    vec3 lo=min(a,b), hi=max(a,b);
    return vec2(max(max(lo.x,lo.y),lo.z),min(min(hi.x,hi.y),hi.z));
  }
  vec2 sampleVolume(vec3 pos){
    // Each source sample represents a cell centre. With stride>1 the first
    // retained sample stays at source index 0, not at the LOD cell midpoint.
    vec3 uvw = vec3(pos.x+.5,pos.y+.5,.5-pos.z);
    uvw += .5*(stride-1.)/vec3(192.,96.,64.);
    return texture(field,uvw).rg;
  }
  void main(){
    vec3 ray=normalize(localPoint-rayOrigin);
    vec2 t=bounds(rayOrigin,ray);
    float begin=max(0.,t.x), end=t.y;
    if (begin>=end) discard;
    if(sliceMode>.5){
      if(abs(ray.z)<1e-6) discard;
      float hit=(slicePosition-rayOrigin.z)/ray.z;
      if(hit<begin || hit>end) discard;
      vec2 value=sampleVolume(rayOrigin+hit*ray);
      if(value.g<.998) discard;
      vec4 projected=localToClip*vec4(rayOrigin+hit*ray,1.);
      gl_FragDepth=projected.z/projected.w*.5+.5;
      fragment=vec4(texture(lut,vec2(value.r,.5)).rgb,.97);
      return;
    }
    float dt=(end-begin)/float(nSteps);
    vec4 acc=vec4(0.);
    float front=end;
    for(int i=0;i<176;i++){
      if(i>=nSteps || acc.a>.985) break;
      vec2 value=sampleVolume(rayOrigin+(begin+(float(i)+.5)*dt)*ray);
      if(value.g<.998) continue;
      float magnitude=abs(value.r-ambient);
      if(magnitude<=opacityWindow.x) continue;
      float a=1.-exp(-dt*16.*smoothstep(opacityWindow.x,opacityWindow.y,magnitude));
      if(acc.a<.012 && acc.a+(1.-acc.a)*a>=.012)front=begin+(float(i)+.5)*dt;
      vec3 rgb=texture(lut,vec2(value.r,.5)).rgb;
      acc.rgb+=(1.-acc.a)*a*rgb;
      acc.a+=(1.-acc.a)*a;
    }
    if(acc.a<.012) discard;
    vec4 projected=localToClip*vec4(rayOrigin+front*ray,1.);
    gl_FragDepth=projected.z/projected.w*.5+.5;
    fragment=vec4(acc.rgb/max(acc.a,1e-5),acc.a);
  }
`

export async function createWake(group: THREE.Group, changed: () => void): Promise<Wake> {
  const manifest = await loadWakeManifest()
  const equipment = hardware()
  // The plot origin is 1.2 m downstream of the cylinder, exactly four diameters.
  const sections={enabled:{value:1},worldPitch:.30*scale}
  group.add(equipment)
  let probeMarker:THREE.Sprite|undefined
  function setProbe(coordinates?:readonly number[]){
    if(coordinates && !probeMarker){
      const canvas=document.createElement('canvas')
      canvas.width=180;canvas.height=70
      const ctx=canvas.getContext('2d')!
      ctx.strokeStyle='#14383e';ctx.lineWidth=7
      ctx.beginPath();ctx.arc(14,52,9,0,Math.PI*2);ctx.stroke()
      ctx.strokeStyle='#fff0aa';ctx.lineWidth=3;ctx.stroke()
      ctx.beginPath();ctx.moveTo(21,45);ctx.lineTo(40,22);ctx.lineTo(47,22);ctx.stroke()
      ctx.font='600 25px "Microsoft YaHei", sans-serif'
      ctx.strokeStyle='#14383e';ctx.lineWidth=5;ctx.strokeText('测点',51,30)
      ctx.fillStyle='#fff0aa';ctx.fillText('测点',51,30)
      const texture=new THREE.CanvasTexture(canvas)
      texture.colorSpace=THREE.SRGBColorSpace
      probeMarker=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false,depthWrite:false,toneMapped:false}))
      probeMarker.center.set(14/180,1-52/70)
      probeMarker.scale.set(1.1,1.1*70/180,1)
      probeMarker.renderOrder=20
      equipment.add(probeMarker)
    }
    if(!probeMarker)return
    probeMarker.visible=Boolean(coordinates)
    if(coordinates)probeMarker.position.copy(worldPoint(coordinates[0],coordinates[1],coordinates[2]))
    changed()
  }
  const lut = paletteTexture(manifest.palette)
  const material = new THREE.ShaderMaterial({
    uniforms: {
      field: {value: null}, lut: {value: lut}, stride: {value: 2}, nSteps: {value: 104},
      sliceMode: {value: 0}, slicePosition: {value: 0}, ambient: {value: .5},
      opacityWindow: {value: new THREE.Vector2(.015,.27)}, localToClip:{value:new THREE.Matrix4()},
    },
    vertexShader, fragmentShader, glslVersion: THREE.GLSL3, transparent: true,
    side: THREE.BackSide, depthWrite: false, toneMapped: false,
  })
  const volumeBox = new THREE.Mesh(new THREE.BoxGeometry(),material)
  volumeBox.scale.copy(extent)
  volumeBox.visible = false
  volumeBox.onBeforeRender=(_renderer,_scene,camera)=>{
    material.uniforms.localToClip.value.copy(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse).multiply(volumeBox.matrixWorld)
  }
  group.add(volumeBox)
  const loader = new GLTFLoader()
  let serial = 0, destroyed = false, coreKey = '', scalarKey = ''
  let core: THREE.Object3D | undefined
  const meshes = new Map<string, THREE.Object3D>()
  const meshRequests = new Map<string, Promise<THREE.Object3D>>()
  let surfaceReads=new AbortController()
  let quality = 0
  let visibleView:WakeView='structure', surfaceLod=2
  type Interval={fromStep:number;toStep:number;high:Asset;low:Asset}
  let transitions:Promise<Interval[]>|undefined
  let layers:ReturnType<typeof createSurfaceLayers>|undefined
  type Pair=ReturnType<typeof prepareSurfaceBlend>
  type PairEntry={from:string;to:string;pair?:Pair;reads:AbortController;ready?:Promise<void>;warm?:Promise<void>}
  const pairs=new Map<string,PairEntry>()
  let shaderReady:Promise<unknown>|undefined
  let activePair:Pair|undefined
  let texture: THREE.Data3DTexture | undefined
  let flowEnabled=false, frameNumber=0, flowVersion=0
  let stream: StreamLayer | undefined, streamRequest: Promise<void> | undefined
  function surfaceAsset(frame: WakeFrame, lod: number) {
    return (quality > 0 || lod >= 4) && frame.assets.structureLow ? frame.assets.structureLow : frame.assets.structure
  }
  function cachedSurface(asset:Asset) {
    const cached = meshes.get(asset.path)
    if (cached) {
      meshes.delete(asset.path);meshes.set(asset.path,cached)
    }
    return cached
  }
  function trimMeshes(keep?:THREE.Object3D) {
    if(meshes.size<=5)return
    const retained=new Set<string>()
    for(const entry of pairs.values()){
      retained.add(entry.from);retained.add(entry.to)
    }
    for(const [path,mesh] of meshes){
      if(mesh===core || mesh===keep || retained.has(path))continue
      meshes.delete(path)
      disposeObject(mesh)
      if(meshes.size<=5)break
    }
  }
  function loadSurface(asset: Asset) {
    const cached=cachedSurface(asset)
    if(cached)return Promise.resolve(cached)
    const pending = meshRequests.get(asset.path)
    if (pending) return pending
    const signal=surfaceReads.signal
    const request = readAsset(asset,dataRoot,signal).then(bytes=>{
      signal.throwIfAborted()
      return loader.parseAsync(bytes,dataRoot.href)
    }).then(model => {
      if (destroyed||signal.aborted) {
        disposeObject(model.scene)
        throw new Error('场景已关闭')
      }
      lightWakeSurface(surfaceMesh(model.scene).material,sections)
      meshes.set(asset.path,model.scene)
      trimMeshes(model.scene)
      return model.scene
    }).finally(() => {
      // A rapid return to chapter one may already have started a fresh read.
      if(meshRequests.get(asset.path)===request)meshRequests.delete(asset.path)
    })
    meshRequests.set(asset.path,request)
    return request
  }
  function readTransitions() {
    return transitions??=fetch(new URL('transitions/index.json',dataRoot)).then(async r=>{
      if(!r.ok)throw Error('缺少 C04 涡面对应数据')
      const index=await r.json() as {schema:string;intervals:Interval[]}
      if(index.schema!=='flowscope.c04.surface-correspondence.v1'||index.intervals.length!==manifest.frames.length-1)throw Error('C04 涡面对应清单不匹配')
      return index.intervals
    }).catch(e=>{transitions=undefined;throw e})
  }
  const pairKey=(i:number,lod:number)=>surfaceAsset(manifest.frames[i],lod).path+'|'+surfaceAsset(manifest.frames[i+1],lod).path
  function dropPair(key:string,entry:PairEntry){
    entry.reads.abort()
    entry.pair?.dispose()
    pairs.delete(key)
    trimMeshes()
  }
  function preparePair(i:number,lod:number) {
    if(i<0||i+1>=manifest.frames.length||destroyed)return
    const a=manifest.frames[i], b=manifest.frames[i+1]
    const key=pairKey(i,lod)
    const existing=pairs.get(key)
    if(existing)return existing
    const aAsset=surfaceAsset(a,lod), bAsset=surfaceAsset(b,lod)
    const record:PairEntry={from:aAsset.path,to:bAsset.path,reads:new AbortController()}
    pairs.set(key,record)
    if(pairs.size>4){
      for(const [old,entry] of pairs){
        if(old===key || (entry.pair && entry.pair===activePair))continue
        dropPair(old,entry);break
      }
    }
    const light=quality>0||lod>=4
    const indices=readTransitions().then(intervals=>{
      record.reads.signal.throwIfAborted()
      const entry=intervals[i]
      if(entry.fromStep!==a.step||entry.toStep!==b.step)throw Error('C04 涡面对应时刻不匹配')
      return readAsset(light?entry.low:entry.high,dataRoot,record.reads.signal)
    })
    record.ready=Promise.all([loadSurface(aAsset),loadSurface(bAsset),indices]).then(([aScene,bScene,indices])=>{
      if(destroyed||pairs.get(key)!==record)return
      const start=surfaceMesh(aScene), end=surfaceMesh(bScene)
      layers??=createSurfaceLayers(start.material,sections)
      record.pair=prepareSurfaceBlend(start.geometry,end.geometry,indices,layers)
      if(frameNumber===i && visibleView==='structure')changed()
    }).catch(()=>{
      // Archive inspection stays available when optional transition data is
      // missing. Retry if the user revisits this interval.
      if(pairs.get(key)===record)dropPair(key,record)
    })
    return record
  }
  async function warmStart(renderer:THREE.WebGLRenderer,camera:THREE.Camera,scene:THREE.Scene) {
    if(frameNumber!==0||visibleView!=='structure'||destroyed)return
    const entry=preparePair(0,surfaceLod)
    if(!entry)return
    return entry.warm??=(async()=>{
      await entry.ready
      const pair=entry.pair,signal=entry.reads.signal
      if(!pair||signal.aborted||renderer.getContext().isContextLost())return
      shaderReady??=renderer.compileAsync(pair.object,camera,scene).catch(error=>{
        shaderReady=undefined
        throw error
      })
      await shaderReady
      if(signal.aborted||frameNumber!==0||visibleView!=='structure'||activePair||!core?.visible||!layers)return
      // Upload both VAOs and complete the driver's first draw while still showing
      // exactly the archived 0 s pixels. Using the live framebuffer also keeps
      // tone mapping, output encoding, lighting and the chosen GPU program identical.
      const previous=layers.fraction.value
      layers.fraction.value=0
      core.visible=false
      group.add(pair.object)
      try {renderer.render(scene,camera)}
      finally {pair.object.removeFromParent();core.visible=true;layers.fraction.value=previous}
      const gl=renderer.getContext() as WebGL2RenderingContext
      const fence=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0)
      if(!fence)return
      gl.flush()
      const deadline=performance.now()+500
      try {
        while(!signal.aborted && !gl.isContextLost() && performance.now()<deadline &&
              gl.clientWaitSync(fence,0,0)===gl.TIMEOUT_EXPIRED){
          await new Promise<void>(resolve=>window.setTimeout(resolve,8))
        }
      }finally{gl.deleteSync(fence)}
    })().catch(()=>{})
  }
  function restoreArchive() {
    if(!activePair)return false
    activePair.object.removeFromParent()
    activePair=undefined
    if(core)core.visible=visibleView==='structure'
    return true
  }
  function discardSurfaceWork() {
    restoreArchive()
    for(const [key,entry] of pairs)dropPair(key,entry)
    surfaceReads.abort()
    meshRequests.clear()
  }
  function setSteps() {
    const stride=material.uniforms.stride.value
    const maximum=quality===2 ? 32 : quality===1 ? 56 : 160
    material.uniforms.nSteps.value=Math.min(maximum,stride>=4 ? 54 : stride===1 ? 160 : 96)
  }
  function clearStreams(){
    ++flowVersion
    if(stream)disposeObject(stream.object)
    stream=undefined
    streamRequest=undefined
  }
  function ensureStreams(){
    if(!flowEnabled || stream || destroyed)return Promise.resolve()
    if(streamRequest)return streamRequest
    const version=flowVersion
    const frame=manifest.frames[frameNumber]
    const velocityLod=quality===2 ? 4 : 2
    streamRequest=Promise.all(['u','v','w'].map(ch=>loadScalar(manifest,frame,ch,velocityLod)))
      .then(fields=>{
        if(version!==flowVersion || destroyed)return
        stream=traceStreams(manifest,fields,quality)
        group.add(stream.object)
        changed()
      }).finally(()=>{if(version===flowVersion)streamRequest=undefined})
    return streamRequest
  }
  async function update(frameIndex: number, channel: string, view: WakeView, slice: number, lod=2, presented?:()=>void) {
    const ticket = ++serial
    const frame = manifest.frames[frameIndex]
    if (!frame || !manifest.display_ranges[channel]) throw new Error('无效的 C04 帧或变量')
    if (destroyed) return
    if (view === 'structure') {
      const asset = surfaceAsset(frame,lod)
      if (coreKey !== asset.path) {
        // A preloaded archive endpoint can enter this very display tick.
        const model = cachedSurface(asset) ?? await loadSurface(asset)
        if (ticket !== serial || destroyed) return
        restoreArchive()
        core?.removeFromParent()
        core = model
        group.add(core)
        coreKey = asset.path
      }
      restoreArchive()
      surfaceLod=lod
      volumeBox.visible = false
      if (core) core.visible = true
    } else {
      const key = [frame.step,channel,lod].join('/')
      if (key !== scalarKey) {
        const field = await loadScalar(manifest,frame,channel,lod)
        if (ticket !== serial || destroyed) return
        const previous = texture
        texture = scalarTexture(field,manifest.display_ranges[channel])
        material.uniforms.field.value = texture
        previous?.dispose()
        material.uniforms.stride.value = field.lod
        setSteps()
        const range=manifest.display_ranges[channel]
        material.uniforms.ambient.value=((channel==='u' ? .5 : 0)-range[0])/(range[1]-range[0])
        const opacity: Record<string, [number, number]> = {
          u:[.015,.27], v:[.012,.22], w:[.006,.125], p:[.002,.035], omega:[.008,.18],
        }
        material.uniforms.opacityWindow.value.set(...opacity[channel])
        scalarKey = key
      }
      material.uniforms.sliceMode.value = view==='slice' ? 1 : 0
      material.uniforms.slicePosition.value = .5-(THREE.MathUtils.clamp(slice,0,63)+.5)/64
      restoreArchive()
      if (core) core.visible = false
      volumeBox.visible = true
    }
    visibleView=view
    if(frameNumber!==frameIndex){
      clearStreams()
      frameNumber=frameIndex
    }
    presented?.()
    changed()
    await ensureStreams()
  }
  return {manifest,update,warmStart,setProbe,
    prefetch(index,channel,view,lod) {
      const frame=manifest.frames[index]
      if (!frame || destroyed) return
      if (view==='structure') {
        preparePair(index-1,lod)
        preparePair(index,lod)
      } else if (scalarRequests.size<2) {
        void loadScalar(manifest,frame,channel,lod).catch(()=>{})
      }
    },
    blend(fromFrame,phase) {
      if(phase<=0||fromFrame!==frameNumber||!core||visibleView!=='structure'||fromFrame+1>=manifest.frames.length)return restoreArchive()
      const pair=pairs.get(pairKey(fromFrame,surfaceLod))?.pair
      if(!pair||!layers)return restoreArchive()
      const fraction=THREE.MathUtils.clamp(phase,0,1)
      if(activePair===pair&&layers.fraction.value===fraction)return false
      if(activePair!==pair){
        restoreArchive()
        group.add(pair.object)
        activePair=pair
        core.visible=false
      }
      layers.fraction.value=fraction
      return true
    },
    setQuality(level) {
      if (quality===level) return
      quality=level
      clearStreams()
      setSteps()
    },
    setSections(enabled){sections.enabled.value=enabled?1:0;changed()},
    cancelUpdate(){ ++serial },
    hideFrame(){
      ++serial
      discardSurfaceWork()
      surfaceReads=new AbortController()
      core?.removeFromParent();core=undefined;coreKey=''
      const first=manifest.frames[0].assets
      for(const [path,model] of meshes){
        if(path===first.structure.path||path===first.structureLow?.path)continue
        disposeObject(model);meshes.delete(path)
      }
      volumeBox.visible=false
      flowEnabled=false
      if(probeMarker)probeMarker.visible=false
      clearStreams()
      frameNumber=0
    },
    async setStreamlines(enabled) {
      flowEnabled=enabled
      if(enabled)await ensureStreams()
      else clearStreams()
      changed()
    },
    tick(seconds){
      if(!stream||!flowEnabled||destroyed)return
      stream.advance(seconds)
      changed()
    },
    dispose() {
    destroyed=true
    ++serial
    discardSurfaceWork()
    // Three polls these materials during asynchronous shader compilation.
    if(shaderReady)void shaderReady.then(()=>layers?.dispose(),()=>layers?.dispose())
    else layers?.dispose()
    texture?.dispose()
    lut.dispose()
    clearStreams()
    disposeObject(equipment)
    disposeObject(volumeBox)
    for (const mesh of meshes.values()) disposeObject(mesh)
    meshes.clear()
  }}
}
