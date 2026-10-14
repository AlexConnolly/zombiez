import * as THREE from 'three';
import { EYE, type GameEvent, type PowerupKind, type Sim, type Zombie } from '../sim/game';
import { DIRS, FENCE_H, facingDir, floorHeight, floorIndex, maxBoards, placedPos, windowGeom, windowOpening, type MapDef, type V3 } from '../sim/map';
import { MELEE, WEAPONS, isMelee, type MeleeId, type WeaponId } from '../sim/weapons';

const C = {
  fog: 0x1b2433, fogDeep: 0x0e131c, moon: 0x8fa6c8, lamp: 0xe89a3c, wood: 0x5a3b26, plaster: 0x6b5843,
  skin: [0x6e7b5c, 0x7c8a68, 0x5d6a4e], shirt: [0x3b3a45, 0x4a3a2e, 0x2e3b4a], pants: 0x2a2a33,
  eyes: 0xf2d35b, gold: 0xe8b84a, red: 0xc2161b, blood: 0x7a0f12, power: 0x5cff8a,
};

export type Snap = { x: number; y: number; z: number; yaw: number };

const lam = (color: number, emissive = 0) => new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 1 : 0 });
const UNIT = new THREE.BoxGeometry(1, 1, 1);
const SPHERE = new THREE.SphereGeometry(1, 12, 8);
const PLANE = new THREE.PlaneGeometry(1, 1);
const TRACER = new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.6 });
const shared = new Set<THREE.Material>([TRACER]);
const cache = new Map<string, THREE.Material>();
function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) { m = make(); cache.set(key, m); shared.add(m); }
  return m;
}
const basic = (color: number) => cached(`b${color}`, () => new THREE.MeshBasicMaterial({ color }));
const lamC = (color: number) => cached(`l${color}`, () => lam(color));

/** Frees GPU resources under a node, except the shared ones above. */
function dispose(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && m.geometry !== UNIT && m.geometry !== SPHERE && m.geometry !== PLANE) m.geometry.dispose();
    for (const mat of [m.material ?? []].flat() as THREE.Material[]) {
      if (shared.has(mat)) continue;
      (mat as THREE.MeshLambertMaterial).map?.dispose();
      mat.dispose();
    }
  });
}

function tex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function boxMesh(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(UNIT, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  return m;
}

// Side silhouettes shared by the chalk outlines and the box icons, in a 120x50 box.
const GUN_PATHS: Record<WeaponId, string> = {
  p9: 'M30 10h50v12H62l-6 22H44l4-22H30z',
  ripper: 'M5 10h90v14H72l-4 26H56l2-26H40l-6 12H24l4-12H5z M95 14h20v6H95z',
  barnburner: 'M0 12h118v10H80l-26 10-8 18H32l6-24H0z',
  longshot: 'M0 16h120v8H66l-6 6-10 20H38l8-20H0z M46 6h30v8H46z',
  thumper: 'M4 10h100v14H76l-6 26H58l2-26H44l-4 18H30l2-18H4z',
  bucket: 'M14 6h92v24H72l-6 20H52l4-20H14z',
  zapper: 'M20 6h70l20 12-20 12H72l-6 20H54l4-20H20z',
  crossbow: 'M10 22h80v8H64l-8 18H44l6-18H10z M80 4h6v44h-6z',
};
const MELEE_PATHS: Record<MeleeId, string> = { knife: 'M10 25h60l10-5v10l-10-5', cricketBat: 'M4 20h40l70-6v22l-70-6H4z' };

const GUNS: Record<WeaponId, { len: number; h: number; w: number; color: number; mag?: number; stock?: boolean; scope?: boolean; glow?: boolean; bow?: boolean }> = {
  crossbow: { len: 0.6, h: 0.06, w: 0.05, color: 0x3a2a1c, stock: true, bow: true },
  p9: { len: 0.22, h: 0.06, w: 0.04, color: 0x2b2d31 },
  ripper: { len: 0.42, h: 0.08, w: 0.05, color: 0x26282b, mag: 0.16 },
  barnburner: { len: 0.72, h: 0.07, w: 0.05, color: 0x2b2d31, stock: true },
  longshot: { len: 0.85, h: 0.06, w: 0.05, color: 0x30302c, stock: true, scope: true },
  thumper: { len: 0.6, h: 0.09, w: 0.06, color: 0x2a3026, mag: 0.18, stock: true },
  bucket: { len: 0.42, h: 0.13, w: 0.13, color: 0x3c4a2e },
  zapper: { len: 0.42, h: 0.1, w: 0.08, color: 0x22262a, glow: true },
};

function gunModel(id: WeaponId) {
  const g = GUNS[id];
  const grp = new THREE.Group();
  const body = lam(g.color);
  grp.add(boxMesh(g.w, g.h, g.len, body, 0, 0, -g.len / 2));
  grp.add(boxMesh(g.w * 0.9, 0.12, 0.05, lam(0x1b1c1f), 0, -0.08, -0.04).rotateX(0.25));
  if (g.mag) grp.add(boxMesh(g.w * 0.8, g.mag, 0.05, lam(0x1b1c1f), 0, -g.mag / 2, -g.len * 0.45));
  if (g.stock) grp.add(boxMesh(g.w, g.h * 1.4, 0.22, lam(C.wood), 0, -0.02, 0.1));
  if (g.scope) grp.add(boxMesh(0.035, 0.035, 0.22, lam(0x111111), 0, g.h / 2 + 0.03, -g.len * 0.45));
  if (g.bow) {
    // Limbs across the front, a string back to the bolt, the bolt itself.
    grp.add(boxMesh(0.6, 0.03, 0.04, lam(0x1b1c1f), 0, 0.02, -g.len + 0.06));
    grp.add(boxMesh(0.012, 0.012, 0.45, lam(0xc8c0a8), 0, 0.045, -g.len + 0.2));
  }
  if (g.glow) grp.add(boxMesh(g.w * 1.05, 0.03, g.len * 0.8, new THREE.MeshBasicMaterial({ color: C.power }), 0, 0.02, -g.len / 2));
  grp.add(boxMesh(0.07, 0.09, 0.12, lam(0x3a2b22), 0, -0.1, 0.0)); // hand
  grp.userData.tip = new THREE.Vector3(0, 0.01, -g.len - 0.02);
  return grp;
}

function iconTexture(kind: PowerupKind) {
  return tex(128, 128, (g) => {
    g.fillStyle = 'rgba(92,255,138,0.18)';
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = g.strokeStyle = '#5cff8a';
    g.lineWidth = 9;
    if (kind === 'maxAmmo') {
      g.strokeRect(28, 52, 72, 46);
      for (const x of [38, 58, 78]) g.fillRect(x, 28, 12, 26);
    } else if (kind === 'instaKill') {
      g.beginPath(); g.arc(64, 56, 32, 0, Math.PI * 2); g.fill();
      g.fillRect(46, 76, 36, 24);
      g.fillStyle = '#111';
      g.beginPath(); g.arc(52, 54, 9, 0, Math.PI * 2); g.arc(76, 54, 9, 0, Math.PI * 2); g.fill();
    } else if (kind === 'doublePoints') {
      g.font = '700 62px Oswald, Impact';
      g.textAlign = 'center';
      g.fillText('x2', 64, 86);
    } else {
      g.beginPath(); g.arc(58, 72, 32, 0, Math.PI * 2); g.fill();
      g.fillRect(70, 26, 12, 22);
      g.fillStyle = '#e8b84a';
      g.beginPath(); g.arc(84, 22, 7, 0, Math.PI * 2); g.fill();
    }
  });
}

interface ZMesh {
  root: THREE.Group;
  body: THREE.Group;
  legs: THREE.Group[];
  arms: THREE.Group[];
  head: THREE.Object3D;
  phase: number;
  flinch: number;
  lastY: number;
}

interface Particle { m: THREE.Mesh; v: THREE.Vector3; life: number; grav: number }

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.05, 300);
  private level = new THREE.Group();
  private sim!: Sim;
  private boards = new Map<string, THREE.Mesh[]>();
  private debris = new Map<string, THREE.Group>();
  private zombies = new Map<number, ZMesh>();
  private dying: { z: ZMesh; t: number }[] = [];
  private pups = new Map<number, THREE.Mesh>();
  private pupMat = new Map<PowerupKind, THREE.MeshBasicMaterial>();
  private shots = new Map<number, THREE.Mesh>();
  private particles: Particle[] = [];
  private tracers: { l: THREE.Line; t: number }[] = [];
  private flashes: { m: THREE.Mesh; t: number; life: number; r: number }[] = [];
  private blast = new THREE.PointLight(0xffa040, 0, 10, 2);
  private box = new THREE.Group();
  private boxLid = new THREE.Group();
  private boxGun = new THREE.Group();
  private boxLight = new THREE.PointLight(C.gold, 4, 6, 2);
  private perkPanels: THREE.MeshLambertMaterial[] = [];
  private lever = new THREE.Group();
  private lamps: THREE.PointLight[] = [];
  private rain!: THREE.Points;
  private view = new THREE.Group();
  private guns = new Map<WeaponId, THREE.Group>();
  private gunId: WeaponId | null = null;
  private muzzle = new THREE.PointLight(0xffd29a, 0, 6, 2);
  private knife = new THREE.Group();
  private bat = new THREE.Group();
  private sky = new THREE.HemisphereLight(0x5a6a88, 0x1a120c, 1.1);
  private moon = new THREE.DirectionalLight(C.moon, 1.2);
  /** Where the menu camera circles. */
  private center = new THREE.Vector3(7, 1.5, 8);
  private trapFx = new Map<string, THREE.PointLight>();
  private fires = new Set<string>();
  private books: THREE.Mesh[] = [];
  private hatch = new THREE.Group();
  private recoil = 0;
  private melee = 0;
  private bob = 0;
  private shake = 0;
  private time = 0;
  reduceShake = false;
  thumbnail: string | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(C.fogDeep);
    this.scene.fog = new THREE.FogExp2(C.fog, 0.05);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera, this.level, this.blast);
    this.scene.add(this.sky);
    const moon = this.moon;
    moon.position.set(-30, 40, -20);
    this.scene.add(moon);
    this.camera.add(this.view);
    this.view.position.set(0.2, -0.19, -0.5);
    this.view.rotation.set(0.04, 0.1, 0);
    this.view.add(this.muzzle);
    this.knife.add(boxMesh(0.03, 0.02, 0.26, lam(0xb8bcc4), 0, 0, -0.13), boxMesh(0.04, 0.05, 0.1, lam(0x2a1e14), 0, 0, 0.05));
    this.knife.visible = false;
    this.camera.add(this.knife);
    this.bat.add(boxMesh(0.09, 0.03, 0.55, lam(0xc8a46a), 0, 0, -0.35), boxMesh(0.03, 0.03, 0.25, lam(0x2a1e14), 0, 0, 0.03));
    this.bat.visible = false;
    this.camera.add(this.bat);
    for (const k of ['maxAmmo', 'instaKill', 'doublePoints', 'nuke'] as PowerupKind[])
      this.pupMat.set(k, new THREE.MeshBasicMaterial({ map: iconTexture(k), transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false }));
    const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(6, 32), new THREE.MeshBasicMaterial({ color: 0xcfd9e8, fog: false }));
    moonDisc.position.set(-90, 70, -110);
    moonDisc.lookAt(0, 0, 0);
    this.scene.add(moonDisc);
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setFov(fov: number) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- level

  /** The country outside the Farmhouse: a flat field, trees and fences in the fog. */
  private countryside() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), lam(0x161d14));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.level.add(ground);
    // Trees and fence posts as dark silhouettes in the fog, placed by a fixed pattern.
    const treeMat = lam(0x0b0f0b);
    const trunk = lam(0x1a130d);
    for (let i = 0; i < 46; i++) {
      const a = i * 2.39996;
      const r = 27 + ((i * 37) % 26);
      const x = 7 + Math.cos(a) * r, z = 8 + Math.sin(a) * r;
      const h = 5 + ((i * 13) % 5);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.6 + (i % 3) * 0.5, h, 6), treeMat);
      cone.position.set(x, h / 2 + 1.2, z);
      this.level.add(cone, boxMesh(0.3, 1.4, 0.3, trunk, x, 0.7, z));
    }
    const post = lam(0x2a2018);
    for (let i = -14; i <= 28; i += 2.5) {
      this.level.add(boxMesh(0.15, 1.1, 0.15, post, i, 0.55, -9), boxMesh(0.15, 1.1, 0.15, post, i, 0.55, 26));
    }
    this.level.add(boxMesh(43, 0.1, 0.08, post, 7, 0.9, -9), boxMesh(43, 0.1, 0.08, post, 7, 0.9, 26));
  }

  /** Rain everywhere around the house but not inside it. */
  private makeRain(map: MapDef) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const f of map.floors) f.tiles.forEach((r, z) => [...r].forEach((t, x) => {
      if (t === ' ') return;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); z0 = Math.min(z0, z); z1 = Math.max(z1, z + 1);
    }));
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const n = map.ambience === 'forest' ? 0 : 3500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let x = 0, z = 0;
      do { x = cx - 30 + Math.random() * 60; z = cz - 30 + Math.random() * 60; } while (x > x0 - 0.5 && x < x1 + 0.5 && z > z0 - 0.5 && z < z1 + 0.5);
      pos.set([x, Math.random() * 18, z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rain = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8fa6c8, size: 0.025, transparent: true, opacity: 0.35 }));
    this.level.add(this.rain);
  }

  /** A map's own outside: ground boxes, props and the roof. All render only. */
  private townscape(map: MapDef) {
    const hex = (c: string) => parseInt(c.slice(1), 16);
    for (const g of map.ground ?? []) {
      const [ax, ay, az] = g.min, [bx, by, bz] = g.max;
      this.level.add(boxMesh(bx - ax, by - ay, bz - az, lamC(hex(g.color)), (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2));
    }
    const iron = lamC(0x111214);
    for (const p of map.props ?? []) {
      const grp = new THREE.Group();
      grp.position.set(...p.pos);
      grp.rotation.y = p.rot ?? 0;
      const [w, h, d] = p.size ?? [1, 1, 1];
      const col = p.color ? hex(p.color) : 0;
      if (p.kind === 'box') grp.add(boxMesh(w, h, d, lamC(col || 0x4a3428), 0, h / 2, 0));
      if (p.kind === 'house') {
        // A neighbour: brick block, some windows lit, mansard roof.
        grp.add(boxMesh(w, h, d, lamC(0x4e3226), 0, h / 2, 0));
        const lit = basic(0xd9a050), dark = basic(0x0c0e12);
        for (let f = 0; f * 3 + 3.6 < h; f++)
          for (const side of [-1, 1])
            for (const wx of [-2.5, 2]) {
              const on = Math.sin(p.pos[0] * 7.1 + f * 3.3 + wx * 1.7 + side) > 0.6;
              grp.add(boxMesh(1.4, 1.7, 0.05, on ? lit : dark, wx, f * 3 + 1.6, side * (d / 2 + 0.03)));
            }
        grp.add(boxMesh(w, 0.3, d - 4, lamC(0x24262b), 0, h + 0.15, 0));
        for (const side of [-1, 1]) grp.add(boxMesh(w, 0.2, 3.2, lamC(0x24262b), 0, h - 1.3, side * (d / 2 - 1.2)).rotateX(side * 0.75));
      }
      if (p.kind === 'car') {
        const paint = lamC(col || 0x333333);
        grp.add(boxMesh(1.8, 0.7, 4.2, paint, 0, 0.6, 0), boxMesh(1.6, 0.55, 2.2, paint, 0, 1.2, 0.2));
        grp.add(boxMesh(1.62, 0.4, 2.0, basic(0x0a0c10), 0, 1.22, 0.2));
        for (const [x, z] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]) grp.add(boxMesh(0.25, 0.6, 0.6, lamC(0x0c0c0c), x, 0.3, z));
      }
      if (p.kind === 'streetlamp') {
        grp.add(boxMesh(0.14, 5.2, 0.14, iron, 0, 2.6, 0), boxMesh(0.12, 0.12, 1, iron, 0, 5.2, 0.45), boxMesh(0.4, 0.15, 0.5, basic(0xffb347), 0, 5.1, 0.9));
        const light = new THREE.PointLight(0xff9a30, 30, 22, 1.4);
        light.position.set(0, 4.8, 0.9);
        grp.add(light);
      }
      if (p.kind === 'pine') {
        const pine = lamC(0x111a13);
        grp.add(boxMesh(0.35, h * 0.3, 0.35, lamC(0x1e150e), 0, h * 0.15, 0));
        for (let i = 0; i < 3; i++) {
          const cone = new THREE.Mesh(new THREE.ConeGeometry(w * (1 - i * 0.25), h * 0.4, 7), pine);
          cone.position.y = h * (0.35 + i * 0.22);
          grp.add(cone);
        }
      }
      if (p.kind === 'tent') {
        // An A-frame, open at the front (+z).
        const cloth = lamC(col || 0x5e5e44);
        const slope = Math.hypot(w / 2, h);
        for (const side of [-1, 1]) grp.add(boxMesh(0.04, slope, d, cloth, (side * w) / 4, h / 2, 0).rotateZ(side * Math.atan2(w / 2, h)));
        grp.add(boxMesh(w * 0.9, 0.05, d * 0.8, lamC(0x3a4a5a), 0, 0.03, 0));
      }
      if (p.kind === 'roof') {
        // A gable over a building of w by d, eaves at the prop's y, rising h; the ridge runs along the longer side.
        const tile = lamC(col || 0x2a2622);
        const long = w >= d, span = long ? d : w, run = long ? w : d;
        const half = span / 2 + 0.3;
        const slope = Math.hypot(half, h);
        const tilt = Math.atan2(h, half);
        for (const side of [-1, 1]) {
          const m = new THREE.Mesh(UNIT, tile);
          m.position.y = h / 2;
          if (long) { m.scale.set(run + 0.6, 0.12, slope); m.position.z = (side * half) / 2; m.rotation.x = side * tilt; }
          else { m.scale.set(slope, 0.12, run + 0.6); m.position.x = (side * half) / 2; m.rotation.z = -side * tilt; }
          grp.add(m);
        }
      }
      if (p.kind === 'minibus') {
        grp.add(boxMesh(2.2, 2.2, 6, lamC(col || 0xc8c4b8), 0, 1.4, 0), boxMesh(2.1, 0.7, 0.05, basic(0x0a0c10), 0, 2, -3.01));
        for (const [x, z] of [[-1, 2], [1, 2], [-1, -2], [1, -2]]) grp.add(boxMesh(0.25, 0.7, 0.7, lamC(0x0c0c0c), x, 0.35, z));
        for (const x of [-0.75, 0.75]) grp.add(boxMesh(0.3, 0.2, 0.05, basic(0xfff6e0), x, 0.9, -3.01));
        const beam = new THREE.SpotLight(0xf4f0ff, 40, 30, 0.45, 0.5, 1.2);
        beam.position.set(0, 0.9, -3.1);
        beam.target.position.set(0, 0, -20);
        grp.add(beam, beam.target);
      }
      if (p.kind === 'totem') grp.add(boxMesh(0.8, h, 0.8, lamC(0x5a4028), 0, h / 2, 0), boxMesh(1.6, 1.6, 0.3, lamC(0xb8902a), 0, h + 0.8, 0));
      if (p.kind === 'bin') grp.add(boxMesh(0.6, 1.05, 0.7, lamC(col || 0x1c1e22), 0, 0.53, 0), boxMesh(0.64, 0.06, 0.74, lamC(0x101010), 0, 1.08, 0));
      if (p.kind === 'railing') {
        // Black iron railings: a top bar and posts every 15 cm along the long side.
        const long = w > d;
        const len = long ? w : d;
        grp.add(boxMesh(long ? len : 0.05, 0.05, long ? 0.05 : len, iron, 0, h, 0));
        for (let i = 0; i <= len / 0.15; i++) {
          const o = -len / 2 + i * 0.15;
          grp.add(boxMesh(0.025, h, 0.025, iron, long ? o : 0, h / 2, long ? 0 : o));
        }
      }
      if (p.kind === 'steps') {
        // Steps down from pos: dropping h over a run of d towards +z.
        const n = Math.round(h / 0.25);
        for (let i = 0; i < n - 1; i++) {
          const top = -(i + 1) * (h / n);
          grp.add(boxMesh(w, h + top, d / n, lamC(0x403e3a), 0, (top - h) / 2, (i + 0.5) * (d / n)));
        }
      }
      if (p.kind === 'portico') {
        for (const x of [-w / 2 + 0.15, w / 2 - 0.15]) grp.add(boxMesh(0.3, h, 0.3, lamC(0xc8c0b0), x, h / 2, -d / 2 + 0.2));
        grp.add(boxMesh(w + 0.3, 0.3, d, lamC(0xc8c0b0), 0, h + 0.15, 0));
      }
      if (p.kind === 'balcony') {
        grp.add(boxMesh(w, 0.2, d, lamC(0xb8b0a0), 0, 0.1, 0));
        grp.add(boxMesh(w, 0.05, 0.05, iron, 0, 1.2, -d / 2));
        for (let i = 0; i <= w / 0.15; i++) grp.add(boxMesh(0.025, 1, 0.025, iron, -w / 2 + i * 0.15, 0.7, -d / 2));
      }
      this.level.add(grp);
    }
    if (map.roof) this.roof(map, map.roof);
  }

  /** Mansard roof over the top floor: slopes from the eaves to a flat top, with gaps for dormers and skylights. */
  private roof(map: MapDef, r: { eaves: number; ridge: number }) {
    const f = map.floors[map.floors.length - 1];
    const xs = f.tiles.flatMap((row) => [...row].flatMap((t, x) => (t === ' ' ? [] : [x])));
    const zs = f.tiles.flatMap((row, z) => (row.trim() ? [z] : []));
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + 1, z0 = Math.min(...zs), z1 = Math.max(...zs) + 1;
    const slate = lamC(0x2b2f36);
    const run = 3;
    const rise = r.ridge - r.eaves;
    const len = Math.hypot(run, rise);
    const tilt = Math.atan2(rise, run);
    const top = map.windows.filter((w) => w.floor === f.id);
    const gap = (x: number, side: 'n' | 's' | 'up', z = 0) => top.some((w) => w.facing === side && w.cells.some((c) => c[0] === x && (side !== 'up' || c[1] === z)));
    for (let x = x0; x < x1; x++) {
      for (const side of ['n', 's'] as const) {
        const sgn = side === 'n' ? -1 : 1;
        const edge = side === 'n' ? z0 - 0.5 : z1 + 0.5;
        // Over a dormer only a flat lid; elsewhere the slope.
        if (gap(x, side)) this.level.add(boxMesh(1, 0.15, 2.4, slate, x + 0.5, r.eaves + 2.6, edge - sgn * 1.2));
        else this.level.add(boxMesh(1, 0.15, len, slate, x + 0.5, r.eaves + rise / 2, edge - sgn * (run / 2)).rotateX(sgn * tilt));
      }
      for (let z = Math.round(z0 - 0.5 + run); z < z1 + 0.5 - run; z++) if (!gap(x, 'up', z)) this.level.add(boxMesh(1, 0.15, 1, slate, x + 0.5, r.ridge - 0.075, z + 0.5));
    }
    for (const w of top.filter((w) => w.facing === 'n' || w.facing === 's')) {
      const wx = w.cells.map((c) => c[0]);
      const sgn = w.facing === 'n' ? -1 : 1;
      const edge = w.facing === 'n' ? z0 - 0.5 : z1 + 0.5;
      for (const x of [Math.min(...wx) - 0.05, Math.max(...wx) + 1.05]) this.level.add(boxMesh(0.1, 2.6, 2.4, slate, x, r.eaves + 1.3, edge - sgn * 1.2));
    }
    // Chimney stacks on the party walls.
    for (const x of [x0 + 0.5, x1 - 0.5]) this.level.add(boxMesh(1, 2.2, 2, lamC(0x4e3226), x, r.ridge + 1, (z0 + z1) / 2));
  }

  load(sim: Sim) {
    this.sim = sim;
    const map = sim.map;
    this.scene.remove(this.level);
    dispose(this.level);
    this.level = new THREE.Group();
    this.scene.add(this.level);
    this.boards.clear();
    this.debris.clear();
    for (const z of this.zombies.values()) z.root.removeFromParent();
    this.zombies.clear();
    this.avatars.clear();
    for (const d of this.dying) d.z.root.removeFromParent();
    this.dying = [];
    this.lamps = [];
    this.perkPanels = [];
    if (map.ground) this.townscape(map);
    else this.countryside();
    this.makeRain(map);
    // The city is lit by orange sodium lamps through a thinner haze; the country by the moon; the forest clearing by a fire under a clear sky.
    const city = map.ambience === 'city', forest = map.ambience === 'forest';
    (this.scene.fog as THREE.FogExp2).color.setHex(city ? 0x2a221c : forest ? 0x0d141a : C.fog);
    (this.scene.fog as THREE.FogExp2).density = city ? 0.028 : forest ? 0.022 : 0.05;
    (this.scene.background as THREE.Color).setHex(city ? 0x16110d : forest ? 0x070b10 : C.fogDeep);
    this.sky.color.setHex(city ? 0x8a6a4a : 0x5a6a88);
    this.sky.intensity = city ? 0.9 : forest ? 1.5 : 1.1;
    this.moon.intensity = city ? 0.5 : forest ? 1.8 : 1.2;
    const fl = map.floors;
    const w = Math.max(...fl.map((f) => f.tiles[0].length)), d = Math.max(...fl.map((f) => f.tiles.length));
    this.center.set(w / 2, (fl[0].y + fl[fl.length - 1].y) / 2 + 1.5, d / 2);

    // Static boxes: one instanced mesh, colour per kind, slight variation so flat walls read as surfaces.
    // Waist-high rails are drawn as bars and posts below; everything else is one instanced mesh.
    const low = (r: (typeof sim.world.renderBoxes)[number]) => r.kind === 'rail' && r.box.max.y - r.box.min.y <= FENCE_H + 0.01;
    const rb = sim.world.renderBoxes.filter((r) => !low(r));
    const wood = lamC(0x3a2414);
    for (const { box: b } of sim.world.renderBoxes.filter(low)) {
      const long = b.max.x - b.min.x > b.max.z - b.min.z;
      const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      this.level.add(boxMesh(long ? 1 : 0.1, 0.08, long ? 0.1 : 1, wood, cx, b.max.y - 0.04, cz));
      if (b.max.y - b.min.y > 1.1) this.level.add(boxMesh(long ? 1 : 0.1, 0.08, long ? 0.1 : 1, wood, cx, b.min.y + 0.55, cz));
      for (const o of [-0.375, -0.125, 0.125, 0.375]) this.level.add(boxMesh(0.04, 0.95, 0.04, wood, cx + (long ? o : 0), b.min.y + 0.475, cz + (long ? 0 : o)));
    }
    // Maps with their own wall colours get an outside skin of brick, so the colours only show indoors.
    const skins: typeof rb = [];
    map.floors.forEach((f, fi) => {
      if (!f.wallColor) return;
      const Y = f.y, H = floorHeight(map, fi);
      f.tiles.forEach((row, z) => [...row].forEach((t, x) => {
        if (t !== '#' && t !== 'W') return;
        for (const [dx, dz] of Object.values(DIRS)) {
          if ((f.tiles[z + dz]?.[x + dx] ?? ' ') !== ' ') continue;
          const lo = t === 'W' ? windowOpening(map, map.windows.find((w) => w.floor === f.id && w.cells.some((c) => c[0] === x && c[1] === z))!) : null;
          const face = (y0: number, y1: number) => skins.push({ kind: 'wall', fi: -1, box: {
            min: { x: dx > 0 ? x + 1 : dx < 0 ? x - 0.03 : x, y: y0, z: dz > 0 ? z + 1 : dz < 0 ? z - 0.03 : z },
            max: { x: dx > 0 ? x + 1.03 : dx < 0 ? x : x + 1, y: y1, z: dz > 0 ? z + 1.03 : dz < 0 ? z : z + 1 } } });
          if (lo) { face(Y - 0.2, Y + lo[0]); face(Y + lo[1], Y + H); } else face(Y - 0.2, Y + H);
        }
      }));
    });
    const all = [...rb, ...skins];
    const inst = new THREE.InstancedMesh(UNIT, new THREE.MeshLambertMaterial(), all.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const cellar = (fi: number) => map.floors[fi].y < 0;
    all.forEach(({ box: b, kind, fi }, i) => {
      m.makeScale(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
      m.setPosition((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
      inst.setMatrixAt(i, m);
      const f = map.floors[fi];
      const base = !f ? 0x5e3b2c :
        kind === 'wall' ? (f.wallColor ? parseInt(f.wallColor.slice(1), 16) : cellar(fi) ? 0x4b4842 : fi === map.floors.length - 1 ? 0x5d4f40 : C.plaster) :
        kind === 'floor' ? (f.floorColor ? parseInt(f.floorColor.slice(1), 16) : cellar(fi) ? 0x3a3834 : 0x4a3424) :
        kind === 'stair' ? 0x553c28 : kind === 'rail' ? 0x2a1d14 : 0x2e2822;
      const n = Math.sin(b.min.x * 12.9898 + b.min.z * 78.233 + b.min.y * 3.1) * 43758.5453;
      col.setHex(base).multiplyScalar(0.92 + (n - Math.floor(n)) * 0.16);
      inst.setColorAt(i, col);
    });
    this.level.add(inst);

    const plank = lam(C.wood);
    for (const w of map.windows) {
      const g = windowGeom(map, w);
      const [dx, dz] = facingDir(w.facing);
      const [lo, hi] = windowOpening(map, w);
      const width = w.cells.length * map.cellSize;
      const list: THREE.Mesh[] = [];
      const n = maxBoards(w);
      for (let i = 0; i < n; i++) {
        let b: THREE.Mesh;
        if (w.facing === 'up') {
          // Skylight: boards laid flat across the opening.
          const xs = w.cells.map((c) => c[0]), zs = w.cells.map((c) => c[1]);
          const wx = Math.max(...xs) - Math.min(...xs) + 1, wz = Math.max(...zs) - Math.min(...zs) + 1;
          b = boxMesh(wx + 0.2, 0.07, 0.16, plank, g.center.x, g.center.y + floorHeight(map, floorIndex(map, w.floor)) - 0.05, g.center.z - wz / 2 + 0.1 + ((wz - 0.2) * i) / (n - 1));
          b.rotation.y = (i % 2 ? 1 : -1) * 0.08;
        } else {
          const y = g.center.y + lo + 0.12 + ((hi - lo - 0.24) * i) / (n - 1);
          b = boxMesh(width + 0.2, 0.16, 0.07, plank, g.center.x + dx * 0.55, y, g.center.z + dz * 0.55);
          b.rotation.y = dx ? Math.PI / 2 : 0;
          b.rotation[dx ? 'x' : 'z'] = (i % 2 ? 1 : -1) * 0.08;
        }
        list.push(b);
        this.level.add(b);
      }
      this.boards.set(w.id, list);
      // Upper windows with no path of their own: a lean-to roof the zombies climb.
      if (g.center.y > 0 && !w.approach) {
        const len = Math.hypot(g.spawn.x - g.outside.x, g.outside.y, g.spawn.z - g.outside.z);
        const roof = boxMesh(width + 1.6, 0.15, len, lam(0x2a2420));
        roof.position.set((g.spawn.x + g.outside.x) / 2 + dx * 0.3, g.outside.y / 2 - 0.1, (g.spawn.z + g.outside.z) / 2 + dz * 0.3);
        roof.lookAt(g.outside.x + dx * 0.3, g.outside.y - 0.1, g.outside.z + dz * 0.3);
        this.level.add(roof);
      }
    }

    for (const d of map.doors) {
      const grp = new THREE.Group();
      const fi = floorIndex(map, d.floor);
      const Y = map.floors[fi].y;
      for (const [x, z] of d.cells) {
        for (let i = 0; i < 3; i++) {
          const p = boxMesh(1.15, 0.14, 0.12, plank, x + 0.5, Y + 0.5 + i * 0.7, z + 0.5);
          p.rotation.set(0, (x * 3 + z) % 2 ? 0.2 : Math.PI / 2 - 0.2, (i % 2 ? 0.5 : -0.4));
          grp.add(p);
        }
        grp.add(boxMesh(0.55, 0.55, 0.55, lam(0x4a3020), x + 0.35, Y + 0.28, z + 0.5).rotateY(0.4));
        grp.add(boxMesh(0.5, 0.8, 0.5, lam(0x3d2a1c), x + 0.65, Y + 0.4, z + 0.45).rotateY(-0.3));
      }
      this.debris.set(d.id, grp);
      this.level.add(grp);
    }

    for (const wb of map.wallBuys) {
      const id = wb.weapon;
      const p = placedPos(map, wb);
      const [dx, dz] = DIRS[wb.facing];
      const t = tex(256, 160, (g) => {
        g.strokeStyle = 'rgba(232,226,208,0.9)';
        g.lineWidth = 4;
        g.save();
        g.translate(8, 18);
        g.scale(2, 2);
        g.stroke(new Path2D(isMelee(id) ? MELEE_PATHS[id] : GUN_PATHS[id as WeaponId]));
        g.restore();
        g.fillStyle = 'rgba(232,226,208,0.9)';
        g.font = '600 30px Oswald, Impact';
        g.textAlign = 'center';
        g.fillText(String(isMelee(id) ? MELEE[id].cost : WEAPONS[id as WeaponId].cost), 128, 150);
      });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.69), new THREE.MeshLambertMaterial({ map: t, transparent: true }));
      plane.position.set(p.x + dx * 0.49, p.y + 1.45, p.z + dz * 0.49);
      plane.lookAt(p.x, p.y + 1.45, p.z);
      this.level.add(plane);
    }

    for (const pk of map.perks) {
      const p = placedPos(map, pk);
      const tough = pk.perk === 'tough';
      const body = boxMesh(0.7, 2, 0.7, lam(tough ? 0x5a0d10 : 0x0b4a4a), p.x, p.y + 1, p.z);
      const panelMat = new THREE.MeshLambertMaterial({
        map: tex(128, 64, (g) => {
          g.fillStyle = tough ? '#e2453f' : '#2ec4b6';
          g.fillRect(0, 0, 128, 64);
          g.fillStyle = '#fff';
          g.font = '700 30px Oswald, Impact';
          g.textAlign = 'center';
          g.fillText(tough ? 'TOUGH' : 'QUICK', 64, 44);
        }),
        emissive: 0xffffff,
        emissiveIntensity: 0,
      });
      panelMat.emissiveMap = panelMat.map;
      this.perkPanels.push(panelMat);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.4, 0.72), [lam(0x222222), lam(0x222222), lam(0x222222), lam(0x222222), panelMat, panelMat]);
      panel.position.set(p.x, p.y + 1.6, p.z);
      this.level.add(body, panel);
    }

    if (map.power) {
      const p = placedPos(map, map.power);
      const [dx, dz] = DIRS[map.power.facing];
      const plate = boxMesh(dx ? 0.1 : 0.5, 0.8, dx ? 0.5 : 0.1, lam(0x2a2d33), p.x + dx * 0.45, p.y + 1.3, p.z + dz * 0.45);
      this.lever = new THREE.Group();
      this.lever.position.set(p.x + dx * 0.38, p.y + 1.2, p.z + dz * 0.38);
      this.lever.add(boxMesh(0.06, 0.4, 0.06, lam(0x9a9389), 0, 0.2, 0), boxMesh(0.12, 0.12, 0.12, lam(C.red), 0, 0.4, 0));
      this.lever.rotation.set(dz ? 0.6 : 0, 0, dx ? 0.6 : 0);
      this.level.add(plate, this.lever);
    }

    for (const l of map.lamps) {
      const p = placedPos(map, l);
      const top = p.y + floorHeight(map, floorIndex(map, l.floor)) - 0.2;
      const light = new THREE.PointLight(C.lamp, 9, 11, 1.6);
      light.position.set(p.x, top - 0.7, p.z);
      this.lamps.push(light);
      this.level.add(light, boxMesh(0.02, 0.5, 0.02, lam(0x111111), p.x, top - 0.25, p.z), boxMesh(0.1, 0.12, 0.1, new THREE.MeshBasicMaterial({ color: 0xffd9a0 }), p.x, top - 0.55, p.z));
    }

    this.trapFx.clear();
    this.fires.clear();
    for (const t of map.traps ?? []) {
      const p = placedPos(map, t);
      const light = new THREE.PointLight(0x4a8cff, 0, 14, 1.5);
      light.position.set(p.x, p.y + 1.3, p.z);
      if (t.kind === 'fire') {
        // The bonfire sits in the middle of the trap box: stones round a bed of embers. The paraffin can is at the use spot.
        const c = { x: (t.box.min[0] + t.box.max[0]) / 2, y: p.y, z: (t.box.min[2] + t.box.max[2]) / 2 };
        for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; this.level.add(boxMesh(0.35, 0.3, 0.35, lamC(0x55524c), c.x + Math.cos(a) * 1.3, c.y + 0.15, c.z + Math.sin(a) * 1.3)); }
        this.level.add(boxMesh(1.8, 0.12, 1.8, basic(0xff5a1a), c.x, c.y + 0.06, c.z), boxMesh(1.6, 0.25, 0.3, lamC(0x1e1612), c.x, c.y + 0.2, c.z), boxMesh(0.3, 0.3, 1.6, lamC(0x2a1a10), c.x, c.y + 0.25, c.z));
        this.level.add(boxMesh(0.3, 0.45, 0.2, lamC(0x8a2a1a), p.x, p.y + 0.22, p.z));
        light.color.setHex(0xff7a2a);
        light.position.set(c.x, c.y + 1, c.z);
        light.distance = 26;
        this.fires.add(t.id);
      } else if (t.kind === 'bell') {
        // The bell hangs in the tower above; its rope comes down to the use spot.
        this.level.add(boxMesh(0.03, 5, 0.03, lamC(0x8a7a5a), p.x, p.y + 3.5, p.z));
        const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, 0.8, 10), lamC(0x8a6a2a));
        bell.position.set(p.x, p.y + 6.4, p.z);
        this.level.add(bell);
        light.color.setHex(0xe8b84a);
      } else {
        // A cast-iron range with four burners.
        this.level.add(boxMesh(0.9, 0.9, 0.7, lamC(0x1c1d20), p.x, p.y + 0.45, p.z - 0.1));
        for (const [bx, bz] of [[-0.2, -0.25], [0.2, -0.25], [-0.2, 0.05], [0.2, 0.05]]) this.level.add(boxMesh(0.22, 0.03, 0.22, lamC(0x3a3a3e), p.x + bx, p.y + 0.915, p.z + bz));
      }
      this.trapFx.set(t.id, light);
      this.level.add(light);
    }
    for (const l of map.links ?? [])
      for (const end of [l.a, l.b]) {
        const p = placedPos(map, end);
        this.level.add(boxMesh(0.9, 0.9, 0.9, lamC(0x2a1e14), p.x + 0.1, p.y + 1.25, p.z), boxMesh(0.7, 0.6, 0.02, basic(0x0a0a0a), p.x - 0.36, p.y + 1.25, p.z).rotateY(Math.PI / 2));
      }

    this.books = [];
    this.hatch = new THREE.Group();
    if (map.secret) {
      // Ration books: small buff booklets, faintly lit so a careful player spots them.
      const medal = map.secret.reward === 'dawn';
      const bookMat = new THREE.MeshLambertMaterial({ color: medal ? 0xd8a838 : 0xc8b27a, emissive: medal ? 0x5a4010 : 0x3a3018 });
      this.books = map.secret.spots.map((sp) => {
        const p = placedPos(map, sp);
        const b = medal ? new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.03, 16), bookMat) : boxMesh(0.16, 0.03, 0.22, bookMat);
        b.position.set(p.x, p.y + 0.8, p.z);
        b.rotation.y = p.x * 1.3;
        this.level.add(b);
        return b;
      });
      const p = placedPos(map, map.secret.drop);
      this.hatch.position.set(p.x, p.y, p.z);
      this.hatch.add(boxMesh(1.1, 0.06, 1.1, lamC(0x1a1c1a), 0, 0.03, 0));
      const lid = new THREE.Group();
      lid.position.set(0, 0.07, -0.5);
      lid.add(boxMesh(1, 0.05, 1, lamC(0x4a5040), 0, 0, 0.5));
      this.hatch.add(lid);
      this.level.add(this.hatch);
    }

    // Mystery box: crate with a gold glow, lid that opens, and a weapon that floats out.
    this.box = new THREE.Group();
    const q = tex(128, 128, (g) => {
      g.fillStyle = '#5a3b26';
      g.fillRect(0, 0, 128, 128);
      g.strokeStyle = '#3a2616';
      g.lineWidth = 6;
      g.strokeRect(4, 4, 120, 120);
      g.fillStyle = '#e8b84a';
      g.font = '700 84px Oswald, Impact';
      g.textAlign = 'center';
      g.fillText('?', 64, 100);
    });
    const crateMat = new THREE.MeshLambertMaterial({ map: q, emissive: 0x3a2a08 });
    this.box.add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 0.6), crateMat).translateY(0.31));
    this.boxLid = new THREE.Group();
    this.boxLid.position.set(0, 0.62, -0.3);
    this.boxLid.add(boxMesh(0.92, 0.08, 0.62, lam(0x6b4a2b), 0, 0.04, 0.31));
    this.box.add(this.boxLid, this.boxLight, this.boxGun);
    this.boxLight.position.set(0, 1.2, 0);
    this.boxGun.position.set(0, 0.9, 0);
    this.boxGun.rotation.y = Math.PI / 2;
    this.level.add(this.box);
    this.placeBox();
  }

  private placeBox() {
    const s = this.sim.state;
    const p = placedPos(this.sim.map, this.sim.map.boxSpots[s.box.spot]);
    this.box.position.set(p.x, p.y, p.z);
  }

  // ---------------------------------------------------------------- zombies

  private zombieMesh(z: Zombie): ZMesh {
    const v = z.id % 3;
    const skin = lamC(C.skin[v]);
    const robe = this.sim.map.zombieSkin === 'robe';
    const shirt = lamC(robe ? [0xcfc8b4, 0xbdb6a0, 0xd8d2c0][(z.id >> 2) % 3] : C.shirt[(z.id >> 2) % 3]);
    const pants = lamC(robe ? 0xa8a18e : C.pants);
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const legs = [-0.12, 0.12].map((x) => {
      const g = new THREE.Group();
      g.position.set(x, 0.78, 0);
      g.add(boxMesh(0.18, 0.78, 0.2, pants, 0, -0.39, 0));
      body.add(g);
      return g;
    });
    body.add(boxMesh(0.5, 0.62, 0.28, shirt, 0, 1.08, 0));
    body.add(boxMesh(0.26, 0.2, 0.02, lamC(C.blood), 0.06, 0.95, -0.15));
    const arms = [-0.32, 0.32].map((x) => {
      const g = new THREE.Group();
      g.position.set(x, 1.33, 0);
      g.add(boxMesh(0.14, 0.62, 0.14, skin, 0, -0.31, 0));
      body.add(g);
      return g;
    });
    const head = new THREE.Group();
    head.position.set(0, 1.62, 0);
    const eye = basic(C.eyes);
    head.add(boxMesh(0.3, 0.32, 0.3, skin), boxMesh(0.06, 0.045, 0.02, eye, -0.07, 0.03, -0.155), boxMesh(0.06, 0.045, 0.02, eye, 0.07, 0.03, -0.155));
    body.add(head);
    this.level.add(root);
    return { root, body, legs, arms, head, phase: z.id, flinch: 0, lastY: z.pos.y };
  }

  private animateZombie(m: ZMesh, z: Zombie, dt: number) {
    const moving = z.state === 'approach' || (z.state === 'hunt' && z.attackT === 0);
    m.phase += dt * (z.run ? 11 : 5.5) * (moving ? 1 : 0.15);
    const s = Math.sin(m.phase);
    m.legs[0].rotation.x = s * (z.run ? 0.8 : 0.5) * (moving ? 1 : 0.1);
    m.legs[1].rotation.x = -m.legs[0].rotation.x;
    const reach = -Math.PI / 2 + 0.15;
    // Climbing a wall or drainpipe: hand over hand, legs kicking.
    const climbing = z.state === 'approach' && Math.abs(m.root.position.y - m.lastY) > dt * 0.4;
    m.lastY = m.root.position.y;
    if (climbing) {
      m.phase += dt * 6;
      m.arms[0].rotation.x = -Math.PI + 0.3 + Math.sin(m.phase) * 0.5;
      m.arms[1].rotation.x = -Math.PI + 0.3 - Math.sin(m.phase) * 0.5;
      m.legs[0].rotation.x = Math.sin(m.phase) * 0.6;
      m.legs[1].rotation.x = -m.legs[0].rotation.x;
    } else if (z.state === 'tear') {
      m.arms[0].rotation.x = reach - 0.5 + Math.sin(this.time * 9) * 0.6;
      m.arms[1].rotation.x = reach - 0.5 - Math.sin(this.time * 9) * 0.6;
    } else if (z.attackT > 0) {
      const k = z.attackT / 0.5;
      m.arms[0].rotation.x = m.arms[1].rotation.x = reach - 1.2 + k * 2.2;
    } else {
      m.arms[0].rotation.x = reach + s * 0.15;
      m.arms[1].rotation.x = reach - s * 0.15;
    }
    m.flinch = Math.max(0, m.flinch - dt);
    m.body.rotation.x = (z.run ? 0.25 : 0.08) + (z.state === 'climb' ? 0.5 : 0) - m.flinch * 3;
    m.body.rotation.z = Math.sin(m.phase * 0.5) * 0.06;
  }

  // ---------------------------------------------------------------- effects

  private particle(at: V3, color: number, n: number, speed: number, size = 0.045, life = 0.5) {
    const mat = basic(color);
    for (let i = 0; i < n; i++) {
      const m = boxMesh(size, size, size, mat, at.x, at.y, at.z);
      this.scene.add(m);
      this.particles.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed), life, grav: 9 });
    }
  }

  private flash(at: V3, color: number, r: number, life: number) {
    const m = new THREE.Mesh(SPHERE, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.set(at.x, at.y, at.z);
    // One light for all explosions, so the light count (and compiled shaders) never changes.
    this.blast.position.copy(m.position);
    this.blast.color.setHex(color);
    this.blast.distance = r * 4;
    this.scene.add(m);
    this.flashes.push({ m, t: 0, life, r });
  }

  onEvents(evs: GameEvent[], localId: string) {
    for (const e of evs) {
      switch (e.type) {
        case 'shot': {
          const mine = e.pid === localId;
          if (mine) {
            this.recoil = Math.min(1, this.recoil + (e.weapon === 'barnburner' || e.weapon === 'longshot' ? 1 : 0.5));
            this.muzzle.intensity = 6;
            if (e.weapon === 'barnburner') this.shake = Math.max(this.shake, 0.25);
          }
          for (const end of e.ends.slice(0, 4)) {
            const tip = mine ? this.gunTipWorld() : new THREE.Vector3(e.from.x, e.from.y - 0.3, e.from.z);
            const g = new THREE.BufferGeometry().setFromPoints([tip, new THREE.Vector3(end.x, end.y, end.z)]);
            const l = new THREE.Line(g, TRACER);
            this.scene.add(l);
            this.tracers.push({ l, t: 0.05 });
            this.particle(end, 0x8a8170, 2, 1.5, 0.04, 0.25);
          }
          break;
        }
        case 'hit': {
          const zm = this.zombies.get(e.zid);
          if (zm) zm.flinch = 0.15;
          this.particle({ x: e.pos.x, y: e.pos.y + (e.head ? 1.6 : 1.1), z: e.pos.z }, C.blood, e.head ? 8 : 5, 3);
          break;
        }
        case 'kill': {
          const zm = this.zombies.get(e.zid);
          this.particle({ x: e.pos.x, y: e.pos.y + (e.head ? 1.6 : 1.1), z: e.pos.z }, C.blood, e.head ? 14 : 8, 3.5);
          if (zm) {
            if (e.head) zm.head.visible = false;
            this.zombies.delete(e.zid);
            this.dying.push({ z: zm, t: 0 });
          }
          break;
        }
        case 'board': {
          const w = this.sim.map.windows.find((x) => x.id === e.window)!;
          if (e.torn) {
            const g = windowGeom(this.sim.map, w);
            this.particle({ x: g.center.x, y: g.center.y + 1.4, z: g.center.z }, C.wood, 4, 3, 0.12, 0.8);
          }
          break;
        }
        case 'explode':
          this.flash(e.pos, 0xffa040, e.radius, 0.35);
          this.particle(e.pos, 0x333333, 14, 6, 0.1, 0.9);
          this.shake = Math.max(this.shake, 0.5);
          break;
        case 'hurt':
          if (e.pid === localId) this.shake = Math.max(this.shake, 0.35);
          break;
        case 'boxMove':
          this.placeBox();
          break;
        case 'melee':
          if (e.pid === localId) this.melee = 0.3;
          break;
        case 'trap': {
          const t = this.sim.map.traps?.find((x) => x.id === e.id);
          const light = this.trapFx.get(e.id);
          if (!t || !light) break;
          if (t.kind === 'bell') { if (e.fire) { light.intensity = 30; this.shake = Math.max(this.shake, 0.3); } break; }
          if (!e.fire) { light.color.setHex(t.kind === 'fire' ? 0xffb040 : 0x4a8cff); light.intensity = 6; break; }
          // The gas goes up: fire through the whole trap box.
          light.color.setHex(0xff7a20);
          light.intensity = 60;
          const [ax, ay, az] = t.box.min, [bx, , bz] = t.box.max;
          for (let i = 0; i < 40; i++) {
            const at = { x: ax + Math.random() * (bx - ax), y: ay + 0.8 + Math.random() * 1.5, z: az + Math.random() * (bz - az) };
            this.flash(at, 0xff7a20, 1.2 + Math.random(), 0.6);
          }
          this.shake = Math.max(this.shake, 0.6);
          break;
        }
        case 'dawn':
          this.flash({ x: this.camera.position.x, y: this.camera.position.y + 20, z: this.camera.position.z }, 0xfff0c0, 40, 2);
          break;
        case 'power':
          this.lever.rotation.set(this.lever.rotation.x ? -0.6 : 0, 0, this.lever.rotation.z ? -0.6 : 0);
          break;
      }
    }
  }

  private gunTipWorld() {
    const g = this.gunId && this.guns.get(this.gunId);
    const v = new THREE.Vector3();
    if (!g) return this.camera.getWorldPosition(v);
    this.camera.updateMatrixWorld(true);
    return g.localToWorld(v.copy(g.userData.tip as THREE.Vector3));
  }

  // ---------------------------------------------------------------- frame

  /**
   * local.id is the player the camera follows: yourself, or a teammate while you spectate.
   */
  frame(dt: number, alpha: number, prev: Map<string | number, Snap>, local: { id: string; yaw: number; pitch: number; spectate?: boolean } | null, moving: boolean) {
    this.time += dt;
    const s = this.sim.state;
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const lerpAngle = (a: number, b: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * alpha;

    // Static state that changes.
    for (const w of this.sim.map.windows) this.boards.get(w.id)!.forEach((b, i) => (b.visible = i < s.windows[w.id].boards));
    for (const [id, g] of this.debris) g.visible = !s.doors[id];
    for (const p of this.perkPanels) p.emissiveIntensity = s.power ? 0.9 : 0;
    this.books.forEach((b, i) => (b.visible = s.secret.spots.includes(i)));
    const lid = this.hatch.children[1];
    if (lid && this.sim.map.secret) lid.rotation.x = s.secret.placed >= this.sim.map.secret.count ? -1.8 : 0;
    for (const [id, l] of this.trapFx) {
      const ts = s.traps[id];
      // A bonfire never goes out: it flickers between flares.
      const fire = this.fires.has(id);
      const rest = fire ? 30 * (0.8 + 0.2 * Math.sin(this.time * 11) * Math.sin(this.time * 6.7)) : 0;
      if (ts?.fuse > 0) l.intensity = Math.max(rest, 6 + Math.random() * 3);
      else l.intensity = Math.max(rest, l.intensity - dt * 40);
      if (fire && l.intensity <= rest) l.color.setHex(0xff7a2a);
    }
    // In the forest the lamps are festoon bulbs on the generator: dark until the power is on.
    const lampOn = this.sim.map.ambience !== 'forest' || s.power;
    this.lamps.forEach((l, i) => (l.intensity = !lampOn ? 0 : i === 1 ? 9 * (0.75 + 0.25 * Math.sin(this.time * 13) * Math.sin(this.time * 7.3)) : 9));

    // Zombies.
    const seen = new Set<number>();
    for (const z of s.zombies) {
      seen.add(z.id);
      let m = this.zombies.get(z.id);
      if (!m) { m = this.zombieMesh(z); this.zombies.set(z.id, m); }
      const p = prev.get(z.id) ?? { ...z.pos, yaw: z.yaw };
      m.root.position.set(lerp(p.x, z.pos.x), lerp(p.y, z.pos.y), lerp(p.z, z.pos.z));
      m.root.rotation.y = lerpAngle(p.yaw, z.yaw);
      this.animateZombie(m, z, dt);
      // A bell has rung: on their knees, heads bowed.
      if (s.frozen > 0) { m.body.position.y = -0.45; m.body.rotation.x = 0.35; m.legs[0].rotation.x = m.legs[1].rotation.x = -1.4; }
      else m.body.position.y = 0;
    }
    for (const [id, m] of this.zombies) if (!seen.has(id)) { m.root.removeFromParent(); this.zombies.delete(id); }
    for (const d of [...this.dying]) {
      d.t += dt;
      d.z.body.rotation.x = Math.max(-Math.PI / 2, -d.t * 5);
      d.z.body.position.y = d.t > 4 ? -(d.t - 4) * 0.5 : 0;
      if (d.t > 5) { d.z.root.removeFromParent(); this.dying.splice(this.dying.indexOf(d), 1); }
    }

    // Power-ups.
    const pseen = new Set<number>();
    for (const pu of s.powerups) {
      pseen.add(pu.id);
      let m = this.pups.get(pu.id);
      if (!m) {
        m = new THREE.Mesh(PLANE, this.pupMat.get(pu.kind));
        m.scale.setScalar(0.7);
        this.scene.add(m);
        this.pups.set(pu.id, m);
      }
      m.position.set(pu.pos.x, pu.pos.y + Math.sin(this.time * 3) * 0.1, pu.pos.z);
      m.rotation.y = this.time * 2;
      m.visible = pu.t > 5 || Math.sin(this.time * 20) > 0;
    }
    for (const [id, m] of this.pups) if (!pseen.has(id)) { m.removeFromParent(); this.pups.delete(id); }

    // Projectiles.
    const sseen = new Set<number>();
    for (const pr of s.projectiles) {
      sseen.add(pr.id);
      let m = this.shots.get(pr.id);
      if (!m) {
        m = new THREE.Mesh(SPHERE, basic(pr.weapon === 'zapper' ? C.power : 0x444a3a));
        m.scale.setScalar(pr.weapon === 'zapper' ? 0.12 : 0.08);
        this.scene.add(m);
        this.shots.set(pr.id, m);
      }
      m.position.set(pr.pos.x, pr.pos.y, pr.pos.z);
    }
    for (const [id, m] of this.shots) if (!sseen.has(id)) { m.removeFromParent(); this.shots.delete(id); }

    // Box.
    const b = s.box;
    this.boxLid.rotation.x = b.phase === 'idle' ? 0 : -1.9;
    this.boxLight.intensity = b.phase === 'idle' ? 2 : 8;
    const showGun: WeaponId | null =
      b.phase === 'rolling' ? (['ripper', 'barnburner', 'longshot', 'thumper', 'bucket', 'zapper'] as WeaponId[])[Math.floor(this.time * 7) % 6] :
      b.phase === 'offer' ? b.weapon : null;
    this.boxGun.clear();
    if (showGun) {
      this.boxGun.add(this.gun(showGun).clone());
      this.boxGun.position.y = 0.7 + Math.min(1, b.phase === 'rolling' ? b.t / 2 : 1) * 0.5;
    }

    // Particles, tracers, flashes.
    for (const p of [...this.particles]) {
      p.life -= dt;
      p.v.y -= p.grav * dt;
      p.m.position.addScaledVector(p.v, dt);
      if (p.life <= 0) { p.m.removeFromParent(); this.particles.splice(this.particles.indexOf(p), 1); }
    }
    for (const t of [...this.tracers]) {
      t.t -= dt;
      if (t.t <= 0) { t.l.removeFromParent(); t.l.geometry.dispose(); this.tracers.splice(this.tracers.indexOf(t), 1); }
    }
    for (const f of [...this.flashes]) {
      f.t += dt;
      const k = f.t / f.life;
      f.m.scale.setScalar(f.r * (0.3 + k));
      (f.m.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k);
      this.blast.intensity = 40 * (1 - k);
      if (k >= 1) { f.m.removeFromParent(); (f.m.material as THREE.Material).dispose(); this.flashes.splice(this.flashes.indexOf(f), 1); }
    }

    // Rain.
    const rp = this.rain.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      let y = rp.getY(i) - dt * 14;
      if (y < 0) y += 18;
      rp.setY(i, y);
    }
    rp.needsUpdate = true;

    this.updateAvatars(local?.id ?? '', dt);

    // Camera.
    const me = local && s.players.find((p) => p.id === local.id);
    if (me && local) {
      const p = prev.get(me.id) ?? { ...me.pos, yaw: 0 };
      if (moving && me.onGround) this.bob += dt * 9;
      const bobY = Math.sin(this.bob * 2) * 0.035 * (moving ? 1 : 0);
      this.recoil = Math.max(0, this.recoil - dt * 6);
      this.shake = Math.max(0, this.shake - dt * 2);
      const sh = this.reduceShake ? 0 : this.shake * this.shake;
      this.camera.position.set(lerp(p.x, me.pos.x) + (Math.random() - 0.5) * sh * 0.2, lerp(p.y, me.pos.y) + ((me.status !== 'alive') ? 0.35 : EYE) + bobY + (Math.random() - 0.5) * sh * 0.2, lerp(p.z, me.pos.z));
      this.camera.rotation.set(local.pitch + this.recoil * 0.035, local.yaw, me.status === 'down' ? 0.4 : 0);
      this.updateView(me.weapons[me.cur].id, me.melee, me.reloadT > 0, dt);
      this.view.visible = !local.spectate && (me.status === 'alive' || me.status === 'down');
    } else {
      // Menu: slow orbit around the house.
      const a = this.time * 0.05;
      const c = this.center;
      // In a street the neighbours are in the way, so the camera drifts along the pavement opposite instead.
      if (this.sim.map.ambience === 'city') this.camera.position.set(c.x + Math.sin(a * 2) * 9, 2.5, -14);
      else this.camera.position.set(c.x + Math.cos(a) * 17, c.y + 4, c.z + Math.sin(a) * 17);
      this.camera.lookAt(c);
      this.view.visible = false;
    }
    this.renderer.render(this.scene, this.camera);
    if (!this.thumbnail && !me && this.time > 1) this.thumbnail = this.renderer.domElement.toDataURL('image/jpeg', 0.8);
  }

  // ---------------------------------------------------------------- teammates

  private avatars = new Map<string, { root: THREE.Group; body: THREE.Group; legs: THREE.Group[]; mats: THREE.MeshLambertMaterial[]; tag: THREE.Sprite; phase: number; last: V3; down: boolean }>();

  private avatar(id: string, idx: number) {
    const color = [0x3a6ea5, 0xa5543a, 0x3aa56e, 0xa59a3a][idx % 4];
    const mat = (c: number) => new THREE.MeshLambertMaterial({ color: c, transparent: true });
    const jacket = mat(0x2e3440), stripe = mat(color), skin = mat(0xc8a27c), pants = mat(0x22262e), dark = mat(0x1b1c1f);
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const legs = [-0.12, 0.12].map((x) => {
      const g = new THREE.Group();
      g.position.set(x, 0.78, 0);
      g.add(boxMesh(0.18, 0.78, 0.22, pants, 0, -0.39, 0));
      body.add(g);
      return g;
    });
    body.add(boxMesh(0.5, 0.62, 0.3, jacket, 0, 1.08, 0), boxMesh(0.52, 0.12, 0.32, stripe, 0, 1.2, 0));
    for (const x of [-0.3, 0.3]) {
      const arm = new THREE.Group();
      arm.position.set(x, 1.33, 0);
      arm.rotation.x = -1.3;
      arm.add(boxMesh(0.13, 0.55, 0.13, jacket, 0, -0.27, 0));
      body.add(arm);
    }
    body.add(boxMesh(0.08, 0.1, 0.55, dark, 0.05, 1.25, -0.45));
    body.add(boxMesh(0.28, 0.3, 0.28, skin, 0, 1.6, 0), boxMesh(0.3, 0.1, 0.3, stripe, 0, 1.76, 0));
    const tagTex = tex(256, 64, (g) => {
      g.font = '600 34px Oswald, Impact';
      g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillText(id, 130, 46);
      g.fillStyle = '#' + color.toString(16).padStart(6, '0');
      g.fillText(id, 128, 44);
    });
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthTest: false, transparent: true }));
    tag.scale.set(1.2, 0.3, 1);
    tag.position.y = 2.15;
    tag.renderOrder = 10;
    root.add(tag);
    this.level.add(root);
    return { root, body, legs, mats: [jacket, stripe, skin, pants, dark], tag, phase: 0, last: { x: 0, y: 0, z: 0 }, down: false };
  }

  /** Teammates: walk animation, lying down when downed, see-through while reconnecting, hidden when out. */
  private updateAvatars(viewId: string, dt: number) {
    const seen = new Set<string>();
    this.sim.state.players.forEach((p, i) => {
      if (p.id === viewId || p.id === this.localId) return;
      const show = p.status === 'alive' || p.status === 'down';
      if (!show) return;
      seen.add(p.id);
      let a = this.avatars.get(p.id);
      if (!a) { a = this.avatar(p.id, i); this.avatars.set(p.id, a); a.last = { ...p.pos }; }
      a.root.position.set(p.pos.x, p.pos.y, p.pos.z);
      a.root.rotation.y = p.yaw;
      const speed = Math.hypot(p.pos.x - a.last.x, p.pos.z - a.last.z) / Math.max(dt, 1e-3);
      a.last = { ...p.pos };
      a.phase += dt * Math.min(speed, 7) * 2.2;
      a.legs[0].rotation.x = Math.sin(a.phase) * Math.min(speed / 4, 1) * 0.6;
      a.legs[1].rotation.x = -a.legs[0].rotation.x;
      a.body.rotation.x = p.status === 'down' ? -1.35 : 0;
      a.body.position.y = p.status === 'down' ? 0.25 : 0;
      for (const m of a.mats) m.opacity = p.connected ? 1 : 0.35;
      (a.tag.material as THREE.SpriteMaterial).color.set(p.status === 'down' ? 0xff4444 : 0xffffff);
    });
    for (const [id, a] of this.avatars)
      if (!seen.has(id)) { a.root.removeFromParent(); dispose(a.root); this.avatars.delete(id); }
  }

  /** Set by the app so the renderer never draws an avatar for the local player. */
  localId = '';

  private gun(id: WeaponId) {
    let g = this.guns.get(id);
    if (!g) { g = gunModel(id); this.guns.set(id, g); }
    return g;
  }

  private updateView(id: WeaponId, melee: MeleeId, reloading: boolean, dt: number) {
    if (this.gunId !== id) {
      if (this.gunId) this.view.remove(this.gun(this.gunId));
      this.view.add(this.gun(id));
      this.gunId = id;
    }
    const g = this.gun(id);
    g.position.set(Math.sin(this.bob) * 0.01, Math.sin(this.bob * 2) * 0.008 + (reloading ? -0.12 : 0), this.recoil * 0.06);
    g.rotation.set(this.recoil * 0.12 + (reloading ? -0.6 : 0), 0, reloading ? 0.4 : 0);
    this.muzzle.position.copy(g.userData.tip as THREE.Vector3);
    this.muzzle.intensity = Math.max(0, this.muzzle.intensity - dt * 120);
    this.melee = Math.max(0, this.melee - dt);
    const blade = melee === 'cricketBat' ? this.bat : this.knife;
    this.knife.visible = this.bat.visible = false;
    blade.visible = this.melee > 0;
    g.visible = this.melee <= 0;
    const k = 1 - this.melee / 0.3;
    blade.position.set(0.3 - k * 0.5, -0.2, -0.45);
    blade.rotation.set(0, 0.8 - k * 1.6, -0.3);
  }
}
