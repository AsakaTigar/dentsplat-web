import assert from 'node:assert/strict';
import { SplatLayer } from '../src/engine/SplatLayer.ts';
import {
  covarianceOf, gaussianAmplitudeAt, gaussianPdfAt, isosurfaceAmplitude,
  mahalanobisSquared, principalAxes, quatToMat3,
} from '../src/engine/gaussian.ts';

const scales = [0.2, 0.5, 1.2];
const quat = [0, 0, 0, 1];
const center = [1, 2, 3];
const alpha = 0.7;
const covariance = covarianceOf(scales, quat);
assert.deepEqual(covariance.map((v) => +v.toFixed(6)), [0.04, 0, 0, 0, 0.25, 0, 0, 0, 1.44]);
assert.deepEqual(quatToMat3(quat).map((v) => +v.toFixed(6)), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
const axes = principalAxes(scales, quat);
assert.deepEqual(axes.sigmas.map((v) => +v.toFixed(6)), [1.2, 0.5, 0.2]);
assert.equal(mahalanobisSquared(center, center, covariance), 0);
assert.ok(Math.abs(mahalanobisSquared([center[0] + scales[0], center[1], center[2]], center, covariance) - 1) < 1e-12);
assert.ok(gaussianPdfAt(center, center, covariance) > 0);
assert.equal(gaussianAmplitudeAt(center, center, covariance, alpha), alpha);
assert.ok(Math.abs(gaussianAmplitudeAt([center[0] + scales[0], center[1], center[2]], center, covariance, alpha) - alpha * Math.exp(-0.5)) < 1e-12);
assert.ok(Math.abs(isosurfaceAmplitude(alpha, 2) - alpha * Math.exp(-2)) < 1e-12);

const shRest = Float32Array.from({ length: 45 }, (_, i) => (i + 1) / 100);
const sh1 = shRest.slice(0, 9);
const cloud = {
  count: 1,
  bboxMin: [0, 0, 0], bboxMax: [2, 4, 6],
  scaleLogMin: -5, scaleLogMax: 1,
  pos: new Uint16Array([0, 0, 0]), rot: new Uint8Array([255, 127, 127, 127]),
  scale: new Uint8Array([128, 128, 128]), color: new Uint8Array([255, 128, 0]),
  misc: new Uint8Array([Math.round(alpha * 255), 31, 1, 0]),
  hasSH1: true, sh1: new Int8Array(shRest.slice(0, 9).map((v) => Math.round(v * 64))),
  meta: {},
  raw: {
    centers: Float32Array.from(center), quats: Float32Array.from(quat),
    scales: Float32Array.from(scales), colors: Float32Array.from([0.3, 0.4, 0.5]),
    alphas: Float32Array.from([alpha]), sh1, shRest, shRestCount: 45,
    shDegree: 3, sourceFormat: 'binary_little_endian',
  },
};
const layer = new SplatLayer(cloud);
const state = layer.inspect(0);
assert.ok(state);
assert.equal(state.shRestCount, 45);
assert.equal(state.shRest.length, 45);
assert.equal(state.shDegree, 3);
assert.equal(state.rotation.length, 9);
assert.equal(state.axes.eigenvalues.length, 3);
assert.equal(state.precision, 'fp32');
assert.equal(state.fdi, 31);
layer.dispose();
console.log('Gaussian Inspector math, covariance, density, isosurface and full-SH extraction: OK');
