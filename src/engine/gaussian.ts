export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type GaussianState = {
  index: number;
  center: Vec3;
  scales: Vec3;
  quat: Quat;
  alpha: number;
  color: Vec3;
  fdi: number;
  layer: number;
  sh1: number[] | null;
  shRest: number[] | null;
  shRestCount: number;
  shDegree: number;
  precision: 'fp32' | 'dspk-8bit';
};

export type GaussianAxes = {
  /** Covariance eigenvalues, descending. */
  eigenvalues: Vec3;
  /** Principal sigmas sqrt(eigenvalue), descending. */
  sigmas: Vec3;
  /** Unit directions in world space, aligned with sigmas. */
  directions: Vec3[];
};

export type GaussianInspect = GaussianState & {
  covariance: number[];
  rotation: number[];
  axes: GaussianAxes;
};

export function quatToMat3(q: Quat): number[] {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y),
    2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x),
    2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y),
  ];
}

export function covarianceOf(scales: Vec3, quat: Quat): number[] {
  const R = quatToMat3(quat);
  const s2 = scales.map((s) => s * s);
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    for (let k = 0; k < 3; k++) out[i * 3 + j] += R[i * 3 + k] * s2[k] * R[j * 3 + k];
  }
  return out;
}

/** Jacobi eigen-decomposition for a symmetric 3x3 matrix (row-major). */
export function symmetricEigen(m: number[]): { values: Vec3; vectors: Vec3[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iter = 0; iter < 24; iter++) {
    let p = 0, q = 1, max = Math.abs(a[1]);
    if (Math.abs(a[2]) > max) { max = Math.abs(a[2]); p = 0; q = 2; }
    if (Math.abs(a[5]) > max) { max = Math.abs(a[5]); p = 1; q = 2; }
    if (max < 1e-12) break;
    const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * a[p * 3 + q]);
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) {
      const akp = a[k * 3 + p], akq = a[k * 3 + q];
      a[k * 3 + p] = c * akp - s * akq;
      a[k * 3 + q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p * 3 + k], aqk = a[q * 3 + k];
      a[p * 3 + k] = c * apk - s * aqk;
      a[q * 3 + k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
      v[k * 3 + p] = c * vkp - s * vkq;
      v[k * 3 + q] = s * vkp + c * vkq;
    }
  }
  const order = [0, 1, 2].sort((x, y) => a[y * 3 + y] - a[x * 3 + x]);
  return {
    values: order.map((i) => Math.max(0, a[i * 3 + i])) as Vec3,
    vectors: order.map((i) => [v[i], v[3 + i], v[6 + i]] as Vec3),
  };
}

export function principalAxes(scales: Vec3, quat: Quat): GaussianAxes {
  const { values, vectors } = symmetricEigen(covarianceOf(scales, quat));
  return { eigenvalues: values, sigmas: values.map((x) => Math.sqrt(x)) as Vec3, directions: vectors };
}

export function covarianceDeterminant(covariance: number[]): number {
  const [a, b, c, d, e, f, g, h, i] = covariance;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function mahalanobisSquared(point: Vec3, center: Vec3, covariance: number[]): number {
  const [a, b, c, d, e, f, g, h, i] = covariance;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const D = c * h - b * i, E = a * i - c * g, F = b * g - a * h;
  const G = b * f - c * e, H = c * d - a * f, I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-20) return Infinity;
  const x = point[0] - center[0], y = point[1] - center[1], z = point[2] - center[2];
  return (A * x * x + B * x * y + C * x * z + D * y * x + E * y * y + F * y * z + G * z * x + H * z * y + I * z * z) / det;
}

export function gaussianPdfAt(point: Vec3, center: Vec3, covariance: number[]): number {
  const det = covarianceDeterminant(covariance);
  if (!(det > 0) || !Number.isFinite(det)) return 0;
  const norm = 1 / (Math.pow(2 * Math.PI, 1.5) * Math.sqrt(det));
  return norm * Math.exp(-0.5 * mahalanobisSquared(point, center, covariance));
}

export function gaussianAmplitudeAt(point: Vec3, center: Vec3, covariance: number[], alpha: number): number {
  return alpha * Math.exp(-0.5 * mahalanobisSquared(point, center, covariance));
}

export function isosurfaceAmplitude(alpha: number, sigmaRadius: number): number {
  return alpha * Math.exp(-0.5 * sigmaRadius * sigmaRadius);
}
