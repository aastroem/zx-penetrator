// WebGL2 renderer: decodes the raw Spectrum display file (6912 bytes) on the
// GPU via two R8UI textures (bitmap + attributes) and a fragment shader that
// does the bit/attr lookup and border compositing per-pixel.

import { linearize } from './interleave';

export class Screen {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private readonly program: WebGLProgram;
  private readonly bitmapTex: WebGLTexture;
  private readonly attrsTex: WebGLTexture;
  private readonly uFrame: WebGLUniformLocation | null;
  private readonly uCrt: WebGLUniformLocation | null;
  private readonly uBorderColor: WebGLUniformLocation | null;
  private readonly bitmapBuf = new Uint8Array(32 * 192);
  private crtOn = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    this.program = createProgram(gl, VERTEX_GLSL, FRAGMENT_GLSL);
    gl.useProgram(this.program);

    this.bitmapTex = createIntTexture(gl, 32, 192);
    this.attrsTex = createIntTexture(gl, 32, 24);

    gl.uniform1i(gl.getUniformLocation(this.program, 'uBitmap'), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uAttrs'), 1);
    this.uFrame = gl.getUniformLocation(this.program, 'uFrame');
    this.uCrt = gl.getUniformLocation(this.program, 'uCrt');
    this.uBorderColor = gl.getUniformLocation(this.program, 'uBorderColor');

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  setCrt(on: boolean): void {
    this.crtOn = on;
  }

  resize(): void {
    const k = Math.max(
      1,
      Math.floor(Math.min(window.innerWidth / 352, window.innerHeight / 288)),
    );
    const w = 352 * k;
    const h = 288 * k;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.gl.viewport(0, 0, w, h);
  }

  draw(display: Uint8Array, border: number, frame: number): void {
    const gl = this.gl;
    linearize(display, this.bitmapBuf);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bitmapTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, 32, 192,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, this.bitmapBuf,
    );

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.attrsTex);
    const attrs = display.subarray(6144, 6144 + 768);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, 32, 24,
      gl.RED_INTEGER, gl.UNSIGNED_BYTE, attrs,
    );

    gl.useProgram(this.program);
    gl.uniform1i(this.uFrame, frame | 0);
    gl.uniform1i(this.uCrt, this.crtOn ? 1 : 0);
    gl.uniform1i(this.uBorderColor, border & 7);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function createIntTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.R8UI, w, h, 0,
    gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(w * h),
  );
  return tex;
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  if (!prog) throw new Error('createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link failed: ${log}`);
  }
  return prog;
}

const VERTEX_GLSL = `#version 300 es
out vec2 vUv;
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(pos.x, 1.0 - pos.y);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_GLSL = `#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D uBitmap;   // 32x192, R8UI, y already linearized
uniform usampler2D uAttrs;    // 32x24,  R8UI
uniform int uFrame; uniform int uCrt; uniform int uBorderColor;
in vec2 vUv; out vec4 fragColor;
const vec2 SCREEN = vec2(256.0, 192.0);
const vec2 BORDER = vec2(48.0, 48.0);
vec3 zxColor(uint c, uint bright) {
  float v = bright == 1u ? 1.0 : 0.843;
  return vec3(float((c >> 1u) & 1u), float((c >> 2u) & 1u), float(c & 1u)) * v;
}
void main() {
  vec2 total = SCREEN + BORDER * 2.0;
  vec2 p = vUv * total - BORDER;
  vec3 rgb;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, SCREEN))) {
    rgb = zxColor(uint(uBorderColor), 0u);
  } else {
    ivec2 ip = ivec2(p);
    uint byteVal = texelFetch(uBitmap, ivec2(ip.x >> 3, ip.y), 0).r;
    uint attr    = texelFetch(uAttrs,  ivec2(ip.x >> 3, ip.y >> 3), 0).r;
    uint bit = (byteVal >> uint(7 - (ip.x & 7))) & 1u;
    uint flash = (attr >> 7u) & 1u;
    if (flash == 1u && ((uFrame >> 4) & 1) == 1) bit ^= 1u;
    uint bright = (attr >> 6u) & 1u;
    rgb = bit == 1u ? zxColor(attr & 7u, bright)
                    : zxColor((attr >> 3u) & 7u, bright);
  }
  if (uCrt == 1) {
    float scan = 0.82 + 0.18 * sin(p.y * 6.28318);
    rgb *= scan;
    rgb += rgb * 0.15 * (1.0 - abs(vUv.y - 0.5) * 2.0);  // mild phosphor
  }
  fragColor = vec4(rgb, 1.0);
}
`;
