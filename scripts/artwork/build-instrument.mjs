import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as k from './vendor/iso-kit.mjs';
import * as A from './vendor/audit.mjs';

// Figure concept: two reviewed intent cards enter an inspection carriage. A narrow
// permission shutter and two separate decision pins precede a release door that
// stays locked. Every movement is an explanation, never an application result.
// Parts, before geometry: base plate; four feet; four corner screws; ruler strip;
// two track rails; two end stops; carriage plate; four bearing shoes; inspection
// paper; two feed beds; two feed backrests; two intent cards; four card clips;
// two gate mounts; two gate uprights; gate lintel; permission shutter; two guide
// blocks; shutter handle; decision plinth; two pin sockets; two pin stems; two
// pin heads; release plinth; two release uprights; release lintel; release door;
// two hinges; lock tongue; deadbolt; two lock fasteners; lamp mount; lamp upright;
// lamp elbow; lamp head; lamp diffuser; maker plate; two maker-plate fasteners.
// All source helpers in vendor/ retain the Anatomy MIT notice.

const root = fileURLToPath(new URL('../../', import.meta.url));
const W = 680, H = 420;
const base = { x: -174, y: -81, w: 348, d: 162, r: 12 };
const P = k.fitProjection([...k.boxCorners(base, -8, 10), [-116, -49, 75], [143, 42, 78]], W, H,
  { pad: 23, azimuth: 40, elevation: 28 });
const camera = k.cameraOf(P);
const layers = { back: [], front: [] };
let R;

function part(name, plan, z, height, { tone = 'mid', layer = 'front', group = '', inner = '', move = [0, 0, 0] } = {}) {
  const shifted = { ...plan, x: plan.x + move[0], y: plan.y + move[1] };
  const bottom = z + move[2];
  const svg = k.solidSvg(k.slabOf(shifted, bottom, height, P, 6, Math.min(.7, height / 4)), { tone, inner })
    .replace('<g class="iso-solid"', `<g class="iso-solid" data-tone="${tone}"`);
  const shape = R.solid(A.slab(shifted, bottom, height, { name, ground: name.startsWith('Foot ') }, 6));
  const item = R.put({ name, at: [shifted.x + shifted.w / 2, shifted.y + shifted.d / 2, bottom + height / 2],
    svg, shapes: [shape], layer, group });
  return item;
}

function screws(points, z, layer = 'front') {
  points.forEach(([x, y], i) => {
    part(`Fastener ${x} ${y} ${i}`, { x: x - 1.5, y: y - 1.5, w: 3, d: 3, r: .75 }, z, .65, { tone: 'lo', layer,
      inner: k.lineSvg(k.lineOnTop([x - .9, y], [x + .9, y], z + .65, P), { tone: 'hi', free: true }) });
  });
}

function build(pose = 0) {
  R = A.recorder(P);
  for (const [x, y] of k.corners(base, 25)) part(`Foot ${x} ${y}`, { x: x - 7, y: y - 7, w: 14, d: 14, r: 4 }, -8, 8, { tone: 'lo', layer: 'back' });
  part('Base plate', base, 0, 10, { layer: 'back', tone: 'lo',
    inner: k.lineSvg(k.planOutline(k.insetPlan(base, 5), 10, P), { tone: 'faint' }) });
  screws(k.corners(base, 13), 10, 'back');
  const strip = { x: -147, y: 62, w: 238, d: 5, r: 1 };
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 5, 5, strip.y + .1, 10.6, [2.1, 3.9], P);
  part('Travel ruler', strip, 10, .6, { layer: 'back', tone: 'lo',
    inner: k.lineSvg(ticks.minor, { tone: 'lo' }) + k.lineSvg(ticks.major, { tone: 'mid' }) });
  for (const y of [-18, 16]) part(`Track rail ${y}`, { x: -72, y, w: 104, d: 4, r: 1 }, 10, 4, { layer: 'back' });
  for (const x of [-77, 32]) part(`Track stop ${x}`, { x, y: -23, w: 5, d: 48, r: 1.2 }, 10, 8, { layer: 'back' });
  const travel = Math.min(1, pose) * 14;
  for (const x of [-44, -9]) for (const y of [-18, 16]) {
    part(`Bearing shoe ${x} ${y}`, { x, y, w: 9, d: 4, r: 1 }, 14, 3,
      { layer: 'back', group: 'carriage', move: [travel, 0, 0] });
  }
  part('Inspection carriage', { x: -48, y: -24, w: 60, d: 50, r: 4 }, 17, 6,
    { layer: 'back', group: 'carriage', tone: 'hi', move: [travel, 0, 0] });
  const inspection = { x: -41, y: -17, w: 46, d: 36, r: 2 };
  part('Inspection paper', inspection, 23, .4, { layer: 'back', group: 'carriage', tone: 'paper', move: [travel, 0, 0],
    inner: k.lineSvg([-7, 0, 7].map(y => k.lineOnTop([-33 + travel, y], [-3 + travel, y], 23.4, P)).join(''), { tone: 'lo', free: true }) });

  for (const y of [-54, 28]) {
    part(`Intent feed bed ${y}`, { x: -149, y, w: 67, d: 26, r: 3 }, 10, 8, { tone: 'lo' });
    part(`Intent backrest ${y}`, { x: -147, y: y + 1, w: 63, d: 4, r: 1 }, 18, 14, { tone: 'mid' });
    const lines = [0, 1, 2].map(i => k.lineOnTop([-137, y + 9 + i * 4], [-99 + i * 6, y + 9 + i * 4], 20.4, P)).join('');
    part(`Reviewed public intent card ${y}`, { x: -144, y: y + 5, w: 57, d: 19, r: 2 }, 18, 2.4,
      { tone: 'paper', inner: k.lineSvg(lines, { tone: 'lo', free: true }) });
    for (const x of [-143, -91]) part(`Feed clip ${x} ${y}`, { x, y: y + 19, w: 4, d: 5, r: 1 }, 20.4, 2, { tone: 'hi' });
  }

  for (const y of [-34, 27]) {
    part(`Permission gate mount ${y}`, { x: 43, y: y - 3, w: 17, d: 13, r: 2 }, 10, 4, { tone: 'lo' });
    part(`Permission gate upright ${y}`, { x: 48, y, w: 7, d: 7, r: 1 }, 14, 51, { tone: 'mid' });
    part(`Permission guide ${y}`, { x: 47, y: y + (y < 0 ? 7 : -3), w: 9, d: 3, r: .5 }, 28, 22, { tone: 'lo' });
  }
  part('Permission lintel', { x: 46, y: -35, w: 11, d: 71, r: 2 }, 65, 7, { tone: 'hi' });
  const shutterLift = Math.min(1, pose) * 10;
  part('Narrow permission shutter', { x: 49, y: -24, w: 5, d: 48, r: 1 }, 28, 21,
    { tone: 'rose', group: 'shutter', move: [0, 0, shutterLift] });
  part('Shutter handle', { x: 54, y: 14, w: 5, d: 8, r: 1 }, 35, 5,
    { tone: 'hi', group: 'shutter', move: [0, 0, shutterLift] });

  part('Independent decision plinth', { x: 62, y: 30, w: 45, d: 25, r: 3 }, 10, 5, { tone: 'lo' });
  for (const x of [67, 88]) {
    part(`Decision socket ${x}`, { x, y: 37, w: 14, d: 14, r: 3 }, 15, 5, { tone: 'mid' });
    part(`Decision stem ${x}`, { x: x + 5, y: 42, w: 4, d: 4, r: 1 }, 20, 7, { tone: 'hi' });
    part(`Separate decision head ${x}`, { x: x + 1, y: 38, w: 12, d: 12, r: 3 }, 27, 3,
      { tone: pose >= 2 ? 'rose' : 'hi', group: `decision-${x}` });
  }

  part('Protected release plinth', { x: 112, y: -43, w: 33, d: 86, r: 4 }, 10, 4, { tone: 'lo' });
  for (const y of [-36, 29]) part(`Release upright ${y}`, { x: 121, y, w: 8, d: 7, r: 1.5 }, 14, 51, { tone: 'mid' });
  part('Release lintel', { x: 119, y: -38, w: 12, d: 76, r: 2 }, 65, 8, { tone: 'hi' });
  part('Locked release door', { x: 122, y: -28, w: 6, d: 56, r: 1.5 }, 17, 44, { tone: 'lo' });
  for (const y of [-29, 28]) part(`Door hinge ${y}`, { x: 121, y, w: 8, d: 1, r: .2 }, 26, 23, { tone: 'mid' });
  part('Lock tongue', { x: 128, y: -8, w: 5, d: 19, r: 1 }, 36, 12, { tone: 'hi' });
  part('Closed deadbolt', { x: 129, y: -17, w: 8, d: 31, r: 1.8 }, 48, 5, { tone: 'rose' });
  part('Lock key slot', { x: 137, y: -3, w: .6, d: 3, r: .2 }, 49, 3, { tone: 'lo' });

  part('Inspection lamp mount', { x: -44, y: -66, w: 28, d: 22, r: 4 }, 10, 6, { tone: 'lo' });
  part('Lamp upright', { x: -33, y: -60, w: 5, d: 6, r: 1 }, 16, 50, { tone: 'mid' });
  part('Lamp arm', { x: -33, y: -54, w: 5, d: 31, r: 1 }, 66, 5, { tone: 'mid' });
  part('Inspection lamp head', { x: -43, y: -30, w: 25, d: 20, r: 4 }, 58, 8, { tone: 'hi' });
  part('Lamp diffuser', { x: -40, y: -27, w: 19, d: 14, r: 3 }, 56, 2, { tone: 'paper' });
  const plaque = { x: 101, y: 56, w: 48, d: 12, r: 2 };
  part('Maker plate', plaque, 10, .8, { tone: 'mid', layer: 'back',
    inner: k.lineSvg([0, 1].map(i => k.lineOnTop([112, 60 + i * 4], [139 - i * 8, 60 + i * 4], 10.8, P)).join(''), { tone: 'lo', free: true }) });
  screws([[106, 62], [144, 62]], 10.8, 'back');
  A.settle(R, P, { step: .8 });
  return R;
}

const record = build();
for (const item of record.items.sort((a, b) => a.key - b.key)) {
  layers[item.layer].push({ name: item.name, group: item.group, svg: item.svg });
}
const dimensions = { width: W, height: H, origin: P.origin, scale: camera.k,
  sinA: camera.sinA, cosA: camera.cosA, sinE: camera.sinE, cosE: camera.cosE,
  inspection: [-41, -17, 46, 36, 23.4], carriageVector: k.axisVector(P, [14, 0, 0]), shutterVector: k.axisVector(P, [0, 0, 10]) };
const geometry = { dimensions, layers, partCount: record.solids.length };
mkdirSync(new URL('../../components/artwork/', import.meta.url), { recursive: true });
writeFileSync(new URL('../../components/artwork/instrument-geometry.ts', import.meta.url),
  '// Generated by scripts/artwork/build-instrument.mjs using MIT-licensed Anatomy helpers.\n' +
  '// Geometry is deliberately build-time only. No local skill paths enter the browser.\n' +
  `export const instrumentGeometry = ${JSON.stringify(geometry)} as const;\n`);

const ramps = {
  lo: { fill: '#3f303f', top: '#4f3a4d', line: '#a58a9c', shades: ['#29212c', '#342735', '#3d2e3d', '#493649'] },
  mid: { fill: '#594451', top: '#705765', line: '#a58a9c', shades: ['#312632', '#3b2d39', '#493643', '#57414f'] },
  hi: { fill: '#856675', top: '#a78392', line: '#d1b3c0', shades: ['#4b3645', '#5b4051', '#725164', '#896578'] },
  paper: { fill: '#dac5c6', top: '#fae9e7', line: '#f5d9e0', shades: ['#88717e', '#9d8491', '#b79ca7', '#d2b5bf'] },
  rose: { fill: '#bd809b', top: '#e0adc3', line: '#f3cadb', shades: ['#624052', '#7c5065', '#98627b', '#b37995'] },
};
const palette = '.iso-line{fill:none;stroke:#9b7d91;stroke-width:.6;stroke-linecap:round;stroke-linejoin:round}.iso-crease{opacity:.3}.iso-bevel{opacity:.2}.iso-line[data-tone="faint"]{opacity:.25}.iso-line[data-tone="lo"]{opacity:.5}.iso-line[data-tone="hi"]{stroke:#f2d5e1}' +
  Object.entries(ramps).map(([tone, ramp]) => {
    const selector = `.iso-solid[data-tone="${tone}"]`;
    return `${selector}>.iso-fill{fill:${ramp.fill}}${selector}>.iso-top{fill:${ramp.top}}` +
      ramp.shades.map((shade, index) => `${selector}>.iso-shade[data-shade="${index}"]{fill:${shade}}`).join('') +
      `${selector}>.iso-edge{stroke:${ramp.line}}`;
  }).join('');
const scopedPalette = palette.replace(/(^|})([^{}]+){/g, (_, boundary, selectors) =>
  boundary + selectors.split(',').map(selector => '.mi-drawing ' + selector.trim()).join(',') + '{');
writeFileSync(new URL('../../components/artwork/instrument-palette.ts', import.meta.url), `export const instrumentPalette = ${JSON.stringify(scopedPalette)};\n`);
const body = [...layers.back, ...layers.front].map(item => item.svg).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="mi-drawing" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="An explanatory two-owner connection instrument with separate decision pins and a locked release door"><desc>Illustration, not live activity. Public intent trays feed a permission inspection carriage. Two separate decision pins precede the locked release door. World verification remains paused.</desc><style>${scopedPalette}</style><ellipse cx="350" cy="318" rx="240" ry="55" fill="#0b080e" opacity=".3"/>${body}</svg>`;
writeFileSync(new URL('../../public/artwork/connection-instrument.svg', import.meta.url), svg);
console.log(JSON.stringify({ size: 'Figure', parts: record.solids.length, viewport: [W, H], generatedRoot: root }));
if (process.argv.includes('--audit')) {
  for (const pose of [0, .25, .5, .75, 1, 2, 3]) {
    console.log(`Explanation pose ${pose + 1}`);
    A.auditOrExit(build(pose), P, { apart: false });
  }
}
