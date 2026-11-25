/** DentSplat GLSL (WebGL2 / GLSL ES 3.00) for the custom anisotropic Gaussian layer.
 *
 *  Everything that makes this a *dental* renderer rather than a generic splat viewer lives
 *  here, in the vertex stage, so it costs zero CPU per frame:
 *    - per-splat FDI id + anatomical layer id ride along as vertex attributes
 *    - clipping planes with a "section cap": splats just behind the plane are snapped ONTO it
 *      and recoloured, so a cut arch shows dentine/pulp instead of a hollow shell
 *    - per-layer alpha (CBCT transparency) and per-jaw offset (occlusal opening)
 *    - hidden-tooth bitmasks (isolate a single tooth without touching the buffer)
 *    - view-dependent l=1 spherical harmonics for wet-enamel sheen
 */

export const SPLAT_VERTEX = /* glsl */ `
precision highp float;
precision highp int;

attribute vec3 aCenter;      // mm, world space (occlusal plane = y0, maxilla +y, lips +z)
attribute vec4 aRot;         // snorm quaternion x,y,z,w
attribute vec3 aScale;       // 0..255 log-scale
attribute vec3 aColor;       // 0..255 linear DC colour
attribute vec4 aMisc;        // alpha, fdi, layerId, flags
attribute mat3 aSH1;         // quantised l=1 bands, column = channel: (y, z, x)

// NB: modelMatrix / modelViewMatrix / projectionMatrix / viewMatrix / normalMatrix /
// cameraPosition / position / normal / uv are injected by three's GLSL3 prefix. Redeclaring
// any of them here is a hard redefinition error in GLSL ES 3.00, the program silently fails to
// link, and every drawElements afterwards is GL_INVALID_OPERATION (black frame, no exception).

uniform vec2 uViewportPx;
uniform vec2 uScaleRange;    // logMin, logSpan
uniform float uSH1Scale;     // 1/64: raw int8 -> SH band units
uniform float uSigmas;
uniform float uJawGap;
uniform float uSheen;
uniform float uExposure;
uniform int uSelectedTooth;
uniform int uPulseTooth;
uniform float uPulse;
uniform int uHiddenLo;
uniform int uHiddenHi;
uniform int uClipCount;
uniform vec4 uClipPlanes[4];
uniform float uClipBand;
uniform int uCapEnable;
uniform float uLayerAlpha[9];
uniform vec3 uCapTint;
uniform int uDebug;

out vec2 vQuadCoord;
out vec3 vColor;
out float vAlpha;
out float vSel;
out float vLesion;

const float SH_C1 = 0.4886025119683723;

mat3 quatToMat3(vec4 q) {
  return mat3(
    1.0 - 2.0 * (q.y * q.y + q.z * q.z), 2.0 * (q.x * q.y + q.w * q.z), 2.0 * (q.x * q.z - q.w * q.y),
    2.0 * (q.x * q.y - q.w * q.z), 1.0 - 2.0 * (q.x * q.x + q.z * q.z), 2.0 * (q.y * q.z + q.w * q.x),
    2.0 * (q.x * q.z + q.w * q.y), 2.0 * (q.y * q.z - q.w * q.x), 1.0 - 2.0 * (q.x * q.x + q.y * q.y)
  );
}

bool toothHidden(int fdi) {
  int lo = int(uint(fdi) & 31u);
  int hi = fdi - 32;
  if (hi >= 0) return ((uint(uHiddenHi) >> uint(hi)) & 1u) == 1u;
  return ((uint(uHiddenLo) >> uint(lo)) & 1u) == 1u;
}

void main() {
  int fdi = int(aMisc.y + 0.5);
  int layerId = int(aMisc.z + 0.5);
  int flags = int(aMisc.w + 0.5);
  vQuadCoord = vec2(0.0);
  vColor = vec3(0.0);
  vAlpha = 0.0;
  vSel = 0.0;
  vLesion = 0.0;

  if (fdi > 0 && toothHidden(fdi)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

  vec3 pos = aCenter;
  // --- mandibular kinematics ----------------------------------------------------
  // uJawGap is the *interincisal opening in mm*, not a fudge factor: the mandible swings
  // about a hinge axis through the condyles, and beyond ~20 mm the condyle glides down the
  // eminence. Rotating the splat basis with it keeps the ellipsoid orientation correct,
  // which a translated mesh or a volume renderer would not need.
  mat3 jawRot = mat3(1.0);
  if ((flags & 2) != 0 && uJawGap > 0.001) {
    float rh = 66.0;                                   // hinge -> lower incisal edge, mm
    float th = 2.0 * asin(clamp(uJawGap / (2.0 * rh), 0.0, 0.8));
    float sn = sin(th), cs = cos(th);
    float glide = max(0.0, uJawGap - 20.0) * 0.30;
    vec3 hinge = vec3(0.0, -14.0, -34.0);
    vec3 p = pos - hinge;
    pos = hinge + vec3(p.x, p.y * cs - p.z * sn, p.y * sn + p.z * cs)
          + vec3(0.0, -glide, -glide * 0.45);
    jawRot = mat3(1.0, 0.0, 0.0, 0.0, cs, sn, 0.0, -sn, cs);
  } else if ((flags & 1) != 0 && uJawGap > 0.001) {
    pos.y += min(1.2, uJawGap * 0.02);                 // maxilla barely recoils
  }

  // --- clipping planes + section cap -------------------------------------------
  float capW = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uClipCount) break;
    vec4 pl = uClipPlanes[i];
    float sd = dot(pl.xyz, pos) - pl.w;
    if (sd < 0.0) {
      if (uCapEnable == 1 && -sd <= uClipBand) {
        pos -= pl.xyz * sd;                       // snap exactly onto the cut plane
        capW = max(capW, 1.0 - (-sd) / max(uClipBand, 1e-4));
      } else {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
    }
  }

  vec4 qq = normalize(aRot);
  vec3 s = exp(uScaleRange.x + (aScale / 255.0) * uScaleRange.y);
  mat3 R = jawRot * quatToMat3(qq);
  mat3 M = R * mat3(s.x, 0.0, 0.0, 0.0, s.y, 0.0, 0.0, 0.0, s.z);
  // a section-capped splat is flattened onto the plane so the cut reads as a solid disc
  if (capW > 0.0) {
    vec3 nrm = normalize(uClipPlanes[0].xyz);
    float along = dot(M[0], nrm);
    M[0] -= nrm * along * 0.98;
    along = dot(M[1], nrm);
    M[1] -= nrm * along * 0.98;
    along = dot(M[2], nrm);
    M[2] -= nrm * along * 0.98;
  }
  mat3 cov = M * transpose(M);

  vec4 cam = modelViewMatrix * vec4(pos, 1.0);
  if (cam.z > -0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  mat3 V = mat3(modelViewMatrix);
  mat3 cv = V * cov * transpose(V);

  float fx = 0.5 * uViewportPx.x * projectionMatrix[0][0];
  float fy = 0.5 * uViewportPx.y * projectionMatrix[1][1];
  float z = -cam.z;
  mat3 J = mat3(
    vec3(-fx / z, 0.0, 0.0),
    vec3(0.0, -fy / z, 0.0),
    vec3(fx * cam.x / (z * z), fy * cam.y / (z * z), 0.0)
  );
  mat3 c2 = J * cv * transpose(J);
  float a = c2[0][0] + 0.32;
  float b = c2[1][0];
  float c = c2[1][1] + 0.32;

  float mid = 0.5 * (a + c);
  float disc = sqrt(max(1e-6, mid * mid - (a * c - b * b)));
  float l1 = max(mid + disc, 1e-5);
  float l2 = max(mid - disc, 1e-5);
  vec2 ax1 = abs(b) > 1e-9 ? normalize(vec2(b, l1 - a)) : vec2(1.0, 0.0);
  vec2 ax2 = vec2(-ax1.y, ax1.x);
  float ext = uSigmas;

  // corner of the quad, derived from the vertex layout (4 consecutive verts per splat)
  int cIdx = gl_VertexID & 3;
  vec2 corner = vec2((cIdx == 1 || cIdx == 2) ? 1.0 : -1.0, (cIdx >= 2) ? 1.0 : -1.0);
  vec2 offsetPx = corner.x * ax1 * sqrt(l1) * ext + corner.y * ax2 * sqrt(l2) * ext;

  // Bisection harness for automated verification. uDebug 1 ignores the covariance and stamps a
  // fixed 9 px quad at each projected centre (proves attribute/index/blend/readback path);
  // uDebug 2 keeps the real extents (proves the EWA maths) with forced opaque white.
  if (uDebug == 1 || uDebug == 2) {
    vec2 dbgOff = uDebug == 1 ? corner * 9.0 : offsetPx;
    vec4 dbgClip = projectionMatrix * cam;
    dbgClip.xy += dbgOff * (2.0 / uViewportPx) * dbgClip.w;
    gl_Position = dbgClip;
    vQuadCoord = corner * ext;
    vColor = vec3(1.0);
    vAlpha = 1.0;
    vSel = 0.0;
    vLesion = 0.0;
    return;
  }
  if (max(length(offsetPx) / max(fx, fy), 0.0002) > 0.35) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);       // splat bigger than the screen: cull
    return;
  }

  vec4 clip = projectionMatrix * cam;
  clip.xy += offsetPx * (2.0 / uViewportPx) * clip.w;
  gl_Position = clip;
  vQuadCoord = corner * ext;

  // --- shading -----------------------------------------------------------------
  vec3 col = aColor / 255.0;
  if (uSheen > 0.0) {
    mat3 sh = aSH1 * uSH1Scale;                 // columns: R, G, B band coefficients (y, z, x)
    float shEnergy = abs(sh[0].x) + abs(sh[0].y) + abs(sh[0].z)
                   + abs(sh[1].x) + abs(sh[1].y) + abs(sh[1].z)
                   + abs(sh[2].x) + abs(sh[2].y) + abs(sh[2].z);
    if (shEnergy > 0.0) {
      // (-y, z, -x) is the l=1 basis order a 3DGS PLY stores its coefficients in
      vec3 d = normalize(pos - cameraPosition);
      vec3 dir = vec3(-d.y, d.z, -d.x);
      col += SH_C1 * vec3(dot(dir, sh[0]), dot(dir, sh[1]), dot(dir, sh[2])) * uSheen;
    }
  }
  if (capW > 0.0) {
    vec3 cut = layerId == 6 ? vec3(0.78, 0.18, 0.22)
      : layerId == 1 ? vec3(0.90, 0.88, 0.83)
      : layerId == 2 || layerId == 3 ? vec3(0.78, 0.66, 0.50)
      : uCapTint;
    col = mix(col, cut, clamp(capW * 1.4, 0.0, 1.0));
  }
  vColor = max(col, vec3(0.0)) * uExposure;
  vAlpha = (aMisc.x / 255.0) * uLayerAlpha[min(layerId, 8)];
  vSel = (fdi == uSelectedTooth && uSelectedTooth > 0) ? 1.0 : 0.0;
  if (fdi == uPulseTooth && uPulseTooth > 0) vSel = max(vSel, uPulse);
  vLesion = (flags & 4) != 0 ? 1.0 : 0.0;
}
`;

export const SPLAT_FRAGMENT = /* glsl */ `
precision highp float;

in vec2 vQuadCoord;
in vec3 vColor;
in float vAlpha;
in float vSel;
in float vLesion;

uniform vec3 uHighlight;
uniform vec3 uLesionColor;
uniform float uOpacityScale;
uniform float uOutline;
uniform int uShowLesions;

out vec4 fragColor;

void main() {
  float r2 = dot(vQuadCoord, vQuadCoord);
  if (r2 > 9.0) discard;
  float a = vAlpha * exp(-0.5 * r2) * uOpacityScale;
  if (a < 0.0035) discard;
  vec3 col = vColor;
  if (vSel > 0.0) {
    float edge = smoothstep(0.45, 1.35, sqrt(r2));
    col = mix(col, uHighlight, 0.22 * vSel);
    col += uHighlight * edge * vSel * uOutline;
  } else if (uShowLesions == 1 && vLesion > 0.0) {
    float edge = smoothstep(0.5, 1.4, sqrt(r2));
    col += uLesionColor * edge * 0.55;
  }
  fragColor = vec4(col * a, a);
}
`;
