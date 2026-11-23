import * as T from 'three';

export const ink = '#18374f';
export const teal = '#087cad';
export const aqua = '#37b4e7';
export const purple = '#7155a8';
export const orange = '#bb652d';
export type Point = [number, number, number];
export const vec = (p: Point) => new T.Vector3(...p);

const labelTextures = new Map<string, { texture: T.CanvasTexture; width: number; height: number }>();

export interface Chapter {
  update(progress: number): void;
  useFilmData?(active: boolean): void;
  pick(raycaster: T.Raycaster): void;
  dispose(): void;
  render?(renderer: T.WebGLRenderer, scene: T.Scene, camera: T.Camera, orbitTarget?: T.Vector3): boolean;
}

export class Stage {
  readonly root = new T.Group();
  readonly controls = document.createElement('section');
  readonly targets = new Map<T.Object3D, (hit: T.Intersection) => void>();
  private readonly controller = new AbortController();
  alive = true;
  animate: (progress: number) => void = () => {};
  onDispose?: () => void;
  useFilmData?: Chapter['useFilmData'];
  render?: Chapter['render'];
  private readonly ambience: T.Points;
  private ambiencePhase = 0;

  constructor(group: T.Group, panel: HTMLElement, readonly changed: () => void) {
    group.add(this.root);
    const ambienceGeometry = new T.BufferGeometry();
    const ambiencePositions: number[] = [];
    for (let i = 0; i < 96; i++) {
      const x = -4.5 + (i % 16) * .6;
      const y = -2.25 + (Math.floor(i / 16) % 6) * .84;
      const z = -.92 - (i % 3) * .08;
      ambiencePositions.push(x, y, z);
    }
    ambienceGeometry.setAttribute('position', new T.Float32BufferAttribute(ambiencePositions, 3));
    const ambienceMaterial = new T.PointsMaterial({ color: '#70aaa3', size: .026, transparent: true, opacity: .22, depthWrite: false, sizeAttenuation: true });
    this.ambience = new T.Points(ambienceGeometry, ambienceMaterial);
    this.ambience.renderOrder = -2;
    this.root.add(this.ambience);
    const guide = new T.LineLoop(new T.BufferGeometry().setFromPoints(Array.from({length: 65}, (_, i) => {
      const a = i / 64 * Math.PI * 2;
      return new T.Vector3(Math.cos(a) * 4.15, Math.sin(a) * 1.8, -.88);
    })), new T.LineBasicMaterial({ color: '#8ab6af', transparent: true, opacity: .16, depthWrite: false }));
    guide.renderOrder = -1;
    this.root.add(guide);
    this.controls.className = 'model-controls';
    panel.replaceChildren(this.controls);
  }

  on<K extends keyof HTMLElementEventMap>(el: HTMLElement, name: K, fn: (event: HTMLElementEventMap[K]) => void) {
    el.addEventListener(name, fn, { signal: this.controller.signal });
  }
  get<E extends HTMLElement>(selector: string): E {
    return this.controls.querySelector<E>(selector)!;
  }
  update(progress: number) {
    const p = Math.max(0, Math.min(1, progress));
    this.animate(p);
    this.ambiencePhase += .018;
    this.ambience.rotation.z = Math.sin(this.ambiencePhase * .7) * .012;
    this.ambience.position.y = Math.sin(this.ambiencePhase) * .025;
    const material = this.ambience.material as T.PointsMaterial;
    material.opacity = .16 + .07 * (.5 + .5 * Math.sin(this.ambiencePhase));
  }
  pick(raycaster: T.Raycaster) {
    const active = [...this.targets.keys()].filter(object => {
      for (let p: T.Object3D | null = object; p; p = p.parent) if (!p.visible) return false;
      return true;
    });
    const hit = raycaster.intersectObjects(active, false)[0];
    if (hit) this.targets.get(hit.object)?.(hit);
  }
  dispose() {
    this.alive = false;
    this.onDispose?.();
    this.controller.abort();
    const geometries = new Set<T.BufferGeometry>();
    const materials = new Set<T.Material>();
    const textures = new Set<T.Texture>();
    this.root.traverse(obj => {
      const mesh = obj as T.Mesh;
      if (mesh.geometry && !(obj instanceof T.Sprite)) geometries.add(mesh.geometry);
      if (mesh.material) for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(mat);
        for (const value of Object.values(mat)) if (value instanceof T.Texture && !value.userData.flowScopeShared) textures.add(value);
      }
      if (obj instanceof T.InstancedMesh) obj.dispose();
    });
    for (const geo of geometries) geo.dispose();
    for (const mat of materials) mat.dispose();
    for (const tex of textures) tex.dispose();
    this.root.removeFromParent();
    this.controls.remove();
    this.targets.clear();
  }
}

export function label(parent: T.Object3D, title: string, point: Point, size = .22, color = ink) {
  const key = title + '\u0000' + color;
  let cached = labelTextures.get(key);
  if (!cached) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = '600 56px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.font = font;
    c.width = Math.ceil(ctx.measureText(title).width + 14);
    c.height = 80;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    // A narrow white halo keeps labels legible over coloured geometry.
    ctx.strokeStyle = 'rgba(255,255,255,0.88)';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeText(title, c.width / 2, 41);
    ctx.fillText(title, c.width / 2, 41);
    const texture = new T.CanvasTexture(c);
    texture.userData.flowScopeShared = true;
    cached = { texture, width: c.width, height: c.height };
    labelTextures.set(key, cached);
  }
  const { texture } = cached;
  texture.colorSpace = T.SRGBColorSpace;
  const sprite = new T.Sprite(new T.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
  sprite.scale.set(size * cached.width / cached.height, size, 1);
  sprite.position.set(...point);
  sprite.renderOrder = 12;
  parent.add(sprite);
  return sprite;
}

export function line(parent: T.Object3D, points: Point[], color = teal, dashed = false) {
  const geometry = new T.BufferGeometry().setFromPoints(points.map(vec));
  const mat = dashed
    ? new T.LineDashedMaterial({color, dashSize: .08, gapSize: .055})
    : new T.LineBasicMaterial({color});
  const obj = new T.Line(geometry, mat);
  if (dashed) obj.computeLineDistances();
  parent.add(obj);
  return obj;
}

export function arrow(parent: T.Object3D, from: Point, to: Point, color = teal, width = .018) {
  const start = vec(from);
  const end = vec(to);
  const dir = end.clone().sub(start).normalize();
  const tipLength = Math.min(.15, start.distanceTo(end) * .32);
  const shaftEnd = end.clone().addScaledVector(dir, -tipLength * .85);
  const rotation = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir);
  const mat = new T.MeshBasicMaterial({color});
  const shaft = new T.Mesh(new T.CylinderGeometry(width, width, shaftEnd.distanceTo(start), 8), mat);
  shaft.position.copy(start).lerp(shaftEnd, .5);
  shaft.quaternion.copy(rotation);
  const tip = new T.Mesh(new T.ConeGeometry(width * 3.2, tipLength, 10), mat);
  tip.position.copy(end).addScaledVector(dir, -tipLength / 2);
  tip.quaternion.copy(rotation);
  parent.add(shaft, tip);
}

export function chip(parent: T.Object3D, point: Point, size: Point, color: string, opacity = .92) {
  const geometry = new T.BoxGeometry(...size);
  const material = new T.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= .9 });
  const mesh = new T.Mesh(geometry, material);
  mesh.position.set(...point);
  // Very faint volume shells are already outlined by their lattice or adjacent
  // flow line. Avoid a second draw call for those shells while keeping the
  // stronger inspection chips outlined.
  if (opacity >= .28) {
    const edges = new T.LineSegments(new T.EdgesGeometry(geometry), new T.LineBasicMaterial({ color: new T.Color(color).lerp(new T.Color(ink), .33) }));
    mesh.add(edges);
  }
  parent.add(mesh);
  return mesh;
}

export function marker(parent: T.Object3D, color: string, radius = .09) {
  const ball = new T.Mesh(new T.SphereGeometry(radius, 12, 8), new T.MeshBasicMaterial({color}));
  parent.add(ball);
  return ball;
}

/** A unit-cell lattice on the three faces that form a tensor's visible shell. */
export function tensor(parent: T.Object3D, point: Point, dimensions: Point, color: string, density = 7) {
  const g = new T.Group();
  g.position.set(...point);
  parent.add(g);
  const [w, h, d] = dimensions;
  const body = chip(g, [0,0,0], dimensions, color, .13);
  const coords: number[] = [];
  const seg = (a: Point, b: Point) => coords.push(...a, ...b);
  for (let n = 0; n <= density; n++) {
    const u = n / density - .5;
    seg([u*w,-h/2,d/2], [u*w,h/2,d/2]);
    seg([u*w,h/2,-d/2], [u*w,h/2,d/2]);
    seg([-w/2,u*h,d/2], [w/2,u*h,d/2]);
    seg([w/2,u*h,-d/2], [w/2,u*h,d/2]);
    seg([-w/2,h/2,u*d], [w/2,h/2,u*d]);
    seg([w/2,-h/2,u*d], [w/2,h/2,u*d]);
  }
  const geo = new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(coords,3));
  g.add(new T.LineSegments(geo,new T.LineBasicMaterial({color,transparent:true,opacity:.65})));
  return {g, body};
}

export function buttons(names: string[], attr: string) {
  return '<div class="mc-buttons">' + names.map((name, i) => '<button type="button" data-'+attr+'="'+i+'">'+name+'</button>').join('') + '</div>';
}
export function selectButton(root: HTMLElement, attr: string, selected: number) {
  root.querySelectorAll<HTMLButtonElement>('[data-'+attr+']').forEach((button, i) => {
    const pressed = String(i === selected);
    if (button.getAttribute('aria-pressed') !== pressed) button.setAttribute('aria-pressed', pressed);
  });
}
export function range(name: string, min: number, max: number, value: number, id: string) {
  return '<label class="mc-range"><span>'+name+'</span><output data-out="'+id+'">'+value+'</output><input aria-label="'+name+'" data-range="'+id+'" type="range" min="'+min+'" max="'+max+'" value="'+value+'"></label>';
}
export function check(name: string, id: string, enabled = true) {
  return '<label class="mc-check"><input type="checkbox" data-flag="'+id+'" '+(enabled ? 'checked' : '')+'>'+name+'</label>';
}
export function timeIndexLabel(frame: number) {
  return frame === 0 ? 't' : frame > 0 ? 't+'+frame : 't−'+(-frame);
}

