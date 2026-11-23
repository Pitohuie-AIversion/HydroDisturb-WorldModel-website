import * as THREE from 'three'

const sourceAttributes=['position','normal','color'] as const
type BufferOwner={endpointDrawn:boolean;retired?:THREE.BufferGeometry}
const owners=new WeakMap<THREE.BufferGeometry,BufferOwner>()

// A broad, neutral studio key reveals folds on both sides of the Q sheet.
// Keep the archived vorticity colour as the diffuse albedo, including between frames.
type SurfaceShader=Parameters<THREE.MeshStandardMaterial['onBeforeCompile']>[0]
export type AxialSections={enabled:{value:number};worldPitch:number}

function studioLight(shader:SurfaceShader,sections:AxialSections) {
  shader.uniforms.wakeSections=sections.enabled
  shader.uniforms.wakeSectionPitch={value:sections.worldPitch}
  shader.vertexShader=shader.vertexShader
    .replace('#include <common>','#include <common>\nvarying float wakeStation;\nuniform float wakeSectionPitch;')
    .replace('#include <project_vertex>','#include <project_vertex>\nwakeStation = transformed.x / wakeSectionPitch;')
  shader.fragmentShader=shader.fragmentShader
    .replace('#include <common>','#include <common>\nvarying float wakeStation;\nuniform float wakeSections;')
    .replace('#include <opaque_fragment>', `
    float key = smoothstep(-0.60, 0.82, dot(normal, vec3(-0.38, 0.77, 0.51)));
    float rim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
    outgoingLight = diffuseColor.rgb * (0.29 + 0.69 * key + 0.14 * rim) + 0.48 * totalSpecular;
    float sectionWidth = max(fwidth(wakeStation), 0.00001);
    float sectionDistance = abs(fract(wakeStation + 0.5) - 0.5) / sectionWidth;
    float section = 1.0 - smoothstep(0.15, 1.1, sectionDistance);
    outgoingLight *= 1.0 - 0.38 * wakeSections * section;
    #include <opaque_fragment>`)
}

export function lightWakeSurface(material:THREE.MeshStandardMaterial,sections:AxialSections) {
  material.roughness=.46
  material.onBeforeCompile=shader=>studioLight(shader,sections)
  material.customProgramCacheKey=()=>'c04-archive-studio'
}

function disposeBorrower(geometry:THREE.BufferGeometry) {
  geometry.setIndex(null)
  for(const name of sourceAttributes)geometry.deleteAttribute(name)
  geometry.dispose()
}

/** Interpolate archived Q-surface geometry. The two meshes can have different
 * topology, so each moves toward its own correspondence on the other surface. */
export function createSurfaceLayers(base:THREE.MeshStandardMaterial,sections:AxialSections) {
  const fraction={value:0}
  function layerMaterial(incoming:boolean) {
    const material=base.clone()
    material.customProgramCacheKey=()=>'c04-surface-transition-v1'
    material.onBeforeCompile=shader=>{
      studioLight(shader,sections)
      shader.uniforms.wakePhase=fraction
      shader.uniforms.wakeIncoming={value:incoming?1:0}
      const declarations='uniform float wakePhase;\nuniform float wakeIncoming;'
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>', `#include <common>
          ${declarations}
          attribute vec3 nextPosition;
          attribute vec3 nextNormal;
          attribute vec3 nextColor;`)
        .replace('#include <color_vertex>', `#include <color_vertex>
          float weight = mix(wakePhase, 1.0 - wakePhase, wakeIncoming);
          vColor.rgb = mix(vColor.rgb, nextColor, weight);`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          objectNormal = mix(objectNormal, nextNormal, weight);`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed = mix(transformed, nextPosition, weight);`)
      // Complementary coverage avoids double-darkening where the two opaque
      // surfaces overlap. Depth testing and lighting still work while orbiting.
      shader.fragmentShader=shader.fragmentShader
        .replace('#include <common>', `#include <common>
          ${declarations}
          float bayer2(vec2 point){
            vec2 cell=mod(floor(point),2.0);
            return mod(2.0*cell.x+3.0*cell.y,4.0);
          }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float threshold=(4.0*bayer2(gl_FragCoord.xy)+bayer2(gl_FragCoord.xy*0.5)+0.5)/16.0;
          if ((threshold < wakePhase) != (wakeIncoming > 0.5)) discard;`)
    }
    return material
  }
  const outgoing=layerMaterial(false), incoming=layerMaterial(true)
  return {outgoing,incoming,fraction,dispose(){outgoing.dispose();incoming.dispose()}}
}

export function surfaceMesh(scene:THREE.Object3D) {
  // The exporter writes one indexed primitive in the shared world coordinate system.
  const child=scene.getObjectByProperty('isMesh',true) as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>|undefined
  if(!child?.geometry.index || !child.material.isMeshStandardMaterial)throw Error('C04 涡面结构不匹配')
  if(!owners.has(child.geometry)){
    const owner:BufferOwner={endpointDrawn:false}
    owners.set(child.geometry,owner)
    const afterRender=child.onAfterRender
    child.onAfterRender=function(...args){
      child.onAfterRender=afterRender
      owner.endpointDrawn=true
      if(owner.retired){disposeBorrower(owner.retired);owner.retired=undefined}
      afterRender.apply(this,args)
    }
    child.geometry.addEventListener('dispose',()=>{
      // If only a transition was drawn, its geometry registered these shared
      // buffers with Three. Let that final registered geometry release them.
      owner.retired?.dispose()
      owner.retired=undefined
    })
  }
  return child
}

function directedMesh(source:THREE.BufferGeometry, target:THREE.BufferGeometry, map:Uint16Array, material:THREE.MeshStandardMaterial) {
  // The cache retains each source while any transition borrows its buffers.
  // The endpoint and its incoming/outgoing draws can use the same GPU upload.
  const geometry=new THREE.BufferGeometry()
  geometry.setIndex(source.index)
  for(const name of sourceAttributes)geometry.setAttribute(name,source.getAttribute(name))
  const targetPosition=target.getAttribute('position'), targetNormal=target.getAttribute('normal'), targetColor=target.getAttribute('color')
  const pose=new Float32Array(map.length*6), colors=new Uint8Array(map.length*3)
  for(let i=0;i<map.length;i++){
    const j=map[i], p=6*i, c=3*i
    if(j>=targetPosition.count)throw Error('C04 涡面对应索引越界')
    pose[p]=targetPosition.getX(j);pose[p+1]=targetPosition.getY(j);pose[p+2]=targetPosition.getZ(j)
    pose[p+3]=targetNormal.getX(j);pose[p+4]=targetNormal.getY(j);pose[p+5]=targetNormal.getZ(j)
    colors[c]=Math.round(255*targetColor.getX(j));colors[c+1]=Math.round(255*targetColor.getY(j));colors[c+2]=Math.round(255*targetColor.getZ(j))
  }
  const vertexPose=new THREE.InterleavedBuffer(pose,6)
  geometry.setAttribute('nextPosition',new THREE.InterleavedBufferAttribute(vertexPose,3,0))
  geometry.setAttribute('nextNormal',new THREE.InterleavedBufferAttribute(vertexPose,3,3))
  geometry.setAttribute('nextColor',new THREE.BufferAttribute(colors,3,true))
  const mesh=new THREE.Mesh(geometry,material)
  mesh.frustumCulled=false
  let drawn=false
  mesh.onAfterRender=()=>{drawn=true}
  return {mesh,dispose(){
    const owner=owners.get(source)!
    if(drawn&&!owner.endpointDrawn&&!owner.retired)owner.retired=geometry
    else disposeBorrower(geometry)
  }}
}

export function prepareSurfaceBlend(from:THREE.BufferGeometry,to:THREE.BufferGeometry,indices:ArrayBuffer,layers:ReturnType<typeof createSurfaceLayers>) {
  const split=from.getAttribute('position').count
  if(indices.byteLength!==2*(split+to.getAttribute('position').count))throw Error('C04 涡面对应长度不符')
  const mapping=new Uint16Array(indices)
  const a=directedMesh(from,to,mapping.subarray(0,split),layers.outgoing)
  const b=directedMesh(to,from,mapping.subarray(split),layers.incoming)
  const object=new THREE.Group()
  object.add(a.mesh,b.mesh)
  return {object,dispose(){object.removeFromParent();a.dispose();b.dispose()}}
}
