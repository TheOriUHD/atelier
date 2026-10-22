/**
 * Ultracode's charged field, drawn across the effort slider's track while the value sits on the Ultracode stop: a grid
 * of small rounded cells that wavefronts from the thumb light up, quantized to five steps of violet ink over a charged
 * gradient, cooling down through the steps when it is left. WebGL2; without it, or under reduced motion, nothing is
 * drawn and only the violet label remains. The effort control keeps one canvas and context (`useFieldSlot`) that each
 * opening of its popover borrows, and releases the context when it unmounts.
 */
import { useCallback, useEffect, useState } from 'react';
import { cn } from '../../components/ui/index.ts';
import { useReducedMotion } from '../../lib/motion.ts';

const MAX_BURSTS = 8;
/** Seconds a burst stays alive, and the envelope's rise and fall. */
const BURST_LIFE = 5;
const RISE = 0.7;
const FALL = 0.85;
/** Past this the canvas renders at a lower resolution. */
const MAX_PIXELS = 4_000_000;
const FALLBACK: RGB = [0.72, 0.59, 1];

type RGB = [number, number, number];

/** A full-window triangle from the vertex index; no buffers. */
const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uSize;               // CSS pixels
uniform float uScale;             // device pixels per CSS pixel
uniform float uTime;
uniform float uEnvelope;
uniform float uSeed;
uniform vec4 uBursts[${MAX_BURSTS}];      // origin column, origin row, start, strength (0: empty)
uniform vec3 uChargeStart;
uniform vec3 uChargeEnd;
uniform vec3 uInkCool;
uniform vec3 uInkHot;
uniform vec4 uInk;                // bed fill, ink floor, ink ceiling, energy gain
uniform vec3 uCharge;             // alpha ceiling, exponent, hue scatter
out vec4 color;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7) + uSeed);
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uSize.y * uScale - gl_FragCoord.y) / uScale;
  // 3px cells with 0.9px corners on a 4px pitch; whole rows fill the height.
  float rows = max(1.0, floor(uSize.y / 4.0));
  vec2 pitch = vec2(4.0, uSize.y / rows);
  vec2 cell = floor(px / pitch);
  vec2 corner = abs(px - (cell + 0.5) * pitch) - vec2(0.6);
  float dist = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - 0.9;
  float inside = clamp(0.5 - dist * uScale, 0.0, 1.0);

  // Each burst is a wavefront spreading from its origin cell by cell: a flash on arrival, then an afterglow.
  float energy = 0.0;
  for (int i = 0; i < ${MAX_BURSTS}; i++) {
    vec4 b = uBursts[i];
    if (b.w <= 0.0) continue;
    float d = abs(cell.x - b.x) + abs(cell.y - b.y);
    if (d > mix(10.0, 55.0, b.w) || hash(cell + b.z) > mix(0.3, 0.85, b.w)) continue;
    float t = uTime - b.z - d / mix(20.0, 36.0, b.w) - (hash(cell.yx + b.z) - 0.5) * 0.2;
    if (t < 0.0) continue;
    energy += mix(0.55, 1.0, b.w) * (1.25 * exp(-5.0 * t) + 0.65 * exp(-mix(3.3, 0.77, b.w) * t));
  }
  float phase = hash(cell + 7.0) * 6.2832;
  energy *= uEnvelope * uInk.w * (1.0 + 0.08 * sin(uTime * 1.3 + cell.x * 0.45)) * (0.92 + 0.08 * sin(uTime * 0.35 + phase));

  // Five steps of ink, never a smooth ramp; only the hottest cells breathe.
  float steps = step(0.04, energy) + step(0.2, energy) + step(0.4, energy) + step(0.6, energy) + step(0.8, energy);
  float level = steps / 5.0;
  if (steps > 4.5) level *= 1.0 - 0.28 * (0.5 + 0.5 * sin(uTime * 6.2832 / mix(2.4, 3.8, hash(cell + 3.0)) + phase));
  vec3 ink = mix(uInkCool, uInkHot, pow(level, 1.4));
  float tint = hash(cell + 11.0);
  vec3 scatter = tint < 0.28 ? vec3(0.75, 0.84, 0.95) : tint < 0.56 ? vec3(0.94, 0.74, 0.8) : ink;
  ink = mix(ink, scatter, 0.5 * uCharge.z);
  float inkAlpha = steps > 0.0 ? inside * mix(uInk.y, uInk.z, level) : 0.0;

  // Under the cells, a charge that deepens toward the thumb, revealed by the same wavefronts.
  float across = clamp(px.x / uSize.x, 0.0, 1.0);
  float chargeAlpha = uCharge.x * pow(clamp(energy, 0.0, 1.0) * across, uCharge.y) * mix(inside, 1.0, uInk.x);
  vec3 charge = mix(uChargeStart, uChargeEnd, across);
  color = vec4(ink * inkAlpha, inkAlpha) + vec4(charge * chargeAlpha, chargeAlpha) * (1.0 - inkAlpha);
}`;

interface Burst {
  column: number;
  row: number;
  start: number;
  strength: number;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function link(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = vertex && fragment ? gl.createProgram() : null;
  if (!program) return null;
  gl.attachShader(program, vertex!);
  gl.attachShader(program, fragment!);
  gl.linkProgram(program);
  // Freed with the program.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

function rgb(value: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  if (!hex) return FALLBACK;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
}

/**
 * Drives the shader: bursts while lit, an envelope that rises and falls, and frames only while anything shows. Owns its
 * canvas, which a popover attaches and detaches; `dispose` frees the context.
 */
class Field {
  private bursts: Burst[] = [];
  private lit = false;
  private litAt = 0;
  private nextBurst = 0;
  private lastActive = -Infinity;
  /** The envelope before smoothing, 0–1. */
  private level = 0;
  private seed = Math.random() * 100;
  private frame = 0;
  private last = 0;
  private palette: { colors: RGB[]; dark: boolean } | null = null;
  /** Tells the host that the context was lost while the canvas was in it. */
  private onLost = () => {};
  private readonly epoch = performance.now();
  private readonly uniform: (name: string) => WebGLUniformLocation | null;
  private readonly resize: ResizeObserver;

  /**
   * A field, or why there is none: no context, which can come back (too many contexts open, a GPU reset), or shaders
   * that don't link, which won't.
   */
  static create(): Field | 'no-context' | 'unsupported' {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return 'no-context';
    const program = link(gl);
    if (program) return new Field(canvas, gl, program);
    const lost = gl.isContextLost();
    loseContext(gl);
    return lost ? 'no-context' : 'unsupported';
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
  ) {
    canvas.className = 'absolute inset-0 size-full';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.ultracodeField = '';
    const locations = new Map<string, WebGLUniformLocation | null>();
    this.uniform = (name) => {
      if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
      return locations.get(name) ?? null;
    };
    this.resize = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.devicePixelContentBoxSize?.[0];
      const width = box?.inlineSize ?? entry.contentRect.width * devicePixelRatio;
      const height = box?.blockSize ?? entry.contentRect.height * devicePixelRatio;
      const scale = Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(width * height, 1)));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      if (this.level > 0) this.draw(this.now());
    });
  }

  /** The GPU dropped the context (a driver reset, too many contexts): this field can't draw again. */
  get lost(): boolean {
    return this.gl.isContextLost();
  }

  /** Puts the canvas into `host` (over the slider's track), unlit; `onLost` hears when the GPU drops the context meanwhile. */
  attach(host: HTMLElement, onLost: () => void): void {
    this.onLost = onLost;
    host.append(this.canvas);
    try {
      this.resize.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      this.resize.observe(this.canvas);
    }
    document.addEventListener('visibilitychange', this.visibility);
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
  }

  /** Takes the canvas out again and stops drawing; the next attach starts cold. */
  detach(): void {
    this.stop();
    this.resize.disconnect();
    document.removeEventListener('visibilitychange', this.visibility);
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    this.canvas.remove();
    this.onLost = () => {};
  }

  setLit(lit: boolean): void {
    if (lit === this.lit) return;
    this.lit = lit;
    if (lit) {
      const now = this.now();
      // A fresh pattern after a pause; quick toggles keep the one in flight.
      if (now - this.lastActive > BURST_LIFE) this.seed = Math.random() * 100;
      this.litAt = now;
      this.fire(now);
    }
    this.run();
  }

  /** Detaches and frees the program and the context, rather than leaving the context for garbage collection. */
  dispose(): void {
    this.detach();
    this.gl.deleteProgram(this.program);
    loseContext(this.gl);
  }

  private now(): number {
    return (performance.now() - this.epoch) / 1000;
  }

  private readonly visibility = () => {
    if (!document.hidden) return this.run();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  };

  /** Nothing drawn on a lost context shows: frames stop, and the host falls back to the plain fill. */
  private readonly contextLost = () => {
    this.stop();
    this.onLost();
  };

  /** No more frames, unlit and cold. */
  private stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.lit = false;
    this.level = 0;
    this.bursts = [];
  }

  private run(): void {
    if (this.frame || document.hidden || !this.canvas.isConnected || this.lost) return;
    this.last = this.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = () => {
    this.frame = 0;
    const now = this.now();
    const dt = Math.min(now - this.last, 0.1);
    this.last = now;
    this.level = Math.min(1, Math.max(0, this.level + (this.lit ? dt / RISE : -dt / FALL)));
    if (this.lit && now >= this.nextBurst) this.fire(now);
    this.bursts = this.bursts.filter((b) => now - b.start < BURST_LIFE);
    this.readPalette();
    this.draw(now);
    // Once the envelope has fallen to zero nothing shows, so frames stop until it is lit again.
    if (this.lit || this.level > 0) {
      this.lastActive = now;
      this.run();
    }
  };

  /** A burst near the thumb, stronger the longer the value has been held there, and when the next one comes. */
  private fire(now: number): void {
    const columns = Math.max(1, Math.floor(this.canvas.clientWidth / 4));
    const rows = Math.max(1, Math.floor(this.canvas.clientHeight / 4));
    const position = 1 - Math.random() * 0.04;
    const held = Math.min((now - this.litAt) / 1.6, 1);
    const jitter = now === this.litAt ? 1 : 0.85 + Math.random() * 0.3;
    const strength = Math.min((0.15 + 0.7 * position) * (0.45 + 0.55 * held) * jitter, 1);
    const burst = { column: Math.min(columns - 1, Math.floor(position * columns)), row: Math.floor((0.35 + Math.random() * 0.3) * rows), start: now, strength };
    this.bursts = [...this.bursts.slice(1 - MAX_BURSTS), burst];
    this.nextBurst = now + 0.3 + Math.random() * 0.45;
  }

  /** The theme's colors, read every frame so a theme switch shows at once. */
  private readPalette(): void {
    const style = getComputedStyle(this.canvas);
    const dark = style.colorScheme === 'dark';
    if (dark !== this.palette?.dark) {
      // The field builds toward the thumb; in the dark it adds light instead of covering.
      this.canvas.style.maskImage = `linear-gradient(to right, transparent 0%, black ${dark ? 60 : 45}%)`;
      this.canvas.style.mixBlendMode = dark ? 'plus-lighter' : '';
      this.canvas.style.opacity = dark ? '0.65' : '';
    }
    const names = ['ultracode-charged-start', 'ultracode-charged-end', 'ultracode-ink-cool', 'ultracode-ink-hot'];
    this.palette = { colors: names.map((n) => rgb(style.getPropertyValue(`--at-color-${n}`))), dark };
  }

  private draw(now: number): void {
    const { gl, canvas, palette } = this;
    if (!palette) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    const width = Math.max(canvas.clientWidth, 1);
    gl.uniform2f(this.uniform('uSize'), width, Math.max(canvas.clientHeight, 1));
    gl.uniform1f(this.uniform('uScale'), canvas.width / width);
    gl.uniform1f(this.uniform('uTime'), now);
    gl.uniform1f(this.uniform('uEnvelope'), this.level * this.level * (3 - 2 * this.level));
    gl.uniform1f(this.uniform('uSeed'), this.seed);
    const bursts = new Float32Array(MAX_BURSTS * 4);
    this.bursts.forEach((b, i) => bursts.set([b.column, b.row, b.start, b.strength], i * 4));
    gl.uniform4fv(this.uniform('uBursts'), bursts);
    const [start, end, cool, hot] = palette.colors as [RGB, RGB, RGB, RGB];
    gl.uniform3fv(this.uniform('uChargeStart'), start);
    gl.uniform3fv(this.uniform('uChargeEnd'), end);
    gl.uniform3fv(this.uniform('uInkCool'), cool);
    gl.uniform3fv(this.uniform('uInkHot'), hot);
    gl.uniform4fv(this.uniform('uInk'), palette.dark ? [0, 0.08, 0.85, 1] : [1, 0.28, 1, 1.18]);
    gl.uniform3fv(this.uniform('uCharge'), palette.dark ? [0.85, 1.1, 0] : [0.92, 0.5, 1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** Browsers free a context with this extension at once; otherwise it lingers until garbage collection. */
function loseContext(gl: WebGL2RenderingContext): void {
  gl.getExtension('WEBGL_lose_context')?.loseContext();
}

/**
 * Where an effort control keeps its field between popover openings: made on first use, remade if the GPU lost it, and
 * tried again on the next opening when no context was to be had.
 */
export class FieldSlot {
  private field: Field | null = null;
  private unsupported = false;

  /** The field, or null where WebGL2 or the shaders don't work. */
  take(): Field | null {
    if (this.field?.lost) this.release();
    if (!this.field && !this.unsupported) {
      const made = Field.create();
      this.unsupported = made === 'unsupported';
      this.field = made instanceof Field ? made : null;
    }
    return this.field;
  }

  release(): void {
    this.field?.dispose();
    this.field = null;
  }
}

/** A field slot for the life of the calling component; its context is released when that unmounts. */
export function useFieldSlot(): FieldSlot {
  const [slot] = useState(() => new FieldSlot());
  useEffect(() => () => slot.release(), [slot]);
  return slot;
}

/** The effect across the slider's track, under the thumb; `lit` while the value sits on the Ultracode stop. Draws with `slot`'s field. */
export function UltracodeField({ lit, slot }: { lit: boolean; slot: FieldSlot }) {
  const reduced = useReducedMotion();
  const [field, setField] = useState<Field | null>(null);
  const [failed, setFailed] = useState(false);
  const host = useCallback(
    (node: HTMLSpanElement | null) => {
      if (!node) return;
      const taken = slot.take();
      if (!taken) {
        setFailed(true);
        return;
      }
      // A lost context draws nothing until the next opening takes a new one.
      taken.attach(node, () => setFailed(true));
      setField(taken);
      // Reduced motion or a closing popover: the canvas goes back to the slot and nothing draws until it returns.
      return () => {
        taken.detach();
        setField(null);
      };
    },
    [slot],
  );
  useEffect(() => field?.setLit(lit), [field, lit]);

  if (reduced || failed) return null;
  return (
    <>
      {/* A solid tone in place of the translucent fill, once the field is drawing. */}
      <span
        aria-hidden
        data-ultracode-base=""
        className={cn(
          'absolute inset-0 bg-popover transition-opacity',
          lit && field ? 'opacity-100 duration-700 ease-out' : 'opacity-0 duration-[850ms] ease-linear',
        )}
      >
        <span className="absolute inset-0 bg-fill-control" />
      </span>
      <span ref={host} aria-hidden className="absolute inset-0" />
    </>
  );
}
