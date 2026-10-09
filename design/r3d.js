// Shared concept-render engine for map specs: open a scene file (townhouse.html, store.html) in a browser.
// ------------------------------------------------------------------ tiny 3D-to-SVG renderer
// Flat-shaded quads, perspective camera, point lights with soft falloff, fog, painter's sort, fake glow.
const V = (x, y, z) => ({ x, y, z });
const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, k) => V(a.x * k, a.y * k, a.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a) => Math.hypot(a.x, a.y, a.z);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp3 = (a, b, t) => add(a, mul(sub(b, a), t));
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/** The Townhouse is drawn 1.5x the size of the first plans (9 x 18 m inside). People and props keep their size. */
const SCALE = 1.5;
function Scene(o = {}) {
  return { quads: [], lights: [], glows: [], lines: [], ambient: o.ambient ?? [0.1, 0.1, 0.12], fog: o.fog ?? null, sky: o.sky ?? null, exposure: o.exposure ?? 1.5, s: o.s ?? SCALE, rawMode: false };
}
/** Building coordinates are scaled across and deep (not up); anything drawn inside withRaw is placed as given. */
const xf = (sc, p) => (sc.rawMode ? p : V(p.x * sc.s, p.y, p.z * sc.s));
function withRaw(sc, fn) { sc.rawMode = true; try { fn(); } finally { sc.rawMode = false; } }
function quad(sc, p0, p1, p2, p3, color, o = {}) { sc.quads.push({ p: [p0, p1, p2, p3].map((p) => xf(sc, p)), c: hex(color), o }); }
/** Axis box; corners are listed counter-clockwise seen from outside so back faces can be culled. */
function box(sc, x0, y0, z0, x1, y1, z1, color, o = {}) {
  const c = (x, y, z) => V(x, y, z);
  const faces = {
    front: [c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1)],
    back: [c(x1, y0, z0), c(x0, y0, z0), c(x0, y1, z0), c(x1, y1, z0)],
    left: [c(x0, y0, z0), c(x0, y0, z1), c(x0, y1, z1), c(x0, y1, z0)],
    right: [c(x1, y0, z1), c(x1, y0, z0), c(x1, y1, z0), c(x1, y1, z1)],
    top: [c(x0, y1, z1), c(x1, y1, z1), c(x1, y1, z0), c(x0, y1, z0)],
    bottom: [c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1), c(x0, y0, z1)],
  };
  for (const [k, f] of Object.entries(faces)) if (!(o.skip || []).includes(k)) quad(sc, ...f, o.colors?.[k] ?? color, o);
}
function light(sc, pos, color, intensity, range) { sc.lights.push({ pos: xf(sc, pos), c: hex(color), i: intensity, r: range * (sc.rawMode ? 1 : Math.sqrt(sc.s)) }); }
/** Spot light (torches): like a point light, but only inside a cone of the given half-angle in degrees. */
function spot(sc, pos, dir, color, intensity, range, deg) {
  light(sc, pos, color, intensity, range);
  const l = sc.lights[sc.lights.length - 1];
  l.dir = norm(sc.rawMode ? dir : V(dir.x * sc.s, dir.y, dir.z * sc.s));
  l.cos = Math.cos((deg * Math.PI) / 180);
}
function glow(sc, pos, color, radius, alpha = 0.7) { sc.glows.push({ pos: xf(sc, pos), color, radius, alpha }); }
function line3(sc, a, b, color, width = 1.5, alpha = 1) { sc.lines.push({ a: xf(sc, a), b: xf(sc, b), color, width, alpha }); }

function camera(eye0, target0, f, w, h, s = SCALE) {
  const eye = V(eye0.x * s, eye0.y, eye0.z * s), target = V(target0.x * s, target0.y, target0.z * s);
  const fw = norm(sub(target, eye));
  const right = norm(cross(fw, V(0, 1, 0)));
  const up = cross(right, fw);
  return { eye, fw, right, up, f, w, h, s };
}
function project(cam, p) {
  const d = sub(p, cam.eye);
  const z = dot(d, cam.fw);
  if (z < 0.08) return null;
  return [cam.w / 2 + (cam.f * dot(d, cam.right)) / z, cam.h / 2 - (cam.f * dot(d, cam.up)) / z, z];
}

/** Project a building coordinate (unscaled), for labels and overlays drawn by the views. */
function projectWorld(cam, p) { return project(cam, V(p.x * cam.s, p.y, p.z * cam.s)); }
function shade(sc, n, c, base, emissive) {
  let r = sc.ambient[0], g = sc.ambient[1], b = sc.ambient[2];
  for (const l of sc.lights) {
    const to = sub(l.pos, c);
    const d = len(to);
    let k = Math.max(0, dot(n, mul(to, 1 / (d || 1)))) * l.i / (1 + (d * d) / (l.r * l.r));
    if (l.dir) {
      const c = -dot(mul(to, 1 / (d || 1)), l.dir);
      k *= Math.min(1, Math.max(0, (c - l.cos) / 0.06));
    }
    r += l.c[0] * k; g += l.c[1] * k; b += l.c[2] * k;
  }
  const out = [base[0] * r, base[1] * g, base[2] * b];
  if (emissive) for (let i = 0; i < 3; i++) out[i] += base[i] * emissive;
  return out;
}

function render(sc, cam, extra = '') {
  const polys = [];
  for (const q of sc.quads) {
    const [p0, p1, p2, p3] = q.p;
    const n = norm(cross(sub(p1, p0), sub(p3, p0)));
    const center = mul(add(add(p0, p1), add(p2, p3)), 0.25);
    if (!q.o.double && dot(n, sub(center, cam.eye)) >= 0) continue;
    const nn = q.o.double && dot(n, sub(center, cam.eye)) >= 0 ? mul(n, -1) : n;
    const s = q.o.sub ?? 0.5;
    const nu = Math.max(1, Math.min(40, Math.ceil(len(sub(p1, p0)) / s)));
    const nv = Math.max(1, Math.min(40, Math.ceil(len(sub(p3, p0)) / s)));
    const at = (u, v) => lerp3(lerp3(p0, p1, u), lerp3(p3, p2, u), v);
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const cs = [at(i / nu, j / nv), at((i + 1) / nu, j / nv), at((i + 1) / nu, (j + 1) / nv), at(i / nu, (j + 1) / nv)];
        const pr = cs.map((p) => project(cam, p));
        if (pr.some((p) => !p)) continue;
        const c = at((i + 0.5) / nu, (j + 0.5) / nv);
        let col = shade(sc, nn, c, q.c, q.o.emissive);
        const depth = (pr[0][2] + pr[1][2] + pr[2][2] + pr[3][2]) / 4;
        if (sc.fog && !q.o.noFog) {
          const t = Math.min(1, Math.max(0, (depth - sc.fog.start) / (sc.fog.end - sc.fog.start))) * sc.fog.max;
          col = col.map((v, k) => v * (1 - t) + sc.fog.c[k] * t);
        }
        // Exposure tone mapping: bright lights roll off instead of clipping to white.
        const rgb = `rgb(${col.map((v) => Math.round((1 - Math.exp(-Math.max(0, v) * sc.exposure)) * 255)).join(',')})`;
        polys.push({ depth: depth + (q.o.bias ?? 0), pts: pr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), rgb, a: q.o.alpha ?? 1 });
      }
  }
  polys.sort((a, b) => b.depth - a.depth);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cam.w}" height="${cam.h}" viewBox="0 0 ${cam.w} ${cam.h}"><defs>`;
  sc.glows.forEach((g, i) => (svg += `<radialGradient id="g${i}"><stop offset="0" stop-color="${g.color}" stop-opacity="${g.alpha}"/><stop offset="1" stop-color="${g.color}" stop-opacity="0"/></radialGradient>`));
  svg += `</defs>`;
  if (sc.sky) svg += sc.sky(cam);
  for (const p of polys) svg += `<polygon points="${p.pts}" fill="${p.rgb}" stroke="${p.rgb}" stroke-width="0.7"${p.a < 1 ? ` fill-opacity="${p.a}" stroke-opacity="${p.a}"` : ''}/>`;
  for (const l of sc.lines) {
    const a = project(cam, l.a), b = project(cam, l.b);
    if (a && b) svg += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${l.color}" stroke-width="${l.width}" stroke-opacity="${l.alpha}" stroke-linecap="round"/>`;
  }
  sc.glows.forEach((g, i) => {
    const p = project(cam, g.pos);
    if (p) svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${(g.radius * cam.f) / p[2]}" fill="url(#g${i})" style="mix-blend-mode:screen"/>`;
  });
  return svg + extra + '</svg>';
}

// ------------------------------------------------------------------ shared props
const PAL = {
  brick: '#6a3a2c', stucco: '#d8d0c0', slate: '#3a3f48', sash: '#e6e0d4', board: '#6b4a2b', iron: '#16181c',
  basement: '#8a4a38', ground: '#3f5a46', first: '#2f4466', second: '#a89a62', attic: '#7a6248',
  floorWood: '#5a3e2a', floorTile: '#6e6a62', skin: '#6e7b5c', shirt: '#3b3a45', pants: '#2a2a33',
};
const SODIUM = '#ffa040', LAMP = '#ffc884', MOON = '#9fb4d8';

function zombie(sc, x0, y, z0, s = 1, face = 0, lean = 0) {
  const x = x0 * sc.s, z = z0 * sc.s;
  withRaw(sc, () => zombieBody(sc, x, y, z, s, face, lean));
}
function zombieBody(sc, x, y, z, s, face, lean) {
  const k = (v) => v * s;
  const r = (dx, dz) => { const c = Math.cos(face), sn = Math.sin(face); return [x + dx * c - dz * sn, z + dx * sn + dz * c]; };
  const part = (dx0, y0, dz0, dx1, y1, dz1, col) => {
    const [ax, az] = r(k(dx0), k(dz0)), [bx, bz] = r(k(dx1), k(dz1));
    box(sc, Math.min(ax, bx), y + k(y0), Math.min(az, bz), Math.max(ax, bx), y + k(y1), Math.max(az, bz), col, { sub: 0.3 });
  };
  part(-0.2, 0, -0.1, -0.03, 0.8, 0.1, PAL.pants);
  part(0.03, 0, -0.1, 0.2, 0.8, 0.1, PAL.pants);
  part(-0.25, 0.8 + lean * 0.1, -0.14, 0.25, 1.42, 0.14, PAL.shirt);
  part(-0.32, 1.25, 0.1, -0.2, 1.37, 0.6, PAL.skin);
  part(0.2, 1.28, 0.1, 0.32, 1.4, 0.62, PAL.skin);
  part(-0.15, 1.42, -0.12 + lean * 0.15, 0.15, 1.74, 0.18 + lean * 0.15, PAL.skin);
  const [ex1, ez1] = r(k(-0.07), k(0.19 + lean * 0.15)), [ex2, ez2] = r(k(0.07), k(0.19 + lean * 0.15));
  glow(sc, V(ex1, y + k(1.62), ez1), '#ffe060', 0.05 * s, 0.95);
  glow(sc, V(ex2, y + k(1.62), ez2), '#ffe060', 0.05 * s, 0.95);
}
function player(sc, x0, y, z0, s = 1, stripe = '#3a6ea5') {
  const x = x0 * sc.s, z = z0 * sc.s;
  withRaw(sc, () => playerBody(sc, x, y, z, stripe));
}
function playerBody(sc, x, y, z, stripe) {
  box(sc, x - 0.2, y, z - 0.1, x - 0.03, y + 0.8, z + 0.1, '#22262e');
  box(sc, x + 0.03, y, z - 0.1, x + 0.2, y + 0.8, z + 0.1, '#22262e');
  box(sc, x - 0.25, y + 0.8, z - 0.15, x + 0.25, y + 1.42, z + 0.15, '#2e3440');
  box(sc, x - 0.26, y + 1.15, z - 0.16, x + 0.26, y + 1.25, z + 0.16, stripe);
  box(sc, x - 0.14, y + 1.42, z - 0.14, x + 0.14, y + 1.72, z + 0.14, '#c8a27c');
  box(sc, x - 0.04, y + 1.2, z - 0.7, x + 0.04, y + 1.3, z - 0.1, '#1b1c1f');
}
function boards(sc, x0, x1, y0, y1, z, n, o = {}) {
  for (let i = 0; i < n; i++) {
    const y = y0 + ((y1 - y0) * (i + 0.5)) / n;
    const tilt = (i % 2 ? 1 : -1) * 0.08;
    quad(sc, V(x0 - 0.1, y - 0.07 + tilt, z), V(x1 + 0.1, y - 0.07 - tilt, z), V(x1 + 0.1, y + 0.07 - tilt, z), V(x0 - 0.1, y + 0.07 + tilt, z), PAL.board, { double: true, sub: 0.4, bias: -0.05, ...o });
  }
}
function lampPost(sc, x, z) {
  box(sc, x - 0.07, 0, z - 0.07, x + 0.07, 4.6, z + 0.07, PAL.iron);
  box(sc, x - 0.22, 4.5, z - 0.22, x + 0.22, 4.8, z + 0.22, '#ffd08a', { emissive: 3 });
  light(sc, V(x, 4.4, z), SODIUM, 3.2, 6);
  glow(sc, V(x, 4.6, z), SODIUM, 1.4, 0.55);
  glow(sc, V(x, 4.6, z), '#ffe0a0', 0.35, 0.9);
}
const rain = (w, h, n, seed = 3) => {
  let s = seed, out = '';
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) { const x = r() * w, y = r() * h, l = 10 + r() * 16; out += `<line x1="${x}" y1="${y}" x2="${x - 3}" y2="${y + l}" stroke="#9fb4d8" stroke-opacity="${0.12 + r() * 0.2}" stroke-width="1"/>`; }
  return out;
};
const vignette = (w, h, a = 0.75) => `<defs><radialGradient id="vg" cx="50%" cy="50%" r="75%"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${a}"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#vg)"/>`;
const caption = (title, sub) => `<div class="cap"><b>${title}</b>${sub}</div>`;
const skyGrad = (top, bottom) => (cam) => `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="${cam.w}" height="${cam.h}" fill="url(#sky)"/>`;

