// Wave Orb: a liquid glass orb with a spectral wave inside, rendered with WebGL2.
// The wave, the glass shell and the state transitions are ported from the
// "siri" preset of github.com/LerSent001/orb (MIT, (c) 2026 LerSent001).
//
// Every orb on a page shares ONE WebGL2 context and copies its frame into its
// own 2D canvas: Chromium caps live WebGL contexts per page (about 16), and a
// page full of orbs would otherwise start losing the oldest ones.

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// The glow falls off by this much per ball radius outside the ball, and the
// contour bulges out by at most this fraction of it.
const GLOW_FALLOFF = "8.8", MAX_DEFORM = "0.09";

// uW holds every time term already reduced to one period (see RATES), so the
// shader never sees a large, float32-rounded time.
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform float uW[11];
uniform vec4 uA; // zoom, warp, ridgeAmt, shade
uniform vec4 uB; // exposure, edgeGlow, sheen, contourDeform
uniform vec4 uC; // amp, envW, braid, core
uniform vec4 uD; // pulse, sweep, ripple, radius
uniform vec3 uCol[6]; // colorA, colorB, colorC, colorD, highlight, glow
out vec4 outColor;

const vec3 SHELL_INNER = vec3(1.0);
const vec3 SHELL_MID = vec3(0.607843, 0.956863, 1.0);
const vec3 SHELL_EDGE = vec3(0.772549, 0.662745, 1.0);
const vec3 SHEEN_COLOR = vec3(0.917647, 0.956863, 1.0);
const vec3 SPEC_COLOR = vec3(0.862745, 0.917647, 1.0);
const float GLASS_OPACITY = 0.44;
const float SHELL_MID_ALPHA = 0.18;
const float SHELL_EDGE_ALPHA = 0.18;
const float GLOSS = 0.24;

// One pixel in ball radii, and how icon-sized the ball is: 1 at 24 px across or
// less, 0 from 64. A thread or the crest thinner than a pixel smears into the
// fog, so an icon keeps each a pixel wide, two threads crisp and less fog.
float pixel, tiny;

vec2 siriBand(vec2 q, float drift, float phaseOffset, float amplitude, float mainY, float envelope, float softness, float crisp) {
  float y = amplitude * envelope * sin(q.x + drift + phaseOffset);
  float d = abs(q.y - y);
  float line = 0.018 / (sqrt(d * d + softness * softness) + 0.026) + crisp * 0.5 * tiny * exp(-d * d / (0.45 * softness * softness));
  float bandDistance = max(0.0, max(q.y - max(mainY, y), min(mainY, y) - q.y));
  return vec2(line, 0.018 / (bandDistance + 0.075) * (1.0 - 0.25 * tiny));
}

vec3 siriFluid(vec2 p) {
  float scale = 0.74 + uA.x * 0.34;
  vec2 q = p / scale;
  float envelopeBase = cos(1.57079633 * min(abs(uC.y * q.x), 1.0));
  float envelope = envelopeBase * envelopeBase;
  float low = 0.5 + 0.5 * cos(uW[0]);
  float mid = 0.5 + 0.5 * sin(uW[1] + 1.2);
  float high = 0.5 + 0.5 * cos(uW[2] + 2.1);
  float drift = uW[3];
  // Pulse bounces across the wave, sweep runs left to right and wraps where the
  // envelope is already zero, ripple swells outward from the center.
  float px = (q.x - 1.1 * sin(uW[4])) / 0.28;
  float sx = (q.x - (uW[10] * 3.4 - 1.7)) / 0.35;
  float lift = 1.0 + uD.x * 1.1 * exp(-px * px) + uD.y * 0.9 * exp(-sx * sx);
  float ripple = mix(1.0, 0.3 + 0.35 * (1.0 + cos(abs(q.x) * 5.5 - uW[6])), uD.z);
  float amp = uC.x * lift * ripple;
  float mainAmplitude = (0.25 + uA.z * 0.075 + low * 0.018) * amp;
  float bandAmplitude = mainAmplitude + (mid * 0.025 + high * 0.018) * amp;
  float mainY = mainAmplitude * envelope * sin(q.x * 1.1 + drift);
  float separation = (1.85 + uA.y * 0.2 + mid * 0.28) * mix(1.0, cos(uW[5]), uC.z);
  float pixelQ = pixel / scale;
  float softness = max(0.035 + (1.0 - uA.z) * 0.018 + mid * 0.006, pixelQ);

  vec2 b0 = siriBand(q, drift, -separation, bandAmplitude, mainY, envelope, softness, 0.0);
  vec2 b1 = siriBand(q, drift, -separation * 0.34, bandAmplitude, mainY, envelope, softness, 1.0);
  vec2 b2 = siriBand(q, drift, separation * 0.34, bandAmplitude, mainY, envelope, softness, 1.0);
  vec2 b3 = siriBand(q, drift, separation, bandAmplitude, mainY, envelope, softness, 0.0);
  float w0 = b0.x + b0.y, w1 = b1.x + b1.y, w2 = b2.x + b2.y, w3 = b3.x + b3.y;
  float d0 = w0 * w0, d1 = w1 * w1, d2 = w2 * w2, d3 = w3 * w3;
  vec3 spectral = (uCol[0] * d0 + uCol[2] * d1 + uCol[1] * d2 + uCol[3] * d3) / max(d0 + d1 + d2 + d3, 0.0001);
  float energy = (1.0 - exp(-(w0 + w1 + w2 + w3) * 0.58)) * envelope;
  float mainDistance = abs(q.y - mainY);
  float whiteCore = exp(-mainDistance * mainDistance / max(0.0028, 0.5 * pixelQ * pixelQ)) * envelope * uC.w;
  vec3 atmosphere = mix(uCol[3], uCol[1], smoothstep(-0.7, 0.7, q.y)) * 0.018;
  vec3 color = atmosphere + spectral * energy * 1.14;
  color += uCol[4] * whiteCore * (0.18 + 0.1 * low) * (1.0 + tiny);
  color = color / (vec3(1.0) + color * 0.18);

  float shade = uA.w;
  color = mix(color, uCol[4], shade * 0.22 * smoothstep(0.15, 1.15, dot(p, vec2(-0.32, 0.78))));
  color *= 1.0 - shade * 0.34 * smoothstep(-0.1, 1.2, dot(p, vec2(0.45, -0.62)));
  color *= 1.0 - shade * 0.22 * smoothstep(0.72, 1.08, length(p));
  return clamp(color, 0.0, 1.0);
}

// The glass body: a deep shade of the state's own colours, lifted toward the
// upper-left light so it reads as lit glass rather than a hole in the desktop.
// sRGB, like uCol, so it glides with the palette. Keep drawFlat's in step.
vec3 bodyColor(vec2 p) {
  vec3 deep = mix(uCol[3], uCol[2], 0.35) * 0.24 + vec3(0.012, 0.014, 0.024);
  return deep * (0.7 + 0.75 * smoothstep(-1.0, 1.0, dot(p, vec2(-0.566529, 0.824042))));
}

vec3 over(vec3 dst, vec3 src, float a) {
  float k = clamp(a, 0.0, 1.0);
  return src * k + dst * (1.0 - k);
}

float lobe(vec2 n, vec2 dir, float cut, float power) {
  return pow(clamp((dot(n, dir) - cut) / max(1.0 - cut, 0.001), 0.0, 1.0), power);
}

vec2 contourWave(float angle) {
  float wave = sin(angle * 3.0 + uW[7]) * 0.52 + sin(angle * 5.0 - uW[8] + 1.7) * 0.31
             + sin(angle * 2.0 + uW[9] + 3.1) * 0.17;
  float slope = cos(angle * 3.0 + uW[7]) * 1.56 + cos(angle * 5.0 - uW[8] + 1.7) * 1.55
              + cos(angle * 2.0 + uW[9] + 3.1) * 0.34;
  return vec2(wave, slope);
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  float minSide = max(min(uSize.x, uSize.y), 1.0);
  vec2 uv = (2.0 * fc - uSize) / minSide;
  float rad = max(uD.w, 0.05);
  float deform = clamp(uB.w, 0.0, 1.0) * ${MAX_DEFORM};
  float r = length(uv);
  // atan(0, 0) is undefined in GLSL, and the center pixel of an odd-sized canvas hits it.
  vec2 contour = contourWave(r > 0.0001 ? atan(uv.y, uv.x) : 0.0);
  float contourRad = rad * (1.0 + deform * contour.x);
  pixel = 2.0 / (contourRad * minSide);
  tiny = 1.0 - smoothstep(24.0, 64.0, contourRad * minSide);
  // The reference edge is 0.02 radii wide, under a pixel on a small orb, so the
  // limb gets at least a pixel of antialiasing.
  float aa = max(0.01, 1.5 / (contourRad * minSide * 0.5));
  vec3 glow = uCol[5] * uB.y;
  vec4 c;

  if (r > contourRad * (1.0 + aa)) {
    vec3 halo = clamp(glow * exp(-max(r - contourRad, 0.0) / rad * ${GLOW_FALLOFF}), 0.0, 1.0);
    c = vec4(halo, max(halo.r, max(halo.g, halo.b)));
  } else {
    vec2 p = uv / contourRad;
    float pd = length(p);
    float clearFa = 1.0 - smoothstep(0.995, 1.04, pd);
    vec2 radial = r > 0.0001 ? uv / r : vec2(0.0);
    vec2 normal = r > 0.0001 ? normalize(radial - vec2(-radial.y, radial.x) * (rad * deform * contour.y / r)) : vec2(0.0);
    float edgeDepth = max(1.0 - pd, 0.0);
    float depth = clamp(edgeDepth / (0.015 + 0.95 * SHELL_MID_ALPHA), 0.0, 1.0);
    float profile = pow(1.0 - sqrt(max(1.0 - (1.0 - depth) * (1.0 - depth), 0.0)), 0.68);
    vec2 refracted = p - normal * 1.6 * GLASS_OPACITY * profile;
    vec3 fcol = vec3(0.0);
    if (clearFa > 0.0) {
      // One fluid evaluation per channel: dispersion through the glass lens.
      float split = 0.14 * GLOSS * GLASS_OPACITY * profile;
      fcol = vec3(siriFluid(refracted - normal * split).r, siriFluid(refracted).g,
                  siriFluid(refracted + normal * split).b);
    }
    float lum = dot(fcol, vec3(0.213, 0.715, 0.072));
    vec3 clearSat = clamp(vec3(lum) + (fcol - vec3(lum)) * 1.22, 0.0, 1.0);
    // Divided by the exposure applied below, so the body lands as is. The wave
    // is light, so it screens over the body and the threads stay as bright.
    vec3 body = bodyColor(p) / max(uB.x, 0.001);
    vec3 col = mix(body, 1.0 - (1.0 - body) * (1.0 - clearSat), clearFa);

    float surfaceBand = (1.0 - smoothstep(0.0, max(0.026 + 0.055 * SHELL_EDGE_ALPHA, 1.6 * pixel), edgeDepth)) * clearFa;
    float rim = pow(surfaceBand, 1.8);
    col = over(col, SHELL_INNER, rim * GLASS_OPACITY * 0.45);
    float dispersion = rim * GLOSS * (0.8 + 0.8 * SHELL_EDGE_ALPHA);
    col = over(col, SHELL_MID, dispersion * lobe(normal, normalize(vec2(0.84, 0.54)), -0.32, 1.8));
    col = over(col, SHELL_EDGE, dispersion * lobe(normal, normalize(vec2(-0.62, -0.78)), -0.28, 2.0));
    col *= 1.0 - rim * (0.015 + 0.15 * SHELL_EDGE_ALPHA) * (0.15 + 0.85 * max(dot(normal, vec2(0.45, -0.89)), 0.0));
    float sheen = clamp(uB.z, 0.0, 2.0);
    col = over(col, SHEEN_COLOR, rim * lobe(normal, normalize(vec2(-0.68, 0.73)), 0.2, 2.8) * sheen * 1.4);
    col = over(col, SPEC_COLOR, rim * lobe(normal, normalize(vec2(0.74, -0.67)), 0.4, 3.6) * sheen);

    float ballA = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, pd);
    col = clamp(col * max(uB.x, 0.0), 0.0, 1.0) * ballA;
    vec3 outside = glow * exp(-max(r - contourRad, 0.0) / rad * ${GLOW_FALLOFF}) * smoothstep(contourRad - 0.005, contourRad + 0.005, r);
    vec3 final = clamp(col + outside, 0.0, 1.0);
    c = vec4(final, clamp(max(ballA, max(final.r, max(final.g, final.b))), 0.0, 1.0));
  }

  // Round, so whatever of the glow is left at the edge fades out as a circle
  // and never shows the canvas's square.
  float fitStart = min(mix(contourRad, 1.0, 0.6), 1.0 - 2.0 / minSide);
  outColor = c * (1.0 - smoothstep(fitStart, 1.0, r));
}`;

const TAU = Math.PI * 2;
// How fast each uW term turns per unit of phase, in uW order: radians, except
// the last (the sweep), which is in turns. Each is kept reduced to its own
// period here in float64, so it stays exact and continuous forever; handing the
// shader the raw phase instead made the wave jitter after about a day, once
// float32 had no fractional digits left for it.
const RATES = [0.37, 0.51, 0.73, 2.4, 1.9, 1.3, 3.2, 0.62, 0.41, 0.23, 0.35];

/** The logo's frame: the speaking wave 37.961 s in, where its drift is half a
 *  turn and the crest is one whole sine, rising on the left and falling on the
 *  right, the threads braided either side. Every orb starts here; the still
 *  marks and the brand art hold it. */
export const MARK_POSE = [1.479, 0.511, 2.579, 3.142, 3.011, 5.367, 2.095, 4.686, 2.998, 2.448, 0.286];

export function advancePhase(w: number[], by: number) {
  for (let i = 0; i < RATES.length; i++) {
    const period = i === RATES.length - 1 ? 1 : TAU;
    w[i] = (w[i]! + by * RATES[i]!) % period;
  }
}

// Per-state targets. The first eight keys are the reference's own uniforms
// (thinking = the siri preset, the rest derived from it); amp..audio extend the
// wave so states read by motion and shape, not by colour alone.
const KEYS = ["speed", "contourDeform", "zoom", "warp", "ridgeAmt", "shade", "exposure", "edgeGlow",
  "amp", "envW", "braid", "core", "pulse", "sweep", "ripple", "breathe", "stutter", "audio", "lift", "hum"] as const;
type Key = (typeof KEYS)[number];
const BASE: Record<Key, number> = { speed: 0.82, contourDeform: 0, zoom: 0.36, warp: 3.2, ridgeAmt: 0.5, shade: 0.12, exposure: 2, edgeGlow: 0,
  amp: 1, envW: 0.9, braid: 0, core: 1, pulse: 0, sweep: 0, ripple: 0, breathe: 0, stutter: 0, audio: 0, lift: 0, hum: 0 };
const CALM = { speed: 0.246, zoom: 0.3384, warp: 1.664, ridgeAmt: 0.24, exposure: 1.36 };
const SPEAKING = { speed: 1, exposure: 2.1, edgeGlow: 0.4, amp: 1.15, audio: 1.25,
  colors: ["#9FD4FF", "#6F8CE6", "#B08CFF", "#5B6CFF", "#FFFFFF", "#6F8CE6"] };

export const WAVE_ORB_STATES = {
  // The OpenLive logo: the speaking orb mid-sentence, a steady voice (hum) in
  // place of audio, the wave at half pace and breathing.
  mark: { ...SPEAKING, speed: 0.5, hum: 0.7, breathe: 0.5 },
  off: { ...CALM, speed: 0.12, amp: 0.05, core: 0.45, exposure: 0.9,
    colors: ["#5A6272", "#4A5364", "#545B6E", "#414858", "#8A93A6", "#3A4050"] },
  idle: { ...CALM, speed: 0.12, amp: 0.8, breathe: 1,
    colors: ["#9FB2D6", "#6E8FB8", "#8C8FC4", "#5D6E9E", "#C9D6EA", "#6F84B8"] },
  connecting: { speed: 0.6, warp: 2, ridgeAmt: 0.35, exposure: 1.6, edgeGlow: 0.15, amp: 0.95, envW: 1.35, ripple: 1,
    colors: ["#CFE0FF", "#7FB0FF", "#9DB8F0", "#5B7FD8", "#FFFFFF", "#5B9DFF"] },
  loading: { speed: 0.75, warp: 2.4, ridgeAmt: 0.4, exposure: 1.7, edgeGlow: 0.15, amp: 1, envW: 1.15, ripple: 0.75,
    colors: ["#CFE0FF", "#7FB0FF", "#9DB8F0", "#5B7FD8", "#FFFFFF", "#5B9DFF"] },
  reconnecting: { speed: 0.5, warp: 1.8, ridgeAmt: 0.3, exposure: 1.05, amp: 0.6, envW: 1.2, ripple: 0.4, stutter: 1,
    colors: ["#8C9AB8", "#6A7FA6", "#7C86A8", "#56628A", "#C0C8D8", "#56628A"] },
  listening: { speed: 0.14, warp: 1.4, ridgeAmt: 0.45, exposure: 1.8, edgeGlow: 0.3, amp: 0.5, breathe: 0.6, audio: 2.4, lift: 1,
    colors: ["#E6FF9E", "#5EF2C2", "#43C286", "#33B7D6", "#F0FFF6", "#43C286"] },
  thinking: { speed: 1.35, edgeGlow: 0.25, braid: 1, pulse: 1,
    colors: ["#FFD86B", "#F0A24A", "#C77DFF", "#8E6CFF", "#FFF3DE", "#F0A24A"] },
  speaking: SPEAKING,
  acting: { speed: 0.9, edgeGlow: 0.3, amp: 0.95, envW: 0.75, sweep: 1,
    colors: ["#FFB199", "#FF7A6B", "#FF5CB8", "#D94BFF", "#FFF0EC", "#FF6B8A"] },
  error: { ...CALM, speed: 0.2, exposure: 1.2, amp: 0.22, envW: 1.3, core: 0.6,
    colors: ["#C98A8A", "#A86464", "#B07878", "#7E4E56", "#E8CFCF", "#A84848"] },
} satisfies Record<string, Partial<Record<Key, number>> & { colors: string[] }>;
export type WaveOrbState = keyof typeof WAVE_ORB_STATES;

/** The share of its canvas the ball's radius takes: the rest is room for the
 *  brightest glow, off the widest bulge of the contour, to fade below one step
 *  of 8-bit alpha before the edge. Any less and the edge cuts it off square. */
export const WAVE_ORB_RADIUS = 1 / (1 + Number(MAX_DEFORM)
  + Math.log(255 * Math.max(...Object.values(WAVE_ORB_STATES).map((s) => (s as Partial<Record<Key, number>>).edgeGlow ?? 0))) / Number(GLOW_FALLOFF));
export type WaveOrbBands = { low: number; mid: number; high: number; all: number };

// Entering a working state snaps in (ease-out-cubic); settling anywhere else eases (smoothstep).
const ACTIVE = new Set<WaveOrbState>(["listening", "thinking", "speaking", "acting"]);

export const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

type Frame = { n: number[]; c: number[] };
export const TARGETS = Object.fromEntries(Object.entries(WAVE_ORB_STATES).map(([name, s]) => [name, {
  n: KEYS.map((k) => (s as Partial<Record<Key, number>>)[k] ?? BASE[k]),
  // Colours travel in linear light, like the reference.
  c: s.colors.flatMap((h) => [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255))),
}])) as Record<WaveOrbState, Frame>;
const mixArr = (a: number[], b: number[], k: number) => a.map((v, i) => v + (b[i]! - v) * k);
export const mixFrame = (a: Frame, b: Frame, k: number): Frame => ({ n: mixArr(a.n, b.n, k), c: mixArr(a.c, b.c, k) });
const K = Object.fromEntries(KEYS.map((k, i) => [k, i])) as Record<Key, number>;
const BANDS = ["low", "mid", "high", "all"] as const;

/** How long a move into `next` takes and its curve. The reference's 220 ms
 *  activation flashed a whole palette change in about three frames; 360 ms keeps
 *  the snap of ease-out-cubic without a visible step. */
export function transitionTo(next: WaveOrbState, reduced: boolean) {
  if (reduced) return { dur: 300, ease: (x: number) => x * x * (3 - 2 * x) };
  return ACTIVE.has(next)
    ? { dur: 360, ease: (x: number) => 1 - (1 - x) ** 3 }
    : { dur: 650, ease: (x: number) => x * x * (3 - 2 * x) };
}

/** A voice's five octave bands (low to high) folded into the orb's three plus an
 *  overall level. Without bands, the level alone drives all four. */
export function voiceBands(bands: number[] | undefined, level: number): WaveOrbBands {
  if (!bands?.length) return { low: level, mid: level, high: level, all: level };
  const b = (i: number) => bands[i] ?? 0;
  return { low: (b(0) + b(1)) / 2, mid: b(2), high: (b(3) + b(4)) / 2, all: Math.max(level, (b(0) + b(1) + b(2) + b(3) + b(4)) / 5) };
}

// A mic's spectrum never reads zero: the room's own noise holds the low bands
// at about 0.6 in silence, and speech lifts them only 0.25 to 0.4 above that,
// which left the orb looking just as excited with nobody talking. Each band's
// floor drops to any quieter reading at once and creeps up over seconds, so the
// gaps between words keep it on the room and a sentence is never taken for it.
// For its first second the floor rises fast: a mic that has just opened ramps
// up from silence, and a floor left down there would read the room as a voice.
// Measured on a MacBook mic against `say` at a speaking level.
const FLOOR_RISE_S = 3, FLOOR_WARM_S = 1, FLOOR_WARM_RISE_S = 0.2;
const MIC_KNEE = 0.04, MIC_GAIN = 6;

/** A voice's bands with the room taken out: 0 in silence, near 1 for speech. */
export function micGate() {
  let floor: number[] | null = null, age = 0;
  return (bands: number[], dt: number) => {
    // An analyser that has not filled yet reads all zeros, which is no room at all.
    if (!bands.some((v) => v > 0)) return bands.map(() => 0);
    const f = (floor ??= [...bands]);
    age += dt;
    const k = 1 - Math.exp(-dt / (age < FLOOR_WARM_S ? FLOOR_WARM_RISE_S : FLOOR_RISE_S));
    return bands.map((v, i) => {
      f[i] = v < f[i]! ? v : f[i]! + (v - f[i]!) * k;
      return Math.min(1, Math.max(0, (v - f[i]! - MIC_KNEE) * MIC_GAIN));
    });
  };
}

/** The glass body's sRGB colour from a palette in sRGB (six rgb triples), at
 *  `lift` 0 (away from the light) to 1 (the upper-left): the shader's bodyColor. */
export const glassBody = (cols: ArrayLike<number>, lift: number) =>
  [0.012, 0.014, 0.024].map((floor, k) => ((cols[9 + k]! * 0.65 + cols[6 + k]! * 0.35) * 0.24 + floor) * (0.7 + 0.75 * lift));

// Without WebGL2 (no GPU, a blocklisted driver, a lost context) the orb keeps
// its glass disc and a still wave in the state's colours, and still cross-fades.
function drawFlat(ctx: CanvasRenderingContext2D, w: number, h: number, radius: number, cols: Float32Array, amp: number, envW: number, glow: number) {
  const rgb = (i: number, a = 1) => `rgba(${[0, 1, 2].map((k) => Math.round(cols[i * 3 + k]! * 255))},${a})`;
  const r = (radius * Math.min(w, h)) / 2, cx = w / 2, cy = h / 2;
  const half = Math.min(r, (0.86 * r) / Math.max(envW, 0.5)), lift = 0.3 * r * Math.max(amp, 0.05);
  ctx.clearRect(0, 0, w, h);
  if (glow > 0) {
    const g = ctx.createRadialGradient(cx, cy, r, cx, cy, r * 1.25);
    g.addColorStop(0, rgb(5, Math.min(1, glow)));
    g.addColorStop(1, rgb(5, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  // The shader's smoothstep lift, from the lower-right to the upper-left.
  const dx = r * 0.566529, dy = r * 0.824042;
  const body = ctx.createLinearGradient(cx + dx, cy + dy, cx - dx, cy - dy);
  for (const [at, lift] of [[0, 0], [0.25, 0.15625], [0.5, 0.5], [0.75, 0.84375], [1, 1]] as const)
    body.addColorStop(at, `rgb(${glassBody(cols, lift).map((v) => Math.round(Math.min(1, v) * 255))})`);
  ctx.fillStyle = body;
  ctx.fill();
  ctx.clip();
  const spectrum = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  [0, 2, 4, 1, 3].forEach((c, i) => spectrum.addColorStop(i / 4, rgb(c)));
  const env = (x: number) => Math.cos((Math.PI / 2) * x) ** 2;
  ctx.filter = `blur(${Math.max(0.5, r * 0.06)}px)`;
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) ctx.lineTo(cx - half + (2 * half * i) / 24, cy - lift * env(1 - (2 * i) / 24));
  for (let i = 24; i >= 0; i--) ctx.lineTo(cx - half + (2 * half * i) / 24, cy + 0.55 * lift * env(1 - (2 * i) / 24));
  ctx.fillStyle = spectrum;
  ctx.fill();
  ctx.filter = "none";
  const core = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
  core.addColorStop(0, rgb(4, 0));
  core.addColorStop(0.5, rgb(4, 0.9));
  core.addColorStop(1, rgb(4, 0));
  ctx.fillStyle = core;
  ctx.fillRect(cx - half, cy - Math.max(0.5, r * 0.02), 2 * half, Math.max(1, r * 0.04));
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r - 0.5, 0, TAU);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = Math.max(1, r * 0.025);
  ctx.stroke();
}

type Orb = { visible: boolean; w: number; h: number; dirty: boolean; wants(): boolean; draw(now: number, dt: number, live: boolean): void };
type Uniform = "uSize" | "uW" | "uA" | "uB" | "uC" | "uD" | "uCol";
const orbs = new Set<Orb>();
let gl: WebGL2RenderingContext | null = null, glCanvas: HTMLCanvasElement | null = null;
let prog: WebGLProgram | null = null, loc: Record<Uniform, WebGLUniformLocation | null> | null = null;
let raf = 0, last = 0, warned = false, paused = false;

function build(g: WebGL2RenderingContext) {
  const shader = (type: number, src: string) => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS) && !g.isContextLost()) throw new Error(g.getShaderInfoLog(s) ?? "compile failed");
    return s;
  };
  const p = g.createProgram();
  g.attachShader(p, shader(g.VERTEX_SHADER, VERT));
  g.attachShader(p, shader(g.FRAGMENT_SHADER, FRAG));
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS)) {
    if (!g.isContextLost()) console.error("wave-orb:", g.getProgramInfoLog(p));
    return;
  }
  g.useProgram(p);
  g.bindVertexArray(g.createVertexArray());
  loc = Object.fromEntries((["uSize", "uW", "uA", "uB", "uC", "uD", "uCol"] as const).map((n) => [n, g.getUniformLocation(p, n)])) as typeof loc;
  prog = p;
}

const isLive = () => !!prog && !!gl && !gl.isContextLost();
const redraw = () => { for (const o of orbs) o.dirty = true; kick(); };
const onVisibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else kick(); };

function ensureGL() {
  if (gl || glCanvas) return;
  document.addEventListener("visibilitychange", onVisibility);
  const c = glCanvas = document.createElement("canvas");
  // A context torn down by destroy() reports its loss after the next one may
  // already be up, so only the current canvas may touch the shared state.
  c.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (glCanvas === c) { prog = null; redraw(); } });
  c.addEventListener("webglcontextrestored", () => {
    if (glCanvas !== c || !gl) return;
    try { build(gl); } catch (err) { console.error("wave-orb:", err); }
    redraw();
  });
  gl = c.getContext("webgl2", { premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) {
    if (!warned) console.warn("wave-orb: WebGL2 unavailable, drawing the flat fallback");
    warned = true;
    return;
  }
  try { build(gl); } catch (err) { console.error("wave-orb:", err); }
}

function kick() {
  if (raf || paused || document.hidden || ![...orbs].some((o) => o.visible && o.wants())) return;
  last = 0;
  raf = requestAnimationFrame(frame);
}

/** Holds every orb on the page still, for a window that is hidden but not
 *  `document.hidden`. Resuming picks the wave up where it stopped. */
export function pauseWaveOrbs(on: boolean) {
  paused = on;
  if (on) { cancelAnimationFrame(raf); raf = 0; } else kick();
}

function frame(now: number) {
  raf = 0;
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  const live = isLive();
  let more = false;
  for (const o of orbs) {
    if (!o.visible || !o.wants()) continue;
    paint(o, now, dt, live);
    more ||= o.wants();
  }
  if (more) raf = requestAnimationFrame(frame);
}

function paint(o: Orb, now: number, dt: number, live: boolean) {
  if (!o.w || !o.h) return;
  if (live && glCanvas!.width < o.w) glCanvas!.width = o.w;
  if (live && glCanvas!.height < o.h) glCanvas!.height = o.h;
  o.draw(now, dt, live);
}

/** `still` draws one frame per change (size, state) and then costs nothing:
 *  for small marks that should look like the orb without running it. */
export function createWaveOrb(canvas: HTMLCanvasElement, { state = "idle" as WaveOrbState, radius = WAVE_ORB_RADIUS, still = false } = {}) {
  ensureGL();
  const ctx = canvas.getContext("2d")!;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let from = TARGETS[state], to = from, name = state, start = 0, dur = 0, ease = (x: number) => x;
  const target: WaveOrbBands = { low: 0, mid: 0, high: 0, all: 0 };
  const band: WaveOrbBands = { low: 0, mid: 0, high: 0, all: 0 };
  const w = [...MARK_POSE];
  // Seconds this orb has drawn for, paused time excluded, so breathing resumes where it stopped.
  let clock = 0;
  const cols = new Float32Array(18);
  const calm = () => still || motion.matches;

  const current = (now: number) => mixFrame(from, to, dur ? ease(Math.min(1, Math.max(0, (now - start) / dur))) : 1);

  const o: Orb = {
    visible: true, w: 0, h: 0, dirty: true,
    // The flat fallback holds still, so it too redraws only on a change.
    wants: () => o.dirty || (!calm() && isLive()),
    draw(now, dt, live) {
      const { n, c } = current(now);
      const reduced = calm();
      // One frame past the end, so a transition never rests short of its target.
      o.dirty = now < start + dur;
      for (const b of BANDS) {
        const tau = target[b] > band[b] ? 0.07 : 0.24;
        band[b] += (target[b] - band[b]) * (1 - Math.exp(-dt / tau));
      }
      // The reference's audio rules (speed, separation, contour, shimmer,
      // exposure) with its siri strength, plus amplitude so the wave rides the voice.
      const s = 0.8 * n[K.audio]!;
      // Reduced motion drops the audio, which only moves the orb; a steady hum stays.
      const level = (b: (typeof BANDS)[number]) => Math.max(reduced ? 0 : band[b], n[K.hum]!);
      const low = level("low"), mid = level("mid"), high = level("high"), all = level("all");
      const rule = (v: number, add: number, prop: number, cap: number, level: number) =>
        Math.min(Math.max(cap, v), v * (1 + prop * level * s) + add * level * s);
      // `lift` is for a state that rests almost still, so a voice has to add
      // motion rather than scale the little there is.
      const lift = s > 0 ? n[K.lift]! : 0;
      const speed = rule(n[K.speed]!, 0, 0.7, 5, all) + lift * 1.2 * all;
      const warp = rule(n[K.warp]!, 0.85, 0, 7, mid) + lift * 2 * mid;
      const contour = rule(n[K.contourDeform]!, 0.075, 0, 1, low);
      const sheen = rule(0.28, 0.16, 0, 2, high);
      const exposure = rule(n[K.exposure]!, 0, 0.12, 4, all);
      clock += dt;
      let amp = n[K.amp]! * Math.min(1.8 + lift * 1.6, 1 + s * (0.7 * low + 0.4 * all));
      let rate = 0;
      if (!reduced) {
        rate = 1;
        amp *= 1 + n[K.breathe]! * 0.16 * Math.sin(clock * 0.8);
      }
      if (n[K.stutter]! > 0 && !reduced) {
        const h = Math.abs(Math.sin(Math.floor(clock / 0.13) * 91.7) * 437.5) % 1;
        rate *= 1 + n[K.stutter]! * (h < 0.45 ? -1 : 1.3);
        amp *= 1 + n[K.stutter]! * (h - 0.5) * 0.6;
      }
      // Phase integrates speed over time, so a change of speed never makes the wave skip.
      advancePhase(w, dt * Math.max(speed, 0) * rate);
      for (let i = 0; i < 18; i++) cols[i] = srgb(c[i]!);
      if (!live) return drawFlat(ctx, o.w, o.h, radius, cols, n[K.amp]!, n[K.envW]!, n[K.edgeGlow]!);
      const g = gl!, l = loc!;
      g.viewport(0, 0, o.w, o.h);
      g.uniform2f(l.uSize, o.w, o.h);
      g.uniform1fv(l.uW, w);
      g.uniform4f(l.uA, n[K.zoom]!, warp, n[K.ridgeAmt]!, n[K.shade]!);
      g.uniform4f(l.uB, exposure, n[K.edgeGlow]!, sheen, contour);
      g.uniform4f(l.uC, amp, n[K.envW]!, n[K.braid]!, n[K.core]!);
      g.uniform4f(l.uD, n[K.pulse]!, n[K.sweep]!, n[K.ripple]!, radius);
      g.uniform3fv(l.uCol, cols);
      g.drawArrays(g.TRIANGLES, 0, 3);
      ctx.clearRect(0, 0, o.w, o.h);
      ctx.drawImage(glCanvas!, 0, glCanvas!.height - o.h, o.w, o.h, 0, 0, o.w, o.h);
    },
  };

  // The device-pixel box also reports a move to a screen of another density,
  // which the CSS box alone never does.
  const ro = new ResizeObserver(([e]) => {
    const dpr = devicePixelRatio || 1, cap = Math.min(1, 2 / dpr);
    const px = e!.devicePixelContentBoxSize?.[0];
    const w = Math.max(1, Math.round((px ? px.inlineSize : e!.contentRect.width * dpr) * cap));
    const h = Math.max(1, Math.round((px ? px.blockSize : e!.contentRect.height * dpr) * cap));
    if (w === o.w && h === o.h) return;
    o.w = canvas.width = w;
    o.h = canvas.height = h;
    // Resizing blanks the canvas, and this runs after the frame's rAF, so waiting
    // for the next one would flash an empty frame.
    if (o.visible) paint(o, performance.now(), 0, isLive());
    else o.dirty = true;
    kick();
  });
  try { ro.observe(canvas, { box: "device-pixel-content-box" }); } catch { ro.observe(canvas); }
  const io = new IntersectionObserver(([e]) => { o.visible = e!.isIntersecting; kick(); });
  io.observe(canvas);
  const onMotion = () => { o.dirty = true; kick(); };
  motion.addEventListener("change", onMotion);
  orbs.add(o);

  return {
    setState(next: WaveOrbState) {
      if (next === name || !TARGETS[next]) return;
      const now = performance.now();
      from = current(now);
      to = TARGETS[next];
      name = next;
      start = now;
      ({ dur, ease } = transitionTo(next, motion.matches));
      o.dirty = true;
      kick();
    },
    setBands(b: Partial<WaveOrbBands>) {
      for (const k of BANDS) { const v = b[k]; target[k] = v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
    },
    destroy() {
      ro.disconnect();
      io.disconnect();
      motion.removeEventListener("change", onMotion);
      orbs.delete(o);
      if (orbs.size) return;
      cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener("visibilitychange", onVisibility);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      gl = glCanvas = prog = loc = null;
    },
  };
}
export type WaveOrb = ReturnType<typeof createWaveOrb>;
