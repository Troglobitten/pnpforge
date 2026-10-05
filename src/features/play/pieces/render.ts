/**
 * Game-piece renderer. Every look (shape · material · colour · size), turned to a yaw and drawn at a
 * pixel density, is rasterised ONCE in a single shared WebGL2 context and copied into a small 2D
 * canvas that is cached. Table pieces only ever blit that image, so a hundred pieces cost a hundred
 * tiny bitmaps and nothing per frame.
 *
 * View and light match the dice (VIEW_TILT 18°, key light from the north-west). Passes, per image:
 *   1. shadow maps from the light (tray, pieces)   2. a bottom-up height map (contact occlusion)
 *   3. acrylic: back-face depth (thickness)          4. ground: soft PCSS shadow + contact AO, premultiplied
 *   5. opaque surfaces (wood / plastic / tray)       6. acrylic back faces, then front faces, blended
 *   7. resolve: 2× supersampled linear -> sRGB premultiplied, into the output canvas
 * The shaders are small and loop-light on purpose: ANGLE's D3D compiler inlines and unrolls
 * everything, and a ray-marching shader took 1.5–10 s to compile per variant.
 */
import { CT, LIGHT, ST, buildScene, lookKey, renderWin, SHAPE_DIMS, type PieceLook, type Scene, type Win } from './model';
import { pieceMesh, trayMesh, type Mesh } from './mesh';

const VD = [0, -ST, CT];
const f6 = (v: number) => v.toFixed(6);

const COMMON = /* glsl */ `
const vec3 VD = vec3(0.0, ${f6(-ST)}, ${f6(CT)});
const vec3 LD = vec3(${f6(LIGHT[0])}, ${f6(LIGHT[1])}, ${f6(LIGHT[2])});
`;

const MESH_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
uniform mat4 uVP;
uniform mat4 uM;
uniform mat3 uNM;
uniform float uS;
out vec3 vW;
out vec3 vN;
out vec3 vL;
void main() {
  vec4 w = uM * vec4(aPos, 1.0);
  vW = w.xyz;
  vN = uNM * aNrm;
  vL = aPos * uS;
  gl_Position = uVP * w;
}`;

const DEPTH_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform int uBackOnly;
in vec3 vN;
in vec3 vW;
in vec3 vL;
out vec4 o;
void main() {
  if (uBackOnly == 1 && dot(vN, VD) > 0.0) discard;
  o = vec4(1.0);
}`;

const SURF_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform int uMode;      // 0 wood, 1 plastic, 2 acrylic back faces, 3 acrylic front faces, 4 tray
uniform int uShape;
uniform vec3 uCol;
uniform float uSeed;
uniform float uS;
uniform mat4 uLVP;
uniform sampler2D uShT;
uniform sampler2D uShP;
uniform float uPieceW;
uniform float uBias;
uniform float uTexel;
uniform sampler2D uBack;
uniform vec2 uFB;
uniform float uDR;
uniform vec3 uTray;     // R, H, W
in vec3 vW;
in vec3 vN;
in vec3 vL;
out vec4 o;

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.5 * vnoise(p);
  p = p * 2.03 + vec3(1.7, 9.2, 3.1);
  s += 0.25 * vnoise(p);
  p = p * 2.03 + vec3(1.7, 9.2, 3.1);
  s += 0.125 * vnoise(p);
  return s / 0.875;
}

vec3 woodAlb(vec3 q, vec3 col, int shape, float seed, float contrast, float S) {
  vec3 w = q + vec3(seed * 13.1, seed * 7.3, seed * 3.7);
  float rho;
  float along;
  if (shape == 1) { rho = length(q.xy - vec2(0.95, 0.4) * S + seed); along = w.z; }
  else if (shape == 4 || shape == 9) { rho = length(q.xy + seed * 0.05); along = w.z; }
  else if (shape == 2) { rho = length(vec2(w.x + 2.6 * S, w.y - 3.1 * S)); along = w.z; }
  else if (shape == 3) { rho = length(vec2(w.x + 3.0 * S, w.z + 2.4 * S)); along = w.y; }
  else { rho = length(vec2(w.y + 2.8 * S, w.z - 3.4 * S)); along = w.x; }
  float warp = fbm(vec3(along * 0.07, rho * 0.3, seed)) * 1.6;
  float r = rho * 1.05 + warp;
  float f = fract(r);
  float late = smoothstep(0.6, 0.85, f) * (1.0 - smoothstep(0.88, 1.0, f));
  float fib = vnoise(vec3(along * 0.2, r * 11.0, seed * 5.0));
  float pore = vnoise(w * vec3(3.1, 3.1, 3.1));
  float blot = fbm(w * 0.3);
  float tone = 1.0 - contrast * (0.1 * late + 0.08 * (fib - 0.5) + 0.04 * (pore - 0.5) + 0.07 * (blot - 0.5));
  vec3 alb = col * tone;
  return mix(alb, alb * vec3(1.0, 0.88, 0.74), contrast * 0.22 * late);
}

vec3 env(vec3 d) {
  float up = clamp(d.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.05, 0.045, 0.04), vec3(0.78, 0.8, 0.84), smoothstep(0.45, 0.98, up));
  c += vec3(2.2) * pow(max(dot(d, LD), 0.0), 18.0);
  return c;
}

float pcf(sampler2D sm, vec3 q) {
  float s = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++)
      s += step(q.z - uBias, texture(sm, q.xy + vec2(float(x), float(y)) * uTexel * 1.3).r);
  return s / 9.0;
}

float lightVis(vec3 w, vec3 n) {
  vec4 lp = uLVP * vec4(w + n * 0.06, 1.0);
  vec3 q = lp.xyz * 0.5 + 0.5;
  q.z = min(q.z, 0.9999);
  float t = pcf(uShT, q);
  float p = pcf(uShP, q);
  return t * (1.0 - (1.0 - p) * uPieceW);
}

void main() {
  vec3 n = normalize(vN);
  vec3 V = VD;
  if (uMode == 2 || uMode == 3) {
    bool front = dot(n, V) > 0.0;
    if ((uMode == 3) != front) discard;
  }
  float lit = lightVis(vW, n);
  float sky = 0.5 + 0.5 * n.z;
  vec3 H = normalize(LD + V);
  float nh = max(dot(n, H), 0.0);
  float cav = 0.82 + 0.18 * smoothstep(0.0, 0.25 * uS, vW.z);   // a little darker toward the ground

  if (uMode == 0 || uMode == 4) {
    vec3 alb;
    if (uMode == 4) {
      alb = woodAlb(vW, vec3(0.50, 0.30, 0.15), 9, 3.0, 1.1, uS);
      float inner = smoothstep(uTray.x - uTray.z * 1.1, uTray.x - uTray.z * 2.6, length(vW.xy)) * step(vW.z, uTray.y - 0.25);
      alb *= 1.0 - 0.25 * inner;
    } else {
      alb = woodAlb(vL, uCol, uShape, uSeed, 1.0, uS);
    }
    float wrap = clamp((dot(n, LD) + 0.25) / 1.25, 0.0, 1.0);
    vec3 c = alb * ((0.3 * sky + 0.12) * cav + 0.82 * wrap * lit);
    c += vec3(uMode == 4 ? 0.07 : 0.045) * pow(nh, 12.0) * lit;
    o = vec4(c, 1.0);
    return;
  }
  if (uMode == 1) {
    // moulded plastic: dyed right through, so full-strength colour (a touch more saturated than paint),
    // little ambient lift, and gloss as a tight key highlight plus an area light gliding across flat faces
    float lum = dot(uCol, vec3(0.2126, 0.7152, 0.0722));
    vec3 sat = clamp(mix(vec3(lum), uCol, 1.25), 0.0, 1.0);
    float dif = max(dot(n, LD), 0.0);
    vec3 c = sat * ((0.12 * sky + 0.05) * cav + 1.08 * dif * lit);
    float F = 0.04 + 0.96 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    c += env(reflect(-V, n)) * F * 0.5;
    // a close area light: its reflection is a small bright patch, not a wash over the whole face
    vec3 Lp = normalize(vec3(-1.2, 1.6, 2.6) * uS - vW);
    float g = max(dot(n, normalize(Lp + V)), 0.0);
    c += vec3(1.0) * (0.95 * pow(nh, 160.0) + 0.6 * pow(g, 260.0)) * lit;
    o = vec4(c, 1.0);
    return;
  }
  if (uMode == 2) {
    // the far side of an acrylic piece, seen through it: faint body colour, bright where it turns away
    float edge = pow(1.0 - abs(dot(n, V)), 2.2);
    vec3 hueB = min(uCol * 1.2, vec3(1.0));
    vec3 c = hueB * 0.1 + mix(hueB, vec3(1.0), 0.3) * edge * 0.6 * (0.55 + 0.45 * lit);
    float a = 0.1 + 0.45 * edge;
    o = vec4(min(c, vec3(a)), a);
    return;
  }
  // acrylic front faces
  float dB = texture(uBack, gl_FragCoord.xy / uFB).r;
  float T = dB < 1.0 ? max(0.0, dB - gl_FragCoord.z) * 2.0 * uDR : 0.3 * uS;
  float cosi = max(dot(n, V), 0.0);
  float F = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
  // Tinted transparent: each channel passes in proportion to the dye (yellow stops blue, black stops
  // everything), deeper through thick parts. What the table shows through with is set by the coverage;
  // the body carries the dye's own hue at full saturation so it never greys out.
  vec3 tr = pow(max(uCol, vec3(0.004)), vec3(T * 1.25 / uS));
  float lumT = dot(tr, vec3(0.2126, 0.7152, 0.0722));
  // the dye's own colour, not brightened: a lifted hue plus the table showing through reads pastel
  vec3 hue = min(uCol * 1.2, vec3(1.0));
  float A = clamp(0.22 + 0.58 * (1.0 - lumT), 0.22, 0.9);
  vec3 body = hue * A * (0.92 + 0.3 * max(dot(n, LD), 0.0)) * (0.75 + 0.25 * lit);
  // a tight glint only: a broad lobe washed every flat top with white and turned the dye pastel / black grey
  vec3 spec = vec3(1.4 * pow(nh, 220.0) + 0.03 * pow(nh, 60.0)) * lit;
  // the sky reflection is kept faint on faces seen head-on (a table room, not a studio sky): at full
  // strength it laid ~5% grey over every top, black read mid-grey and every dye pastel
  vec3 refl = env(reflect(-V, n)) * F * mix(0.35, 1.0, pow(1.0 - cosi, 3.0));
  float rimT = pow(1.0 - cosi, 2.5);
  vec3 rim = mix(hue, vec3(1.0), 0.35) * rimT * 0.7;
  vec3 gloss = refl + spec + rim;
  vec3 C = body + gloss;
  float Aout = clamp(max(A + dot(gloss, vec3(0.3333)) * 0.6, max(C.r, max(C.g, C.b))), 0.0, 1.0);
  o = vec4(min(C, vec3(1.0)), Aout);
}`;

const GROUND_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
uniform mat4 uVP;
out vec2 vW;
void main() {
  vW = aPos;
  gl_Position = uVP * vec4(aPos, 0.0, 1.0);
}`;

const GROUND_FS = /* glsl */ `#version 300 es
precision highp float;
${COMMON}
uniform mat4 uLVP;
uniform sampler2D uShT;
uniform sampler2D uShP;
uniform float uPieceW;
uniform float uBias;
uniform float uLRange;
uniform float uS;
uniform sampler2D uUnder;
uniform vec4 uUXf;       // under map: cx, cy, 1/R, height range
uniform vec3 uCol;
uniform int uAcrylic;
in vec2 vW;
out vec4 o;

const vec2 PD[16] = vec2[16](
  vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
  vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
  vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
  vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float softVis(sampler2D sm, vec3 q, mat2 rot) {
  float search = (0.45 * uS) / uLRange;
  float bsum = 0.0;
  float bn = 0.0;
  for (int i = 0; i < 16; i++) {
    float d = texture(sm, q.xy + rot * PD[i] * search).r;
    if (d < q.z - uBias) { bsum += d; bn += 1.0; }
  }
  if (bn < 0.5) return 1.0;
  float dist = (q.z - bsum / bn) * uLRange;
  float pen = (0.25 + dist * 0.2) / uLRange;
  float s = 0.0;
  for (int i = 0; i < 16; i++) s += step(q.z - uBias, texture(sm, q.xy + rot * PD[i] * pen).r);
  return s / 16.0;
}

void main() {
  vec3 w = vec3(vW, 0.0);
  vec4 lp = uLVP * vec4(w, 1.0);
  vec3 q = lp.xyz * 0.5 + 0.5;
  q.z = min(q.z, 0.9999);
  float a0 = ign(gl_FragCoord.xy) * 6.2831853;
  mat2 rot = mat2(cos(a0), sin(a0), -sin(a0), cos(a0));
  float vt = softVis(uShT, q, rot);
  float vp = softVis(uShP, q, rot);
  float dark = 1.0 - vt * (1.0 - (1.0 - vp) * uPieceW);
  // contact occlusion: how low the nearest thing above this spot comes
  float ao = 0.0;
  for (int i = 0; i < 12; i++) {
    vec2 off = rot * PD[i] * 0.3 * uS;
    vec2 uv = ((vW + off) - uUXf.xy) * uUXf.z * 0.5 + 0.5;
    float h = texture(uUnder, uv).r * uUXf.w;
    ao += clamp(1.0 - h / (0.2 * uS), 0.0, 1.0);
  }
  ao /= 12.0;
  float aoW = uAcrylic == 1 ? 0.35 : 1.0;
  float a = clamp(0.5 * dark + 0.4 * ao * aoW, 0.0, 0.82);
  vec3 c = uAcrylic == 1 ? uCol * 0.14 * (1.0 - vp) * vt * a : vec3(0.0);
  o = vec4(c, max(a, max(c.r, max(c.g, c.b))));
}`;

const RESOLVE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const RESOLVE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOrigin;
uniform vec2 uOut;
uniform vec2 uScale;
out vec4 o;
void main() {
  vec2 uv = (gl_FragCoord.xy - uOrigin) / uOut * uScale;
  vec4 c = texture(uTex, uv);
  if (c.a <= 0.0005) { o = vec4(0.0); return; }
  vec3 u = clamp(c.rgb / c.a, 0.0, 1.0);
  u = pow(u, vec3(1.0 / 2.2));
  o = vec4(u * c.a, c.a);
}`;

/* ------------------------------------------------------------------ */
/* GL plumbing                                                          */
/* ------------------------------------------------------------------ */

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Prog {
  p: WebGLProgram;
  u: Uniforms;
}
interface GpuMesh {
  vao: WebGLVertexArrayObject;
  count: number;
}
interface Target {
  fb: WebGLFramebuffer;
  color?: WebGLTexture;
  depth: WebGLTexture | WebGLRenderbuffer;
  w: number;
  h: number;
}
interface GL {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  depth: Prog;
  surf: Prog;
  ground: Prog;
  resolve: Prog;
  meshes: Map<string, GpuMesh>;
  quad: WebGLVertexArrayObject;
  quadBuf: WebGLBuffer;
  tri: WebGLVertexArrayObject;
  shT: Target;
  shP: Target;
  under: Target;
  main: Target | null;
  back: Target | null;
  float: boolean;
}

let glState: GL | null | undefined;
const SHADOW = 1024;
const UNDER = 384;

function depthTarget(gl: WebGL2RenderingContext, w: number, h: number): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  return { fb, depth: tex, w, h };
}

function colorTarget(gl: WebGL2RenderingContext, w: number, h: number, float: boolean): Target {
  const color = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, color);
  gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const rb = gl.createRenderbuffer()!;
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  return { fb, color, depth: rb, w, h };
}

function freeTarget(gl: WebGL2RenderingContext, t: Target | null) {
  if (!t) return;
  gl.deleteFramebuffer(t.fb);
  if (t.color) gl.deleteTexture(t.color);
  if (t.depth instanceof WebGLTexture) gl.deleteTexture(t.depth);
  else gl.deleteRenderbuffer(t.depth);
}

/* Shaders compile in the background (KHR_parallel_shader_compile) as soon as warming starts; the
   first real render only blocks for whatever hasn't finished by then. */
interface Pending {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  ext: { COMPLETION_STATUS_KHR: number } | null;
  progs: WebGLProgram[];
  build: () => GL | null;
}
let pending: Pending | null = null;

const PROGRAMS: [string, string, string[]][] = [
  [MESH_VS, DEPTH_FS, ['uVP', 'uM', 'uNM', 'uS', 'uBackOnly']],
  [MESH_VS, SURF_FS, ['uVP', 'uM', 'uNM', 'uS', 'uMode', 'uShape', 'uCol', 'uSeed', 'uLVP', 'uShT', 'uShP', 'uPieceW', 'uBias', 'uTexel', 'uBack', 'uFB', 'uDR', 'uTray']],
  [GROUND_VS, GROUND_FS, ['uVP', 'uLVP', 'uShT', 'uShP', 'uPieceW', 'uBias', 'uLRange', 'uS', 'uUnder', 'uUXf', 'uCol', 'uAcrylic']],
  [RESOLVE_VS, RESOLVE_FS, ['uTex', 'uOrigin', 'uOut', 'uScale']],
];

function startGL(): Pending | null {
  if (pending) return pending;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false, alpha: true, depth: false });
  if (!gl) return null;
  const ext = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
  // kick off every compile + link without asking for status (which would block)
  const raw = PROGRAMS.map(([vs, fs]) => {
    const p = gl.createProgram()!;
    for (const [type, src] of [
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs],
    ] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    return p;
  });
  pending = { gl, canvas, ext, progs: raw, build: () => finishGL(gl, canvas, raw) };
  return pending;
}

function initGL(): GL | null {
  if (glState !== undefined) return glState;
  const p = startGL();
  glState = p ? p.build() : null;
  return glState;
}

function finishGL(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement, raw: WebGLProgram[]): GL | null {
  const float = !!gl.getExtension('EXT_color_buffer_float');
  const linked = raw.map((p, i) => {
    if (gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const u: Uniforms = {};
      for (const n of PROGRAMS[i][2]) u[n] = gl.getUniformLocation(p, n);
      return { p, u } as Prog;
    }
    console.warn('[pieces] program:', gl.getProgramInfoLog(p), gl.getAttachedShaders(p)?.map((s) => gl.getShaderInfoLog(s)).join(' '));
    return null;
  });
  const [depth, surf, ground, resolve] = linked;
  if (!depth || !surf || !ground || !resolve) return null;

  const quadBuf = gl.createBuffer()!;
  const quad = gl.createVertexArray()!;
  gl.bindVertexArray(quad);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(12), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const tri = gl.createVertexArray()!;
  gl.bindVertexArray(tri);
  const triBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    glState = undefined;
    pending = null;
    warmed = false;
  });
  glState = {
    gl,
    canvas,
    depth,
    surf,
    ground,
    resolve,
    meshes: new Map(),
    quad,
    quadBuf,
    tri,
    shT: depthTarget(gl, SHADOW, SHADOW),
    shP: depthTarget(gl, SHADOW, SHADOW),
    under: depthTarget(gl, UNDER, UNDER),
    main: null,
    back: null,
    float,
  };
  return glState;
}

function gpuMesh(g: GL, key: string, make: () => Mesh): GpuMesh {
  let m = g.meshes.get(key);
  if (m) return m;
  const { gl } = g;
  const mesh = make();
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const pb = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, pb);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.pos, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const nb = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, nb);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.nrm, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  const ib = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  m = { vao, count: mesh.idx.length };
  g.meshes.set(key, m);
  return m;
}

/** Column-major mat4 from rows. */
function mat4(rows: number[][]): Float32Array {
  const m = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) m[c * 4 + r] = rows[r][c];
  return m;
}

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return a.map((v) => v / l);
};
const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function hexToLinear(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xc8302a;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function bounds(scene: Scene) {
  const S = scene.look.size;
  const d = SHAPE_DIMS[scene.look.shape];
  let x0 = Infinity,
    y0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    z1 = -Infinity;
  const grow = (x: number, y: number, z: number, r: number) => {
    x0 = Math.min(x0, x - r);
    x1 = Math.max(x1, x + r);
    y0 = Math.min(y0, y - r);
    y1 = Math.max(y1, y + r);
    z0 = Math.min(z0, z - r);
    z1 = Math.max(z1, z + r);
  };
  for (const inst of scene.instances) {
    const c = [inst.rot[2] * d.bc * S, inst.rot[5] * d.bc * S, inst.rot[8] * d.bc * S];
    grow(inst.pos[0] + c[0], inst.pos[1] + c[1], inst.pos[2] + c[2], d.br * S);
  }
  if (scene.tray) grow(0, 0, scene.tray.h / 2, Math.hypot(scene.tray.r, scene.tray.h / 2));
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, Math.max(0, (z0 + z1) / 2)];
  return { c, r: Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 0.5, zTop: Math.max(1, z1 + 0.5) };
}

/** A rendered image: the canvas covers `win` (mm, v up) at `ppm` pixels per mm. */
export interface PieceImage {
  canvas: HTMLCanvasElement;
  win: Win;
  ppm: number;
}

/**
 * No WebGL: the same meshes (coarse level), projected and painted back to front with flat shading on a
 * 2D canvas, over a blurred projected shadow. Slower (tens of ms per look, cached like the GPU images)
 * but every shape, material and the supply bowl still read as themselves.
 */
function drawFallback(scene: Scene, win: Win, ppm: number, out: HTMLCanvasElement) {
  const ctx = out.getContext('2d')!;
  const look = scene.look;
  const S = look.size;
  const acrylic = look.material === 'acrylic';
  const hex = /^#?([0-9a-f]{6})$/i.exec(look.color.trim());
  const n0 = hex ? parseInt(hex[1], 16) : 0xc8302a;
  const base = [(n0 >> 16) & 255, (n0 >> 8) & 255, n0 & 255];
  const TRAY = [196, 158, 114];
  const px = (x: number, y: number, z: number): [number, number] => [(x - win.u0) * ppm, (win.v1 - (y * CT + z * ST)) * ppm];
  type Tri = { d: number; p: [number, number][]; rgb: number[]; a: number; grazing: number };
  const tris: Tri[] = [];
  const shadow: [number, number][][] = [];
  const add = (mesh: Mesh, rot: number[] | null, pos: number[], scale: number, rgb: number[], see: boolean, kind: 'piece' | 'tray') => {
    const { pos: P, idx } = mesh;
    const W = (i: number) => {
      const x = P[i * 3] * scale;
      const y = P[i * 3 + 1] * scale;
      const z = P[i * 3 + 2] * scale;
      if (!rot) return [x + pos[0], y + pos[1], z + pos[2]];
      return [rot[0] * x + rot[1] * y + rot[2] * z + pos[0], rot[3] * x + rot[4] * y + rot[5] * z + pos[1], rot[6] * x + rot[7] * y + rot[8] * z + pos[2]];
    };
    for (let t = 0; t < idx.length; t += 3) {
      const a = W(idx[t]);
      const b = W(idx[t + 1]);
      const c = W(idx[t + 2]);
      let nn = cross3([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      const l = Math.hypot(nn[0], nn[1], nn[2]);
      if (l < 1e-9) continue;
      nn = nn.map((v) => v / l);
      // orient outward: meshes are not consistently wound, so compare with the stored vertex normal
      const vn = mesh.nrm;
      const i0 = idx[t];
      let ref = [vn[i0 * 3], vn[i0 * 3 + 1], vn[i0 * 3 + 2]];
      if (rot) ref = [rot[0] * ref[0] + rot[1] * ref[1] + rot[2] * ref[2], rot[3] * ref[0] + rot[4] * ref[1] + rot[5] * ref[2], rot[6] * ref[0] + rot[7] * ref[1] + rot[8] * ref[2]];
      if (dot3(nn, ref) < 0) nn = nn.map((v) => -v);
      const facing = dot3(nn, VD);
      if (kind === 'piece') {
        const lx = LIGHT[0] / LIGHT[2];
        const ly = LIGHT[1] / LIGHT[2];
        shadow.push([a, b, c].map((p) => px(p[0] - lx * p[2], p[1] - ly * p[2], 0)));
      }
      if (facing <= 0 && !see) continue;
      const k = facing <= 0 ? 0.35 : 0.38 + 0.1 * nn[2] + 0.62 * Math.max(0, dot3(nn, LIGHT as unknown as number[]));
      const d = (dot3(a, VD) + dot3(b, VD) + dot3(c, VD)) / 3;
      tris.push({ d, p: [px(a[0], a[1], a[2]), px(b[0], b[1], b[2]), px(c[0], c[1], c[2])], rgb: rgb.map((v) => Math.min(255, v * k)), a: see ? (facing <= 0 ? 0.18 : 0.5) : 1, grazing: 1 - Math.abs(facing) });
    }
  };
  const round = ROUND[look.material];
  const mesh = pieceMesh(look.shape, round, 1);
  if (scene.tray) {
    const t = scene.tray;
    const tm = trayMesh(t.r, t.h, t.floor, t.wall, 1);
    add(tm, null, [0, 0, 0], 1, TRAY, false, 'tray');
    // the bowl's own shadow
    const c = px(0, 0, 0);
    ctx.save();
    ctx.filter = `blur(${Math.max(1, 0.12 * S * ppm)}px)`;
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.ellipse(c[0] + t.r * 0.18 * ppm, c[1] + t.r * 0.16 * ppm, t.r * ppm, t.r * CT * ppm, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const inst of scene.instances) add(mesh, inst.rot, inst.pos, S, base, acrylic, 'piece');
  if (!scene.tray && shadow.length) {
    const sh = document.createElement('canvas');
    sh.width = out.width;
    sh.height = out.height;
    const sc = sh.getContext('2d')!;
    sc.fillStyle = '#000';
    for (const tri of shadow) {
      sc.beginPath();
      sc.moveTo(tri[0][0], tri[0][1]);
      sc.lineTo(tri[1][0], tri[1][1]);
      sc.lineTo(tri[2][0], tri[2][1]);
      sc.closePath();
      sc.fill();
    }
    ctx.save();
    ctx.globalAlpha = acrylic ? 0.2 : 0.42;
    ctx.filter = `blur(${Math.max(1, 0.1 * S * ppm)}px)`;
    ctx.drawImage(sh, 0, 0);
    ctx.restore();
  }
  tris.sort((p, q) => p.d - q.d);
  ctx.lineJoin = 'round';
  for (const t of tris) {
    const [r, g, b] = t.rgb.map((v) => Math.round(v));
    const style = t.a < 1 && t.grazing > 0.8 ? `rgba(${Math.min(255, r + 120)},${Math.min(255, g + 120)},${Math.min(255, b + 120)},0.55)` : `rgba(${r},${g},${b},${t.a})`;
    ctx.fillStyle = style;
    ctx.beginPath();
    ctx.moveTo(t.p[0][0], t.p[0][1]);
    ctx.lineTo(t.p[1][0], t.p[1][1]);
    ctx.lineTo(t.p[2][0], t.p[2][1]);
    ctx.closePath();
    ctx.fill();
    if (t.a === 1) {
      // hide hairline seams between neighbouring triangles
      ctx.strokeStyle = style;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }
}

const ROUND = { wood: 0.075, plastic: 0.045, acrylic: 0.03 } as const;
const SHAPE_ID = { cube: 0, disc: 1, meeple: 2, house: 3, pawn: 4 } as const;

function renderScene(scene: Scene, ppmWanted: number): PieceImage {
  const w0 = renderWin(scene);
  let ppm = ppmWanted;
  const span = Math.max(w0.u1 - w0.u0, w0.v1 - w0.v0);
  if (span * ppm > 1400) ppm = 1400 / span;
  const W = Math.max(4, Math.ceil((w0.u1 - w0.u0) * ppm));
  const H = Math.max(4, Math.ceil((w0.v1 - w0.v0) * ppm));
  const win: Win = { u0: w0.u0, v0: w0.v1 - H / ppm, u1: w0.u0 + W / ppm, v1: w0.v1 };
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const g = initGL();
  if (!g) {
    drawFallback(scene, win, ppm, out);
    return { canvas: out, win, ppm };
  }
  const { gl } = g;
  const look = scene.look;
  const S = look.size;
  const acrylic = look.material === 'acrylic';
  const ss = W * H > 250000 ? 1 : 2;
  const WS = W * ss;
  const HS = H * ss;

  // render targets (grown, never shrunk)
  if (!g.main || g.main.w < WS || g.main.h < HS) {
    const tw = Math.max(WS, g.main?.w ?? 0, 256);
    const th = Math.max(HS, g.main?.h ?? 0, 256);
    freeTarget(gl, g.main);
    freeTarget(gl, g.back);
    g.main = colorTarget(gl, tw, th, g.float);
    g.back = depthTarget(gl, tw, th);
  }
  const main = g.main;
  const back = g.back!;

  const b = bounds(scene);
  const R = b.r;
  // view: u = x, v = y cos t + z sin t, depth along VD
  const cu = (win.u0 + win.u1) / 2;
  const hu = (win.u1 - win.u0) / 2;
  const cv = (win.v0 + win.v1) / 2;
  const hv = (win.v1 - win.v0) / 2;
  const dc = dot3(b.c, VD);
  const dr = R + 2;
  // clip x/y cover the viewport of WS×HS inside a larger target: scale accordingly
  const sx = WS / main.w;
  const sy = HS / main.h;
  const VP = mat4([
    [sx / hu, 0, 0, (-cu / hu) * sx + (sx - 1)],
    [0, (sy * CT) / hv, (sy * ST) / hv, (-cv / hv) * sy + (sy - 1)],
    [0, ST / dr, -CT / dr, dc / dr],
    [0, 0, 0, 1],
  ]);
  // light
  const lf = [...LIGHT];
  const lu = norm3([0 - lf[0] * lf[2], 0 - lf[1] * lf[2], 1 - lf[2] * lf[2]]);
  const lr = cross3(lu, lf);
  const LR = R + 1;
  const LVP = mat4([
    [lr[0] / LR, lr[1] / LR, lr[2] / LR, -dot3(lr, b.c) / LR],
    [lu[0] / LR, lu[1] / LR, lu[2] / LR, -dot3(lu, b.c) / LR],
    [-lf[0] / LR, -lf[1] / LR, -lf[2] / LR, dot3(lf, b.c) / LR],
    [0, 0, 0, 1],
  ]);
  // under map: from below, depth = height
  const UR = Math.hypot(R, R);
  const UVP = mat4([
    [1 / UR, 0, 0, -b.c[0] / UR],
    [0, 1 / UR, 0, -b.c[1] / UR],
    [0, 0, 2 / b.zTop, -1],
    [0, 0, 0, 1],
  ]);

  const round = ROUND[look.material];
  const pm = gpuMesh(g, `${look.shape}|${round}`, () => pieceMesh(look.shape, round));
  const t = scene.tray;
  const tm = t ? gpuMesh(g, `tray|${t.r}|${t.h}|${t.floor}|${t.wall}`, () => trayMesh(t.r, t.h, t.floor, t.wall)) : null;

  const models = scene.instances.map((inst) => {
    const r = inst.rot;
    return {
      M: mat4([
        [r[0] * S, r[1] * S, r[2] * S, inst.pos[0]],
        [r[3] * S, r[4] * S, r[5] * S, inst.pos[1]],
        [r[6] * S, r[7] * S, r[8] * S, inst.pos[2]],
        [0, 0, 0, 1],
      ]),
      NM: new Float32Array([r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]),
    };
  });
  const I4 = mat4([
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ]);
  const I3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  const drawPieces = (prog: Prog, each?: (i: number) => void) => {
    gl.bindVertexArray(pm.vao);
    gl.uniform1f(prog.u.uS, S);
    models.forEach((m, i) => {
      gl.uniformMatrix4fv(prog.u.uM, false, m.M);
      gl.uniformMatrix3fv(prog.u.uNM, false, m.NM);
      each?.(i);
      gl.drawElements(gl.TRIANGLES, pm.count, gl.UNSIGNED_INT, 0);
    });
  };
  const drawTray = (prog: Prog) => {
    if (!tm) return;
    gl.bindVertexArray(tm.vao);
    gl.uniform1f(prog.u.uS, 1);
    gl.uniformMatrix4fv(prog.u.uM, false, I4);
    gl.uniformMatrix3fv(prog.u.uNM, false, I3);
    gl.drawElements(gl.TRIANGLES, tm.count, gl.UNSIGNED_INT, 0);
  };

  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LESS);
  gl.depthMask(true);

  /* 1-3: depth passes */
  gl.useProgram(g.depth.p);
  gl.uniform1i(g.depth.u.uBackOnly, 0);
  const depthPass = (tgt: Target, vp: Float32Array, what: 'tray' | 'pieces' | 'all', w = tgt.w, h = tgt.h) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fb);
    gl.viewport(0, 0, w, h);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(g.depth.u.uVP, false, vp);
    if (what !== 'pieces') drawTray(g.depth);
    if (what !== 'tray') drawPieces(g.depth);
  };
  depthPass(g.shT, LVP, 'tray');
  depthPass(g.shP, LVP, 'pieces');
  depthPass(g.under, UVP, 'all');
  if (acrylic) {
    gl.uniform1i(g.depth.u.uBackOnly, 1);
    depthPass(back, VP, 'pieces', main.w, main.h);
    gl.uniform1i(g.depth.u.uBackOnly, 0);
  }

  /* 4: ground */
  gl.bindFramebuffer(gl.FRAMEBUFFER, main.fb);
  gl.viewport(0, 0, main.w, main.h);
  gl.clearColor(0, 0, 0, 0);
  gl.clearDepth(1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const col = hexToLinear(look.color);
  const pieceW = acrylic ? 0.42 : 1;
  const bias = 0.06 / (2 * LR);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(g.ground.p);
  const gu = g.ground.u;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, g.shT.depth as WebGLTexture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, g.shP.depth as WebGLTexture);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, g.under.depth as WebGLTexture);
  gl.uniform1i(gu.uShT, 0);
  gl.uniform1i(gu.uShP, 1);
  gl.uniform1i(gu.uUnder, 2);
  gl.uniformMatrix4fv(gu.uVP, false, VP);
  gl.uniformMatrix4fv(gu.uLVP, false, LVP);
  gl.uniform1f(gu.uPieceW, pieceW);
  gl.uniform1f(gu.uBias, bias);
  gl.uniform1f(gu.uLRange, 2 * LR);
  gl.uniform1f(gu.uS, S);
  gl.uniform4f(gu.uUXf, b.c[0], b.c[1], 1 / UR, b.zTop);
  gl.uniform3fv(gu.uCol, col);
  gl.uniform1i(gu.uAcrylic, acrylic ? 1 : 0);
  const gx0 = win.u0 - 2;
  const gx1 = win.u1 + 2;
  const gy0 = win.v0 / CT - 2;
  const gy1 = win.v1 / CT + 2;
  gl.bindBuffer(gl.ARRAY_BUFFER, g.quadBuf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([gx0, gy0, gx1, gy0, gx1, gy1, gx0, gy0, gx1, gy1, gx0, gy1]));
  gl.bindVertexArray(g.quad);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  /* 5: opaque surfaces */
  gl.useProgram(g.surf.p);
  const su = g.surf.u;
  gl.uniform1i(su.uShT, 0);
  gl.uniform1i(su.uShP, 1);
  gl.uniform1i(su.uBack, 3);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, acrylic ? (back.depth as WebGLTexture) : null);
  gl.uniformMatrix4fv(su.uVP, false, VP);
  gl.uniformMatrix4fv(su.uLVP, false, LVP);
  gl.uniform1f(su.uPieceW, pieceW);
  gl.uniform1f(su.uBias, bias);
  gl.uniform1f(su.uTexel, 1 / SHADOW);
  gl.uniform2f(su.uFB, main.w, main.h);
  gl.uniform1f(su.uDR, dr);
  gl.uniform3f(su.uTray, t?.r ?? 0, t?.h ?? 0, t?.wall ?? 0);
  gl.uniform3fv(su.uCol, col);
  gl.uniform1i(su.uShape, SHAPE_ID[look.shape]);
  gl.enable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  if (tm) {
    gl.uniform1i(su.uMode, 4);
    drawTray(g.surf);
  }
  const seed = (i: number) => gl.uniform1f(su.uSeed, 0.37 + i * 1.91);
  if (!acrylic) {
    gl.uniform1i(su.uMode, look.material === 'wood' ? 0 : 1);
    drawPieces(g.surf, seed);
  } else {
    /* 6: acrylic */
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1i(su.uMode, 2);
    drawPieces(g.surf, seed);
    gl.uniform1i(su.uMode, 3);
    drawPieces(g.surf, seed);
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);

  /* 7: resolve into the default framebuffer, then copy out */
  const canvas = g.canvas;
  if (canvas.width < W || canvas.height < H) {
    canvas.width = Math.max(canvas.width, W);
    canvas.height = Math.max(canvas.height, H);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const oy = canvas.height - H;
  gl.viewport(0, oy, W, H);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(g.resolve.p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, main.color!);
  gl.uniform1i(g.resolve.u.uTex, 0);
  gl.uniform2f(g.resolve.u.uOrigin, 0, oy);
  gl.uniform2f(g.resolve.u.uOut, W, H);
  gl.uniform2f(g.resolve.u.uScale, WS / main.w, HS / main.h);
  gl.bindVertexArray(g.tri);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  out.getContext('2d')!.drawImage(canvas, 0, 0, W, H, 0, 0, W, H);
  return { canvas: out, win, ppm };
}

/* ------------------------------------------------------------------ */
/* Cache                                                                */
/* ------------------------------------------------------------------ */

export interface PieceReq {
  look: PieceLook;
  /** Degrees clockwise (the entity's rotation). */
  yaw: number;
  /** Device pixels per mm wanted. */
  ppm: number;
  /** Held above the table (mm). */
  lift?: number;
  supply?: boolean;
}

/** Densities are rendered in half-octave steps so a zoom only re-renders when it crosses one. */
export function ppmBucket(ppm: number) {
  const b = 2 ** (Math.ceil(Math.log2(Math.max(0.5, ppm)) * 2) / 2);
  return Math.min(40, Math.max(1.41, b));
}

function yawBucket(req: PieceReq) {
  const y = (((Math.round(req.yaw) % 360) + 360) % 360) | 0;
  if (req.supply) return y;
  if (req.look.shape === 'disc' || req.look.shape === 'pawn') return 0;
  if (req.look.shape === 'cube') return y % 90;
  return y;
}

const cache = new Map<string, PieceImage>();
let cachedPx = 0;
const BUDGET = 36e6;

const keyOf = (req: PieceReq, ppm: number) => `${lookKey(req.look)}|${yawBucket(req)}|${ppm}|${(req.lift ?? 0).toFixed(1)}|${req.supply ? 1 : 0}`;

function store(key: string, img: PieceImage) {
  cache.set(key, img);
  cachedPx += img.canvas.width * img.canvas.height;
  for (const [k, v] of cache) {
    if (cachedPx <= BUDGET) break;
    if (k === key) continue;
    cache.delete(k);
    cachedPx -= v.canvas.width * v.canvas.height;
  }
}

/** The exact image if it is already rendered. */
export function peekPieceImage(req: PieceReq): PieceImage | undefined {
  const key = keyOf(req, ppmBucket(req.ppm));
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** Any already-rendered density of the same pose (to show while the exact one is queued). */
export function peekAnyDensity(req: PieceReq): PieceImage | undefined {
  const want = ppmBucket(req.ppm);
  let best: PieceImage | undefined;
  for (let e = -8; e <= 8; e++) {
    const bk = Math.min(40, Math.max(1.41, 2 ** (Math.log2(want) + e / 2)));
    const img = cache.get(keyOf(req, bk));
    if (img && (!best || Math.abs(Math.log2(img.ppm / want)) < Math.abs(Math.log2(best.ppm / want)))) best = img;
  }
  return best;
}

let warmed = false;

/**
 * Get the renderer ready before the first piece is needed: shaders start compiling in the background
 * right away; once they are done (polled, never blocking), one tiny piece is drawn at idle to allocate
 * the render targets and build a mesh. Safe to call often.
 */
export function warmPieceRenderer() {
  if (warmed || typeof window === 'undefined') return;
  warmed = true;
  const p = startGL();
  if (!p) return;
  const idle = (fn: () => void) => ((window as any).requestIdleCallback ? (window as any).requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 60));
  const ready = () => !p.ext || p.progs.every((prog) => p.gl.getProgramParameter(prog, p.ext!.COMPLETION_STATUS_KHR));
  const poll = () => {
    if (glState !== undefined) return;
    if (!ready()) {
      setTimeout(poll, 30);
      return;
    }
    idle(() => {
      if (glState !== undefined) return;
      initGL();
      pieceImage({ look: { shape: 'cube', material: 'wood', color: '#c8302a', size: 10 }, yaw: 0, ppm: 2 });
    });
  };
  poll();
}

/** Render (or fetch) synchronously. */
export function pieceImage(req: PieceReq): PieceImage {
  const hit = peekPieceImage(req);
  if (hit) return hit;
  const ppm = ppmBucket(req.ppm);
  const scene = buildScene(req.look, yawBucket(req), req.lift ?? 0, !!req.supply);
  const img = renderScene(scene, ppm);
  store(keyOf(req, ppm), img);
  return img;
}

/* A small frame-budgeted queue for re-renders nobody is waiting on (new zoom densities). */
const queue = new Map<string, { req: PieceReq; cbs: ((img: PieceImage) => void)[] }>();
let pumping = false;

function pump() {
  const t0 = performance.now();
  for (const [key, job] of queue) {
    queue.delete(key);
    const img = pieceImage(job.req);
    job.cbs.forEach((cb) => cb(img));
    if (performance.now() - t0 > 6) break;
  }
  if (queue.size) requestAnimationFrame(pump);
  else pumping = false;
}

/** Render soon (a few per frame); `cb` receives the image. Returns a cancel function. */
export function schedulePieceImage(req: PieceReq, cb: (img: PieceImage) => void): () => void {
  const key = keyOf(req, ppmBucket(req.ppm));
  let job = queue.get(key);
  if (!job) {
    job = { req, cbs: [] };
    queue.set(key, job);
  }
  job.cbs.push(cb);
  if (!pumping) {
    pumping = true;
    requestAnimationFrame(pump);
  }
  return () => {
    const j = queue.get(key);
    if (!j) return;
    j.cbs = j.cbs.filter((c) => c !== cb);
    if (!j.cbs.length) queue.delete(key);
  };
}
