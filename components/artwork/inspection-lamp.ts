import { instrumentGeometry } from './instrument-geometry';

const vertex = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

// The SVG and the lamp share a world plane, projection and inspection-paper bounds.
// The lamp tints only that physical paper. It never draws an application result.
const fragment = `
precision mediump float;
uniform vec2 uCanvas;
uniform vec2 uOrigin;
uniform vec4 uCamera;
uniform float uScale;
uniform float uTravel;
uniform float uIntensity;
const vec2 VIEW = vec2(680.0, 420.0);

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 vb = vec2(gl_FragCoord.x / uCanvas.x, 1.0 - gl_FragCoord.y / uCanvas.y) * VIEW;
  vec2 screen = (vb - uOrigin) / uScale;
  float along = (screen.y + 23.4 * uCamera.w) / uCamera.z;
  vec2 world = vec2(uCamera.x * screen.x + uCamera.y * along,
                    -uCamera.y * screen.x + uCamera.x * along);
  vec2 centre = vec2(-18.0 + uTravel, 1.0);
  float pixel = (VIEW.x / uCanvas.x) / uScale / uCamera.z;
  vec2 q = abs(world - centre) - vec2(22.7, 17.7) + 2.0;
  float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 2.0;
  float paper = 1.0 - smoothstep(-0.6 * pixel, 0.3 * pixel, distance);
  vec2 fromLamp = (world - vec2(-18.0, -1.0)) / vec2(23.0, 18.0);
  float energy = exp(-dot(fromLamp, fromLamp) * 0.7) * paper;
  float alpha = (1.0 - exp(-energy * 1.8)) * uIntensity * 0.42;
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0 * smoothstep(0.0, 1.5 / 255.0, alpha);
  alpha = max(0.0, alpha + dither);
  gl_FragColor = vec4(vec3(0.879, 0.678, 0.765) * alpha, alpha);
}
`;

export interface InspectionLamp {
  draw(travel: number, intensity: number): void;
  dispose(): void;
}

export function createInspectionLamp(canvas: HTMLCanvasElement): InspectionLamp | null {
  let gl: WebGLRenderingContext | null;
  try {
    gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false,
      stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
  } catch {
    return null;
  }
  if (!gl) return null;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
    buffer = null;
    program = null;
  };
  const compile = (kind: number, source: string) => {
    const shader = gl.createShader(kind);
    if (!shader) throw new Error('The illustration shader is unavailable.');
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('The illustration shader could not compile.');
    return shader;
  };
  try {
    program = gl.createProgram();
    if (!program) throw new Error('The illustration program is unavailable.');
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('The illustration program could not link.');
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error('The illustration buffer is unavailable.');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const size = gl.getUniformLocation(program, 'uCanvas');
    const travelLocation = gl.getUniformLocation(program, 'uTravel');
    const intensityLocation = gl.getUniformLocation(program, 'uIntensity');
    const D = instrumentGeometry.dimensions;
    gl.uniform2f(gl.getUniformLocation(program, 'uOrigin'), D.origin[0], D.origin[1]);
    gl.uniform4f(gl.getUniformLocation(program, 'uCamera'), D.sinA, D.cosA, D.sinE, D.cosE);
    gl.uniform1f(gl.getUniformLocation(program, 'uScale'), D.scale);
    gl.clearColor(0, 0, 0, 0);
    return {
      draw(travel, intensity) {
        if (!program || gl.isContextLost()) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(program);
        gl.uniform2f(size, canvas.width, canvas.height);
        gl.uniform1f(travelLocation, travel);
        gl.uniform1f(intensityLocation, intensity);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose,
    };
  } catch {
    dispose();
    return null;
  }
}
