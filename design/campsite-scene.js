// Camp Morrow scene builders, shared by campsite.html and weapons.html. Needs r3d.js first.
// Camp Morrow: x 0..48 west to east, z 0 (south, the gate) to -42 (north), y up. One unit = 1 m.
const W = 1280, H = 720, S1 = { s: 1 };
const FIRE = '#ff7a2a', CANDLE = '#ffb860', HEAD = '#f4f0ff', BULB = '#ffd27a';
const ROBE = '#cfc8b4', ROBE_DARK = '#a8a18e';
const LOG = '#4a3322', LOG_DARK = '#3a281a', PINE = '#1c2a20', PINE_DARK = '#152018', GRASS = '#2c3424', DIRT = '#3e3426';
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// Gaps in the palisade (barricades), as [side, from, to].
const GAPS = { gate: ['s', 21, 27], woodpile: ['s', 30, 33], sw: ['s', 5, 8], west: ['w', -20, -17], kitchen: ['n', 29, 31], north: ['n', 41.5, 44], jetty: ['e', -19, -16], beach: ['e', -6, -3], tower: ['e', -41.2, -39.4] };

function robed(sc, x, y, z, face = 0, lean = 0.2) {
  const shirt = PAL.shirt, pants = PAL.pants;
  PAL.shirt = ROBE; PAL.pants = ROBE_DARK;
  zombie(sc, x, y, z, 1, face, lean);
  PAL.shirt = shirt; PAL.pants = pants;
}
/** A zombie wading: only shoulders and head above the water line at y = 0. */
function wader(sc, x, z, h) {
  box(sc, x - 0.25, -0.1, z - 0.14, x + 0.25, h, z + 0.14, ROBE, { sub: 0.3 });
  box(sc, x - 0.15, h, z - 0.15, x + 0.15, h + 0.32, z + 0.15, PAL.skin, { sub: 0.3 });
  glow(sc, V(x - 0.07, h + 0.2, z - 0.16), '#ffe060', 0.05, 0.95);
  glow(sc, V(x + 0.07, h + 0.2, z - 0.16), '#ffe060', 0.05, 0.95);
}
function pine(sc, x, z, h = 9) {
  box(sc, x - 0.2, 0, z - 0.2, x + 0.2, h * 0.3, z + 0.2, LOG_DARK, { sub: 4 });
  for (let i = 0; i < 3; i++) {
    const r = 1.8 - i * 0.5, y0 = h * (0.2 + i * 0.25), y1 = y0 + h * 0.32;
    box(sc, x - r, y0, z - r, x + r, y1, z + r, i % 2 ? PINE : PINE_DARK, { sub: 3, skip: ['bottom'] });
  }
}
function gable(sc, x0, z0, x1, z1, y, rise, color, alongX = true) {
  // Two roof slopes over a box; the ridge runs along x (or z).
  const o = { sub: 1, double: true };
  if (alongX) {
    const zm = (z0 + z1) / 2;
    quad(sc, V(x0 - 0.3, y, z1 + 0.3), V(x1 + 0.3, y, z1 + 0.3), V(x1 + 0.3, y + rise, zm), V(x0 - 0.3, y + rise, zm), color, o);
    quad(sc, V(x1 + 0.3, y, z0 - 0.3), V(x0 - 0.3, y, z0 - 0.3), V(x0 - 0.3, y + rise, zm), V(x1 + 0.3, y + rise, zm), color, o);
    quad(sc, V(x0, y, z1), V(x0, y, z0), V(x0, y + rise, zm), V(x0, y + rise, zm), LOG, o);
    quad(sc, V(x1, y, z0), V(x1, y, z1), V(x1, y + rise, zm), V(x1, y + rise, zm), LOG, o);
  } else {
    const xm = (x0 + x1) / 2;
    quad(sc, V(x0 - 0.3, y, z0 - 0.3), V(x0 - 0.3, y, z1 + 0.3), V(xm, y + rise, z1 + 0.3), V(xm, y + rise, z0 - 0.3), color, o);
    quad(sc, V(x1 + 0.3, y, z1 + 0.3), V(x1 + 0.3, y, z0 - 0.3), V(xm, y + rise, z0 - 0.3), V(xm, y + rise, z1 + 0.3), color, o);
    quad(sc, V(x0, y, z1), V(x1, y, z1), V(xm, y + rise, z1), V(xm, y + rise, z1), LOG, o);
    quad(sc, V(x1, y, z0), V(x0, y, z0), V(xm, y + rise, z0), V(xm, y + rise, z0), LOG, o);
  }
}
function cabin(sc, x0, z0, x1, z1, h, lit, o = {}) {
  box(sc, x0, 0, z0, x1, h, z1, o.wall ?? LOG, { sub: 0.8, skip: o.open ?? [] });
  gable(sc, x0, z0, x1, z1, h, o.rise ?? 1.6, o.roof ?? '#2a2622', o.alongX ?? true);
  if (lit) for (const [wx, wz, side] of lit) {
    // A lit window: a warm pane on the wall and a little light spilling out.
    const n = { s: [0, 0.03], n: [0, -0.03], e: [0.03, 0], w: [-0.03, 0] }[side];
    if (side === 's' || side === 'n') box(sc, wx - 0.5, 1.1, wz + n[1] - 0.01, wx + 0.5, 1.9, wz + n[1] + 0.01, '#ffcf8a', { emissive: 1.6 });
    else box(sc, wx + n[0] - 0.01, 1.1, wz - 0.5, wx + n[0] + 0.01, 1.9, wz + 0.5, '#ffcf8a', { emissive: 1.6 });
    light(sc, V(wx + n[0] * 30, 1.6, wz + n[1] * 30), LAMP, 0.9, 3.5);
  }
}
function fence(sc, x0, z0, x1, z1) {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 2));
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * i) / n;
    box(sc, x - 0.07, 0, z - 0.07, x + 0.07, 1.2, z + 0.07, LOG, { sub: 2 });
  }
  for (const y of [0.55, 1.05]) {
    if (x0 === x1) box(sc, x0 - 0.05, y, Math.min(z0, z1), x0 + 0.05, y + 0.1, Math.max(z0, z1), '#5a3e28', { sub: 2 });
    else box(sc, Math.min(x0, x1), y, z0 - 0.05, Math.max(x0, x1), y + 0.1, z0 + 0.05, '#5a3e28', { sub: 2 });
  }
}
function palisade(sc) {
  const H = 3.2, T = 0.4;
  const inGap = (side, t) => Object.values(GAPS).some(([s, a, b]) => s === side && t > a && t < b);
  const logs = (side, from, to) => {
    for (let t = from; t < to; t += T) {
      if (inGap(side, t + T / 2)) continue;
      const h = H + ((Math.sin(t * 13.1) + 1) / 2) * 0.4;
      if (side === 's') box(sc, t, 0, -T, t + T, h, 0, LOG, { sub: 1.2, colors: { top: '#6a4c30' } });
      if (side === 'n') box(sc, t, 0, -42, t + T, h, -42 + T, LOG, { sub: 1.2 });
      if (side === 'w') box(sc, -T, 0, t, 0, h, t + T, LOG, { sub: 1.2 });
      if (side === 'e') box(sc, 48, 0, t, 48 + T, h, t + T, LOG, { sub: 1.2 });
    }
  };
  logs('s', -0.4, 48.4); logs('n', -0.4, 48.4); logs('w', -42, 0); logs('e', -42, 0);
  // Boarded gaps.
  for (const [k, [side, a, b]] of Object.entries(GAPS)) {
    const n = k === 'gate' ? 10 : 6;
    if (side === 's') boards(sc, a, b, 0.3, 2.9, 0.05, n);
    if (side === 'n') boards(sc, a, b, 0.3, 2.9, -42.05, n);
    if (side === 'w' || side === 'e') {
      const x = side === 'w' ? -0.05 : 48.05;
      for (let i = 0; i < n; i++) {
        const y = 0.3 + (2.6 * (i + 0.5)) / n, tilt = (i % 2 ? 1 : -1) * 0.08;
        quad(sc, V(x, y - 0.07 + tilt, a - 0.1), V(x, y - 0.07 - tilt, b + 0.1), V(x, y + 0.07 - tilt, b + 0.1), V(x, y + 0.07 + tilt, a - 0.1), PAL.board, { double: true, sub: 0.4, bias: -0.05 });
      }
    }
  }
  // Gate posts either side of the main gate, taller, with a sun sign on a crossbeam.
  box(sc, 20.4, 0, -0.6, 21, 5, 0, LOG_DARK); box(sc, 27, 0, -0.6, 27.6, 5, 0, LOG_DARK);
  box(sc, 20.4, 4.4, -0.5, 27.6, 4.9, -0.1, LOG_DARK);
}
function ground(sc, x0, z0, x1, z1, step, color, sub) {
  for (let x = x0; x < x1; x += step)
    for (let z = z0; z < z1; z += step) {
      const c = color(x + step / 2, z + step / 2);
      box(sc, x, -0.2, z, x + step, 0, z + step, c, { sub, skip: ['bottom', 'left', 'right', 'front', 'back'] });
    }
}
function fireCircle(sc, o = {}) {
  const fx = 24, fz = -16;
  // Ember bed, a few charred logs, a stone ring.
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; box(sc, fx + Math.cos(a) * 1.4 - 0.2, 0, fz + Math.sin(a) * 1.4 - 0.2, fx + Math.cos(a) * 1.4 + 0.2, 0.3, fz + Math.sin(a) * 1.4 + 0.2, '#55524c', { sub: 0.4 }); }
  box(sc, fx - 1, 0, fz - 1, fx + 1, 0.15, fz + 1, '#ff5a1a', { emissive: 2.2, sub: 0.4 });
  box(sc, fx - 0.9, 0.1, fz - 0.15, fx + 0.9, 0.35, fz + 0.15, '#1e1612', { sub: 0.4 });
  box(sc, fx - 0.15, 0.1, fz - 0.9, fx + 0.15, 0.45, fz + 0.9, '#2a1a10', { sub: 0.4 });
  const k = o.flare ? 3 : 1;
  light(sc, V(fx, 0.9, fz), FIRE, 2.6 * k, 5.5 * k);
  glow(sc, V(fx, 0.4, fz), FIRE, 1.8 * k, 0.8);
  glow(sc, V(fx, 0.2, fz), '#ffd080', 0.7, 0.9);
  // A thin smoke column.
  for (let i = 0; i < 7; i++) glow(sc, V(fx + Math.sin(i * 0.9) * 0.4 + i * 0.15, 1.5 + i * 1.3, fz - i * 0.2), '#8a8478', 0.6 + i * 0.25, 0.12);
  // Log benches in a ring of radius 4, gap to the south.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = fx + Math.cos(a) * 4.2, z = fz + Math.sin(a) * 4.2;
    const along = Math.abs(Math.cos(a)) < 0.7;
    box(sc, x - (along ? 1 : 0.25), 0, z - (along ? 0.25 : 1), x + (along ? 1 : 0.25), 0.45, z + (along ? 0.25 : 1), LOG, { sub: 0.5 });
  }
  // Tents at radius 9, open flaps.
  for (const a of [0.3, 1.0, 2.15, 2.85, 3.6, 5.8]) {
    const x = fx + Math.cos(a) * 9.5, z = fz + Math.sin(a) * 9.5;
    const c = ['#6a6a4a', '#5a4a3a', '#4a5a5a'][Math.round(a * 3) % 3];
    quad(sc, V(x - 1.2, 0, z + 1.1), V(x + 1.2, 0, z + 1.1), V(x + 1.2, 1.5, z), V(x - 1.2, 1.5, z), c, { double: true, sub: 0.6 });
    quad(sc, V(x + 1.2, 0, z - 1.1), V(x - 1.2, 0, z - 1.1), V(x - 1.2, 1.5, z), V(x + 1.2, 1.5, z), c, { double: true, sub: 0.6 });
  }
  // Totem: stacked carved blocks with a sun disc.
  box(sc, 23.6, 0, -24.4, 24.4, 3.6, -23.6, '#5a4028', { sub: 0.4 });
  box(sc, 23.2, 3.6, -24.15, 24.8, 5.2, -23.85, o.power ? '#c8a040' : '#5a4a2a', { sub: 0.4, emissive: o.power ? 0.8 : 0 });
  // Guitar on a bench, camcorder on a tripod with its red light.
  box(sc, 26.3, 0.45, -12.6, 27.4, 0.55, -12.25, '#8a5a2a'); box(sc, 27.4, 0.48, -12.5, 28.3, 0.53, -12.4, '#3a2a1a');
  line3(sc, V(22, 0, -9.5), V(22.3, 1.3, -9.8), '#222', 2); line3(sc, V(22.6, 0, -9.5), V(22.3, 1.3, -9.8), '#222', 2); line3(sc, V(22.3, 0, -10.1), V(22.3, 1.3, -9.8), '#222', 2);
  box(sc, 22.1, 1.3, -10, 22.5, 1.55, -9.6, '#1a1a1a');
  glow(sc, V(22.45, 1.52, -9.9), '#ff2020', 0.06, 1);
}
function messHall(sc, o = {}) {
  cabin(sc, 15, -41.6, 33, -33, 3.4, o.lit ? [[18, -33, 's'], [21, -33, 's'], [28, -33, 's'], [31, -33, 's']] : null, { rise: 2.2, open: o.open });
  // Porch and the front door (the 750 door).
  box(sc, 22.5, 0, -33, 26.5, 0.25, -31.5, '#5a3e28');
  box(sc, 23.2, 0, -33.05, 25.8, 2.4, -32.98, '#3a281a');
  box(sc, 21.5, 3.6, -32.9, 27.5, 4.3, -32.8, '#2a2018'); // sign board
}
function chapel(sc, o = {}) {
  cabin(sc, 3, -26, 11, -14, 4.2, o.lit ? [[11, -23.5, 'e'], [11, -16.5, 'e']] : null, { alongX: false, rise: 3, wall: '#5a4634' });
  box(sc, 11, 0, -21, 11.05, 3, -19, '#2a1d14');
  // Bell tower on the north end.
  box(sc, 5, 0, -29, 9, 9, -26, '#4e3c2c', { sub: 0.8 });
  gable(sc, 5, -29, 9, -26, 9, 2.4, '#2a2622', false);
  box(sc, 6.4, 7, -27.8, 7.6, 8.2, -27.2, '#8a6a2a');
  // The sun sign over the door; lit only with power.
  box(sc, 11.05, 3.3, -20.8, 11.15, 4.1, -19.2, o.power ? '#ffd27a' : '#6a5a3a', { emissive: o.power ? 2.5 : 0 });
  if (o.power) { light(sc, V(12, 3.7, -20), BULB, 1.6, 5); glow(sc, V(11.2, 3.7, -20), BULB, 1.2, 0.5); }
}
function cabins(sc, o = {}) {
  for (const z of [-8, -16, -24]) cabin(sc, 38, z, 44, z + 4, 2.8, o.lit && z === -16 ? [[38, z + 2, 'w']] : null, { rise: 1.4 });
  // Boathouse on the shore side, canoes.
  cabin(sc, 43, -31, 47.4, -27, 2.6, null, { rise: 1.2, roof: '#33302a' });
  // Washing line of robes.
  line3(sc, V(36, 1.9, -11), V(36, 1.9, -1), '#888', 1);
  for (let z = -10.5; z < -2; z += 1.5) quad(sc, V(36, 1.9, z), V(36, 1.9, z + 0.9), V(36, 0.8, z + 0.9), V(36, 0.8, z), ROBE, { double: true, sub: 0.5 });
}
function compound(sc, o = {}) {
  cabin(sc, 37, -41, 41, -36, 2.8, o.lit ? [[41, -38.5, 'e']] : null, { rise: 1.4, alongX: false });
  box(sc, 43, 0, -34.5, 46, 2.2, -32.6, '#3e3a34'); // generator shed
  // Watchtower: a log tower with stairs inside. Its ground-floor door (east, outside the palisade) is a barricade.
  box(sc, 44.4, 0, -42, 44.8, 6, -38.4, LOG, { sub: 0.8 });
  box(sc, 44.4, 0, -42, 48, 6, -41.6, LOG, { sub: 0.8 });
  box(sc, 44.4, 0, -38.8, 48, 6, -38.4, LOG, { sub: 0.8 });
  box(sc, 47.6, 0, -41.6, 48, 6, -41.2, LOG, { sub: 0.8 }); box(sc, 47.6, 0, -39.4, 48, 6, -38.8, LOG, { sub: 0.8 });
  box(sc, 47.6, 2.9, -41.2, 48, 6, -39.4, LOG, { sub: 0.8 });
  box(sc, 44.4, 2.6, -38.4, 45.6, 2.7, -38.35, '#2a1d14'); // the players' door from the compound
  box(sc, 44.6, 0, -38.38, 45.6, 2.5, -38.36, '#2a1d14');
  box(sc, 44.2, 6, -42.2, 48.2, 6.25, -38.2, '#5a3e28', { sub: 0.6 });
  box(sc, 45.1, 6.24, -39.7, 46.1, 6.26, -38.7, '#0a0806'); // stair hatch
  if (o.onTop) { robed(sc, 45.6, 5.0, -39.2, Math.PI / 2, 0.1); light(sc, V(45.6, 6.9, -39.2), MOON, 1, 2); }
  for (const [x, z] of [[44.3, -42.1], [48.1, -42.1], [44.3, -38.3], [48.1, -38.3]]) box(sc, x - 0.12, 6.25, z - 0.12, x + 0.12, o.onTop ? 7.3 : 8.6, z + 0.12, LOG_DARK, { sub: 2 });
  for (const [a, b] of [[[44.3, -38.3], [48.1, -38.3]], [[44.3, -42.1], [48.1, -42.1]], [[44.3, -42.1], [44.3, -38.3]], [[48.1, -42.1], [48.1, -38.3]]])
    line3(sc, V(a[0], 7.3, a[1]), V(b[0], 7.3, b[1]), '#4a3322', 3);
  if (!o.onTop) gable(sc, 44, -42.4, 48.4, -38, 8.6, 1.2, '#2a2622');
  if (o.lit) { light(sc, V(46.2, 8, -40.2), LAMP, 1.2, 4); glow(sc, V(46.2, 8.3, -40.2), LAMP, 0.4, 0.8); }
}
function fences(sc) {
  // Split-rail fences between zones, with gate gaps (the doors).
  fence(sc, 14, 0, 14, -15); fence(sc, 14, -18, 14, -42);
  fence(sc, 34, 0, 34, -15); fence(sc, 34, -18, 34, -32);
  fence(sc, 34, -32, 40, -32); fence(sc, 43, -32, 48, -32);
  fence(sc, 36, -32, 36, -35); fence(sc, 36, -38, 36, -42);
  fence(sc, 14, -32, 15, -32); fence(sc, 33, -32, 36, -32);
}
function festoons(sc, skipTower) {
  // Power on: strings of warm bulbs over every zone.
  const runs = [[[15, 3.2, -32], [24, 5, -16]], [[33, 3.2, -32], [24, 5, -16]], [[24, 5, -16], [14, 3, -4]], [[24, 5, -16], [34, 3, -4]], [[6, 3, -6], [11, 3.5, -12]], [[38, 2.8, -4], [44, 2.8, -26]], [[37, 2.8, -36], [44, 6, -38]]];
  for (const [a, b] of skipTower ? runs.slice(0, -1) : runs) {
    const A = V(...a), B = V(...b), n = 8;
    for (let i = 0; i < n; i++) {
      const p = lerp3(A, B, i / n), q = lerp3(A, B, (i + 1) / n);
      const sag = (t) => -Math.sin(t * Math.PI) * 0.6;
      line3(sc, V(p.x, p.y + sag(i / n), p.z), V(q.x, q.y + sag((i + 1) / n), q.z), '#222', 1);
      glow(sc, V(p.x, p.y + sag(i / n) - 0.1, p.z), BULB, 0.35, 0.9);
    }
    const m = lerp3(A, B, 0.5);
    light(sc, V(m.x, m.y - 0.5, m.z), BULB, 1.3, 7);
  }
}
function forest(sc, o = {}) {
  seed = o.seed ?? 11;
  const lakeX = 50;
  for (let i = 0; i < (o.n ?? 160); i++) {
    const x = -40 + rnd() * 90, z = -80 + rnd() * 110;
    const inCamp = x > -4 && x < 52 && z > -46 && z < 4;
    const onRoad = x > 18 && x < 30 && z > 0;
    if (inCamp || onRoad || x > lakeX - 2) continue;
    if (o.near && Math.hypot(x - o.near[0], z - o.near[1]) > o.near[2]) continue;
    pine(sc, x, z, 8 + rnd() * 6);
  }
  // Trees on the far shore of the lake.
  for (let z = -80; z < 30; z += 4) pine(sc, 92 + rnd() * 6, z, 9 + rnd() * 5);
}
function lake(sc) {
  box(sc, 50, -0.6, -80, 92, -0.05, 30, '#0c1620', { sub: 3, skip: ['bottom', 'left', 'right', 'front', 'back'] });
  // Beach strip and the jetty.
  box(sc, 48.4, -0.2, -42, 50, 0, 0, '#4a4234', { sub: 1, skip: ['bottom'] });
  box(sc, 48.4, 0.1, -18.6, 62, 0.3, -16.6, '#5a4630', { sub: 0.6 });
  for (let x = 50; x < 62; x += 2.5) { box(sc, x, -0.6, -18.8, x + 0.2, 0.3, -18.6, LOG_DARK); box(sc, x, -0.6, -16.6, x + 0.2, 0.3, -16.4, LOG_DARK); }
  box(sc, 56, -0.1, -21, 59.5, 0.3, -20, '#6a3a2a', { sub: 0.5 }); // a rowing boat
}
function road(sc, o = {}) {
  box(sc, 20, -0.15, 0, 28, 0.02, 60, '#2e2a24', { sub: 1.2, skip: ['bottom'] });
  // Minibus, headlights on, driver's door open.
  box(sc, 18.4, 0.3, 8, 21, 2.6, 15.5, '#c8c4b8', { sub: 0.5, colors: { back: '#b8b4a8' } });
  box(sc, 18.5, 1.5, 7.98, 20.9, 2.3, 8, '#1a2028', { sub: 0.4 });
  for (const x of [18.7, 20.7]) for (const z of [9, 14.5]) box(sc, x - 0.15, 0, z - 0.4, x + 0.15, 0.6, z + 0.4, '#151515');
  quad(sc, V(21, 0.5, 8.6), V(21, 0.5, 9.8), V(22, 2.2, 9.6), V(22, 2.2, 8.6), '#bdb9ad', { double: true });
  for (const x of [18.8, 20.6]) {
    glow(sc, V(x, 0.9, 7.95), '#ffffff', 0.3, 1);
    withRaw(sc, () => spot(sc, V(x, 0.9, 7.8), V(0.25, -0.06, -1), HEAD, 5, 18, 24));
  }
  glow(sc, V(19.7, 0.9, 7.6), HEAD, 3, 0.25);
}
function camp(sc, o = {}) {
  ground(sc, -60, -100, 120, 60, 10, (x, z) => (x > 20 && x < 28 && z > 0 ? '#2e2a24' : x > 50 ? '#0c1620' : PINE_DARK), 2);
  ground(sc, 0, -42, 48, 0, 3, (x, z) => (Math.hypot(x - 24, z + 16) < 7 || (x > 21 && x < 27 && z > -16) ? DIRT : GRASS), 0.75);
  palisade(sc); fences(sc); fireCircle(sc, o); messHall(sc, { lit: true }); chapel(sc, { lit: true, power: o.power });
  cabins(sc, { lit: true }); compound(sc, { lit: !o.onTop, onTop: o.onTop }); lake(sc); road(sc, o);
  // Woodpile in the woodpile gap.
  for (let i = 0; i < 4; i++) box(sc, 30.2, i * 0.3, -1.6 + i * 0.1, 32.8, i * 0.3 + 0.3, -0.5, '#5a3e28', { sub: 0.6 });
  if (o.power) festoons(sc, o.onTop);
  // Moon, low in the east over the lake.
  light(sc, V(120, 60, -40), MOON, o.moon ?? 1.4, 200);
  if (o.forest !== false) forest(sc, o.forestOpts ?? {});
}
const label = (cam, x, y, z, title, sub, color = '#e8b84a') => {
  const p = projectWorld(cam, V(x, y, z));
  if (!p) return '';
  return `<g font-family="Oswald" text-anchor="middle" style="paint-order:stroke" stroke="#000" stroke-width="5" stroke-opacity=".75"><text x="${p[0]}" y="${p[1]}" font-size="21" font-weight="600" fill="${color}" letter-spacing="1.5">${title}</text>${sub ? `<text x="${p[0]}" y="${p[1] + 20}" font-family="Inter" font-size="13" font-weight="600" fill="#e9e2d6">${sub}</text>` : ''}</g>`;
};
const prompt = (text, cost) => `<g font-family="Inter" font-weight="600" font-size="20" fill="#f2eee6" style="paint-order:stroke" stroke="#000" stroke-width="4"><rect x="490" y="497" width="28" height="26" rx="4" fill="none" stroke="#f2eee6" stroke-width="2"/><text x="504" y="516" text-anchor="middle" font-size="16" stroke-width="0">E</text><text x="528" y="518">${text} <tspan fill="#e8b84a">${cost}</tspan></text></g>`;
const gunModel = () => `<polygon points="860,720 900,560 1010,540 1080,720" fill="#1b1c1f"/><polygon points="900,560 1010,540 1030,600 925,618" fill="#2a2c30"/>`;
const crossbowModel = () => `<g><polygon points="820,720 870,600 960,585 1010,720" fill="#3a2a1c"/><polygon points="700,610 1120,575 1124,590 704,626" fill="#1b1c1f"/><line x1="702" y1="618" x2="915" y2="640" stroke="#bbb" stroke-width="1.5"/><line x1="1122" y1="582" x2="915" y2="640" stroke="#bbb" stroke-width="1.5"/><polygon points="905,585 925,560 935,640 912,650" fill="#2a2c30"/><line x1="918" y1="600" x2="930" y2="480" stroke="#c8c0a8" stroke-width="4"/></g>`;
const SKY = skyGrad('#05070d', '#141c2a');
const stars = (n) => { let s = '', k = 7; const r = () => ((k = (k * 16807) % 2147483647) / 2147483647); for (let i = 0; i < n; i++) s += `<circle cx="${r() * W}" cy="${r() * H * 0.45}" r="${0.4 + r() * 0.8}" fill="#dfe6ff" fill-opacity="${0.2 + r() * 0.5}"/>`; return s; };

