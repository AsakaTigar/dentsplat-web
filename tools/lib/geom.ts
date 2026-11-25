/** Minimal linear-algebra + GLB writer used by the offline asset generator.
 *  Kept dependency-free so `node tools/gen-dental-assets.ts` works on a bare machine. */

export type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number]; // row-major
export type Quat = [number, number, number, number]; // x,y,z,w

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scl = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function mat3FromCols(a: V3, b: V3, c: V3): M3 {
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}
export function mulMM(a: M3, b: M3): M3 {
  const o: number[] = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o as M3;
}
export function mulMV(m: M3, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
export function rotX(t: number): M3 {
  const c = Math.cos(t), s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
export function rotY(t: number): M3 {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export function rotZ(t: number): M3 {
  const c = Math.cos(t), s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function quatFromMat3(m: M3): Quat {
  const tr = m[0] + m[4] + m[8];
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, 0.25 * s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s, (m[2] - m[6]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s, (m[3] - m[1]) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
/** Rotation by angle about an arbitrary axis (axis must be unit). */
export function quatAxisAngle(axis: V3, angle: number): Quat {
  const h = angle * 0.5, s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** Deterministic RNG so regenerated assets are byte-stable. */
export function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Evenly distributed directions on a sphere (Fibonacci lattice). */
export function fibDirections(n: number): V3[] {
  const out: V3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = ga * i;
    out.push([r * Math.cos(th), z, r * Math.sin(th)]);
  }
  return out;
}

// ---------------------------------------------------------------- GLB writer

export type ProxyMesh = { name: string; positions: Float32Array; indices: Uint32Array };

/**
 * Write a material-free binary glTF (GLB), one named node per mesh.
 * Nodes keep identity transforms: everything is baked in millimetre Y-up world space,
 * which is what the splat layer uses, so raycasts hit the visible surface exactly.
 */
export function writeGLB(meshes: ProxyMesh[]): ArrayBuffer {
  const binParts: Uint8Array[] = [];
  let binLen = 0;
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  const meshEntries: unknown[] = [];
  const nodes: unknown[] = [];

  const pushView = (bytes: Uint8Array, target: number) => {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) { binParts.push(new Uint8Array(pad)); binLen += pad; }
    bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: bytes.byteLength, target });
    binParts.push(bytes);
    binLen += bytes.byteLength;
    return bufferViews.length - 1;
  };

  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    let min: number[] = [Infinity, Infinity, Infinity];
    let max: number[] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    const pv = pushView(new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength), 34962);
    accessors.push({
      bufferView: pv, componentType: 5126, count: m.positions.length / 3, type: 'VEC3',
      min: min.map((x) => (Number.isFinite(x) ? x : 0)),
      max: max.map((x) => (Number.isFinite(x) ? x : 0)),
    });
    const pi = pushView(new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength), 34963);
    accessors.push({ bufferView: pi, componentType: 5125, count: m.indices.length, type: 'SCALAR' });
    meshEntries.push({ primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, mode: 4 }] });
    nodes.push({ name: m.name, mesh: meshEntries.length - 1 });
  }

  const json = {
    asset: { version: '2.0', generator: 'dent-splat-proxy' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: meshEntries,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonChunkLen = jsonBytes.byteLength + jsonPad;
  const binPad = (4 - (binLen % 4)) % 4;
  const binChunkLen = binLen + binPad;

  const out = new ArrayBuffer(12 + 8 + jsonChunkLen + 8 + binChunkLen);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4; // 'glTF'
  dv.setUint32(o, 2, true); o += 4;
  dv.setUint32(o, out.byteLength, true); o += 4;
  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  u8.set(jsonBytes, o); o += jsonBytes.byteLength;
  for (let i = 0; i < jsonPad; i++) u8[o++] = 0x20;
  dv.setUint32(o, binChunkLen, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // 'BIN\0'
  for (const p of binParts) { u8.set(p, o); o += p.byteLength; }
  return out;
}

/** Icosahedron-based unit sphere mesh, subdivided `lvl` times (0 => 12 verts). */
export function uvSphere(rings: number, segs: number): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < segs; s++) {
      const th = (2 * Math.PI * s) / segs;
      positions.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * segs + s, b = r * segs + ((s + 1) % segs);
      const c = (r + 1) * segs + s, d = (r + 1) * segs + ((s + 1) % segs);
      if (r !== 0) indices.push(a, c, d);
      if (r !== rings - 1) indices.push(a, d, b);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
