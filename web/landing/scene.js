// The hero scene: one WebGL2 full-screen pass. A rolling contour backdrop and a
// procedural vault dial. The dial burns away after the veil lifts, then exists
// only along the cursor's recent path; an inked outline on a clean plate and a scan wave keep it
// legible in between.

import { rgbOf, clamp01 } from './engine.js';

const MAX_TRAIL = 24;

export function getTier() {
  const coarse = matchMedia('(hover: none) and (pointer: coarse)').matches;
  const narrow = innerWidth < 768;
  if (coarse || narrow) return { name: 'mobile', dpr: Math.min(devicePixelRatio || 1, 2), frameInterval: 1000 / 60 - 2, trail: 0, reveal: false, pointer: false };
  const big = innerWidth * innerHeight * Math.min(devicePixelRatio, 2) ** 2 > 5.5e6;
  return { name: 'desktop', dpr: Math.min(devicePixelRatio || 1, big ? 1.25 : 1.75), frameInterval: 0, trail: MAX_TRAIL, reveal: true, pointer: true };
}

const VERT = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uRes; uniform float uTime; uniform float uIntro; uniform float uRise;
uniform vec2 uCenter; uniform float uRadius; uniform vec2 uPointer; uniform float uRot;
uniform vec2 uTrail[${MAX_TRAIL}]; uniform int uTrailN; uniform float uBrush; uniform float uTaper; uniform float uGate;
uniform float uRevealOn; uniform float uRevealOpacity; uniform vec3 uWaves; uniform float uOutline;
uniform vec3 uBg; uniform vec3 uLine; uniform vec3 uAccent; uniform vec3 uInk;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }

float backdropField(vec2 p, float t){
  float f = sin(p.x * 1.00 + t * 0.60) * 0.50;
  f += sin(p.y * 0.85 - t * 0.45) * 0.45;
  f += sin((p.x + p.y) * 0.65 + t * 0.35) * 0.35;
  f += sin((p.x - p.y) * 0.95 - t * 0.55) * 0.25;
  return f * 0.5 + 0.5;
}
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0); return length(pa - ba * h); }
float inside(float d, float w){ return 1.0 - smoothstep(-w, w, d); }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

// Height of the dial at q (dial radius = 1). Also returns a material code.
float dialHeight(vec2 q, float aa, out float mat){
  float r = length(q), a = atan(q.y, q.x);
  float H = 0.0; mat = 0.0;
  // bezel
  float inB = inside(abs(r - 0.915) - 0.085, aa * 1.5);
  float prof = 0.62 + 0.3 * cos(clamp((r - 0.915) / 0.085, -1.0, 1.0) * 1.5708);
  float n60 = a / 6.28318 * 60.0; float k = floor(n60 + 0.5); float da = abs(n60 - k) * 6.28318 / 60.0 * r;
  float big = step(0.5, 1.0 - step(0.01, abs(mod(k, 5.0))));
  float tick = inside(da - mix(0.0045, 0.008, big), aa) * inside(abs(r - 0.925) - mix(0.035, 0.055, big), aa);
  H = max(H, inB * (prof - 0.28 * tick));
  if (inB > 0.5) mat = 1.0 + tick;
  // plate
  float inP = inside(r - 0.8, aa * 1.5);
  if (inP > 0.0 && H < 0.3 * inP) { H = 0.3 * inP; mat = 3.0; }
  // three spokes with knobs
  float ds = 1e3;
  for (int i = 0; i < 3; i++) {
    float ang = uRot + float(i) * 2.0944;
    vec2 dir = vec2(cos(ang), sin(ang));
    float cap = sdSeg(q, dir * 0.12, dir * 0.6) - 0.05;
    float knob = length(q - dir * 0.66) - 0.085;
    ds = smin(ds, smin(cap, knob, 0.04), 0.03);
  }
  float inS = inside(ds, aa * 1.5);
  float sp = inS * (0.7 + 0.22 * clamp(-ds / 0.05, 0.0, 1.0));
  if (sp > H) { H = sp; mat = 4.0; }
  // hub
  float inH = inside(r - 0.2, aa * 1.5);
  float hub = inH * (0.86 + 0.14 * sqrt(max(0.0, 1.0 - r * r / 0.04)));
  if (hub > H) { H = hub; mat = 5.0; }
  return H;
}

float reveal(vec2 px){
  if (uTrailN < 2 || uBrush < 0.5) return 0.0;
  vec2 w = px + (vec2(vnoise(px / 140.0 + uTime * 0.35), vnoise(px / 140.0 - uTime * 0.31 + 7.1)) - 0.5) * uBrush * 0.6;
  float m = 1e5; float span = float(uTrailN - 1);
  for (int i = 0; i < ${MAX_TRAIL - 1}; i++) {
    if (i >= uTrailN - 1) break;
    float wt = pow(1.0 - float(i) / span, uTaper);
    m = min(m, sdSeg(w, uTrail[i], uTrail[i + 1]) - uBrush * wt);
  }
  return 1.0 - smoothstep(-1.5, 1.5, m);
}

void main(){
  vec2 px = gl_FragCoord.xy;
  px.y += uRise;
  float t = uTime * 1.66;
  // backdrop contours
  vec2 ndc = (px / uRes) * 2.0 - 1.0;
  vec2 p = vec2(ndc.x * uRes.x / uRes.y, ndc.y) * 3.8;
  vec2 qq = p; qq.x += sin(p.y * 0.8 + t * 0.7) * 0.37; qq.y += cos(p.x * 0.7 - t * 0.6) * 0.37;
  float scaled = backdropField(qq, t) * 2.5;
  float lw = max(fwidth(scaled) * 1.4, 1e-5);
  float line = 1.0 - smoothstep(0.0, lw, abs(fract(scaled) - 0.5));
  vec3 col = mix(uBg, uLine, line * 0.85);

  float rv = uRevealOn * uGate * reveal(px);
  float parity = mod(floor(scaled + 0.5), 2.0);
  vec3 greys = mix(vec3(0.81), vec3(0.69), parity);
  col = mix(col, greys, rv * uRevealOpacity);

  // dial
  vec2 c = uCenter + uPointer * vec2(1.0, -1.0) * uRes * 0.012;
  vec2 q = (px - c) / uRadius;
  float aa = 1.2 / uRadius;
  float r = length(q);
  {
    float mat;
    float H = dialHeight(q, aa, mat);
    float shell = inside(r - 1.0, aa);
    // normal from screen-space slope of the height field
    float hs = uRadius * 0.045;
    vec3 n = normalize(vec3(-dFdx(H) * hs, -dFdy(H) * hs, 1.0));
    vec3 L = normalize(vec3(uPointer.x * 0.9 - 0.35, -uPointer.y * 0.9 + 0.55, 0.75));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0, 0, 1)), 0.0), 36.0);
    float ang = atan(q.y, q.x);
    vec3 base = vec3(0.45);
    if (mat < 1.5) base = vec3(0.77);
    else if (mat < 2.5) base = vec3(0.17);
    else if (mat < 3.5) base = vec3(0.22) + (vnoise(vec2(r * 520.0, ang * 1.5)) - 0.5) * 0.05;
    else if (mat < 4.5) base = vec3(0.61) + (vnoise(vec2(ang * 900.0, r * 4.0)) - 0.5) * 0.04;
    else base = vec3(0.07, 0.08, 0.09);
    vec3 env = mix(vec3(0.05, 0.055, 0.065), vec3(0.95, 0.97, 0.98), n.y * 0.5 + 0.5);
    vec3 metal = base * (0.22 + 0.78 * diff) + spec * 0.85 + env * 0.12;
    float hubRing = 1.0 - smoothstep(0.004, 0.012, abs(r - 0.13));
    metal = mix(metal, uAccent, hubRing * step(4.5, mat));
    // burn: crown to chin, noise-broken
    float s = clamp((c.y + uRadius - px.y) / (2.0 * uRadius), 0.0, 1.0);
    float th = 0.55 * s + 0.45 * fbm(q * 3.0 + 3.0);
    float front = smoothstep(0.14, 1.0, uIntro) * 1.08 - 0.02;
    float intact = smoothstep(front - 0.02, front + 0.02, th);
    float vis = max(intact, rv) * shell;
    // once the metal burns off, the dial stays as a clean plate with an inked drawing:
    // contours stop at its rim, and a soft shadow lifts it off the page
    float outside = smoothstep(1.0, 1.0 + aa * 2.0, r);
    col *= 1.0 - 0.07 * outside * (1.0 - smoothstep(1.0, 1.22, r));
    col = mix(col, mix(uBg, vec3(1.0), 0.7), shell * (1.0 - intact) * (1.0 - rv));
    col = mix(col, metal, vis);
    col += uAccent * (4.0 * intact * (1.0 - intact)) * 1.6 * shell;
    // outline + scan waves, fading in on the burn's own curve
    float edge = clamp(length(vec2(dFdx(H), dFdy(H))) * 8.0, 0.0, 1.0);
    float rim = 1.0 - smoothstep(0.0, aa * 1.2, abs(r - 1.0));
    float wave = 0.0;
    for (int i = 0; i < 3; i++) { float wv = uWaves[i]; if (wv > -0.5) wave += exp(-pow((s - wv) / 0.15, 2.0)); }
    float stroke = max(edge, rim) * (uOutline + 0.3 * min(wave, 1.0)) * (1.0 - intact) * (1.0 - rv);
    col = mix(col, uInk, clamp(stroke, 0.0, 1.0));
  }
  outColor = vec4(col, 1.0);
}`;

export class Scene {
  constructor(canvas, tier) {
    this.canvas = canvas; this.tier = tier;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uRes', 'uTime', 'uIntro', 'uRise', 'uCenter', 'uRadius', 'uPointer', 'uRot', 'uTrail', 'uTrailN', 'uBrush', 'uTaper', 'uGate',
      'uRevealOn', 'uRevealOpacity', 'uWaves', 'uOutline', 'uBg', 'uLine', 'uAccent', 'uInk']) this.u[n] = gl.getUniformLocation(prog, n);
    this.colours();
    this.start = performance.now();
    this.readyAt = null; this.riseAt = null;
    this.pointer = [0.3, 0.1]; this.pTarget = [0.3, 0.1]; this.pMid = [0.3, 0.1];
    this.trail = []; this.pace = 0; this.lastRaw = null; this.rot = 0;
    this.waves = []; this.nextWave = 0;
    this.box = null; this.revealOpacity = 0.45;
  }
  colours() {
    const gl = this.gl;
    const set = (n, t) => { const [r, g, b] = rgbOf(t); gl.uniform3f(this.u[n], r, g, b); };
    set('uBg', '--background'); set('uLine', '--surface-soft'); set('uAccent', '--accent-on-light'); set('uInk', '--foreground');
  }
  resize(w, h, box) {
    this.w = w; this.h = h; this.box = box;
    const ratio = this.tier.dpr;
    this.ratio = ratio;
    this.canvas.width = Math.max(1, Math.round(w * ratio));
    this.canvas.height = Math.max(1, Math.round(h * ratio));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
  setPointer(x, y) { this.pTarget = [x, y]; }
  ready() { this.readyAt = performance.now(); }
  beginRise() { this.riseAt = performance.now(); }
  subject() {
    // centre and radius in CSS px, y down
    const { w, h, box } = this;
    if (box) return { cx: box.x + box.w / 2, cy: box.y + box.h * 0.52, r: Math.min(box.w * 0.42, box.h * 0.46) };
    return { cx: w / 2, cy: h * 0.5, r: Math.min(h * 0.33, w * 0.21) };
  }
  render(now, { frozen = false } = {}) {
    const gl = this.gl, u = this.u, R = this.ratio, tier = this.tier;
    const time = (now - this.start) / 1000;
    // pointer: two cascaded filters so the dial leans rather than snaps
    const k = 0.17;
    this.pMid[0] += (this.pTarget[0] - this.pMid[0]) * k; this.pMid[1] += (this.pTarget[1] - this.pMid[1]) * k;
    this.pointer[0] += (this.pMid[0] - this.pointer[0]) * k; this.pointer[1] += (this.pMid[1] - this.pointer[1]) * k;
    // pace: eased pointer speed
    const raw = this.pTarget;
    if (this.lastRaw) {
      const sp = Math.hypot(raw[0] - this.lastRaw[0], raw[1] - this.lastRaw[1]) / 0.029;
      const tgt = clamp01(sp);
      this.pace += (tgt - this.pace) * (tgt > this.pace ? 0.09 : 0.205) * 0.6;
    }
    this.lastRaw = [raw[0], raw[1]];
    // trail of smoothed positions, in canvas pixels (y up)
    if (tier.trail) {
      const tx = ((this.pMid[0] + 1) / 2) * this.w * R, ty = (1 - (this.pMid[1] + 1) / 2) * this.h * R;
      this.trail.unshift([tx, ty]);
      if (this.trail.length > tier.trail) this.trail.length = tier.trail;
    }
    const intro = this.readyAt == null ? 0 : frozen ? 1 : clamp01((now - this.readyAt) / 4000);
    const riseP = this.riseAt == null ? 0 : frozen ? 1 : clamp01((now - this.riseAt) / 2000);
    const rise = frozen ? 0 : (this.riseAt == null ? 1 : 1 - (1 - (1 - riseP) * (1 - riseP))) * 200 * R;
    // handle angle follows pointer x, with a slow idle drift
    const rotTarget = -this.pointer[0] * 0.9 + time * 0.05;
    this.rot += (rotTarget - this.rot) * 0.08;
    // scan waves: one every 1.2s, each crossing in 3.1s
    if (!frozen && intro > 0.5 && now > this.nextWave) { this.waves.push(now); this.nextWave = now + 1200; }
    this.waves = this.waves.filter((t0) => now - t0 < 3100);
    const wv = [-1, -1, -1];
    this.waves.slice(-3).forEach((t0, i) => { wv[i] = (now - t0) / 3100 * 1.3 - 0.15; });

    const sub = this.subject();
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, frozen ? 4 : time);
    gl.uniform1f(u.uIntro, intro);
    gl.uniform1f(u.uRise, rise);
    gl.uniform2f(u.uCenter, sub.cx * R, (this.h - sub.cy) * R);
    gl.uniform1f(u.uRadius, sub.r * R);
    gl.uniform2f(u.uPointer, this.pointer[0], this.pointer[1]);
    gl.uniform1f(u.uRot, this.rot + 0.4);
    const flat = new Float32Array(MAX_TRAIL * 2);
    this.trail.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    gl.uniform2fv(u.uTrail, flat);
    gl.uniform1i(u.uTrailN, this.trail.length);
    const pace = this.pace;
    gl.uniform1f(u.uBrush, 0.2 * this.h * R * (0.28 + 0.72 * pace));
    gl.uniform1f(u.uTaper, 1.9 * 1.6 + (1.25 - 1.9 * 1.6) * pace);
    const gate = clamp01((pace - 0.06) / 0.15);
    gl.uniform1f(u.uGate, gate * gate * (3 - 2 * gate));
    gl.uniform1f(u.uRevealOn, tier.reveal && intro >= 1 ? 1 : tier.reveal ? clamp01((intro - 0.7) / 0.3) : 0);
    gl.uniform1f(u.uRevealOpacity, innerWidth < 1024 ? 0 : this.revealOpacity);
    gl.uniform3f(u.uWaves, wv[0], wv[1], wv[2]);
    gl.uniform1f(u.uOutline, 0.62);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
