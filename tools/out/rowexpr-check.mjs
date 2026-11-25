/**
 * rowexpr-check.mjs — why did the first live capture report a layer entirely in one half of the
 * buffer whose mean row sits in the other?
 *
 * The probe used to bucket rows with `half[(i / w < h / 2) | 0]++` and average them with
 * `srow += (i / w) | 0`. Both look equivalent to the `(i - i % w) / w` form now in the file, yet the
 * capture was internally inconsistent, so one of them is not. This replays a synthetic layer that
 * occupies rows 40..82 of a 280x174 buffer (all below the 87-row midline) through both idioms.
 *
 *   node tools/out/rowexpr-check.mjs
 */
const w = 280, h = 174, MID = h / 2;
const oldBucket = new Int32Array(2), newBucket = new Int32Array(2);
let oldSum = 0, newSum = 0, n = 0;
for (let row = 40; row <= 82; row++) {
  for (let col = 0; col < 10; col++) {
    const i = row * w + col;                       // the pixel index the probe would see
    n++;
    oldSum += (i / w) | 0; oldBucket[(i / w < h / 2) | 0]++;
    newSum += (i - (i % w)) / w; newBucket[((i - (i % w)) / w) < MID ? 0 : 1]++;
  }
}
console.log(`layer occupies rows 40..82 of a ${w}x${h} buffer (midline ${MID})`);
console.log(`old idioms: mean ${(oldSum / n).toFixed(1)} buckets low/high = ${oldBucket[0]}/${oldBucket[1]}`);
console.log(`new idioms: mean ${(newSum / n).toFixed(1)} buckets low/high = ${newBucket[0]}/${newBucket[1]}`);
console.log(`\noperator precedence check:`);
console.log(`  7 < 3 | 0            -> ${7 < 3 | 0}   (parsed as (7<3)|0 = 0, not 7<(3|0))`);
console.log(`  1 < 2 | 0            -> ${1 < 2 | 0}`);
console.log(`  (i/w) | 0 with i=${40 * w}: ${((40 * w) / w) | 0}`);
const consistent = oldBucket[0] === n && newBucket[0] === n;
console.log(consistent
  ? '\nboth idioms agree here, so the capture bug was not this expression -- look elsewhere'
  : '\nthe idioms disagree: old=' + [...oldBucket] + ' new=' + [...newBucket]);
