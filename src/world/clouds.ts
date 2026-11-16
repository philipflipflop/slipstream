/**
 * The weather you can see: the cloud deck (weather.ts) drawn as its two
 * faces, and rain.
 *
 * DECK. The layer's underside and its top are two horizontal sheets, each
 * computed analytically per pixel exactly like the water sheet (view ray ∩
 * plane, depth written from that — nothing interpolated across kilometres
 * of triangle). A sheet seen from above is sunlit cloud, from below it is
 * the grey underside — whichever sheet it is: in a gap INSIDE a broken
 * layer there is cloud above and cloud below. Inside the cloud itself
 * main.ts closes the visibility down instead. Coverage comes from the same byte field the sim samples
 * (weather.makeCoverField), so a gap you can see is a gap you can fly
 * through. The sheets haze into the horizon with the scene's own fog law.
 *
 * RAIN. A box of streaks that travels with the camera; each streak is a
 * world-space drop wrapped into the box, drawn as a line along its motion
 * RELATIVE to the camera — so parked they fall, and at 140 kt they come at
 * the windscreen.
 */
import * as THREE from 'three';
import {
  WeatherPreset, makeCoverField, coverAt, layerDensity, FIELD_N, FIELD_TILE, COVER_EDGE,
} from './weather';

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uField;
  uniform vec2 uDrift;
  uniform float uCover;
  uniform float uY;
  uniform vec3 uLit;       // cloud in sunlight
  uniform vec3 uShade;     // cloud from beneath
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uCamPos;
  uniform vec2 uRes;
  uniform vec4 uProj;
  uniform mat3 uCamRot;

  void main() {
    float dh = uCamPos.y - uY;
    vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
    vec3 ray = uCamRot * vec3((ndc + uProj.zw) * uProj.xy, -1.0);
    if (abs(ray.y) < 1e-6) discard;
    float s = dh / (-ray.y);
    if (s <= 0.0) discard;                   // this sheet is behind the eye
    vec3 rel = ray * s;
    float dist = length(rel);

    vec2 uv = (uCamPos.xz + rel.xz + uDrift) / ${FIELD_TILE.toFixed(1)};
    float n = texture2D(uField, uv).r;
    float fine = texture2D(uField, uv * 6.7 + 0.37).r;
    float cov = 1.0;
    if (uCover < 0.99) {
      float th = 1.0 - uCover;
      cov = smoothstep(th - ${COVER_EDGE.toFixed(3)}, th + ${COVER_EDGE.toFixed(3)}, n);
      if (cov < 0.012) discard;
    }
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      gl_FragDepth = log2(1.0 + s) * logDepthBufFC * 0.5;
    #endif

    // billows: the top is brightest on its domes, the underside darkest
    // where the layer is thickest
    vec3 col = dh > 0.0
      ? uLit * (0.86 + 0.14 * fine) * (0.9 + 0.1 * n)
      : uShade * (1.06 - 0.26 * n) * (0.92 + 0.12 * fine);
    float fog = smoothstep(uFogNear, uFogFar, dist);
    col = mix(col, uFogColor, fog);
    gl_FragColor = vec4(col, cov);
  }
`;

export class CloudDeckView {
  /** the coverage field the picture is drawn from */
  readonly field: Uint8Array;
  private mats: THREE.ShaderMaterial[] = [];
  private drift = new THREE.Vector2();
  private meshes: THREE.Mesh[] = [];
  /** colour of the cloud itself (what you are inside of), raw shader space */
  readonly lit: THREE.Color;
  readonly shade: THREE.Color;

  constructor(
    scene: THREE.Scene, private wx: WeatherPreset, fogColor: THREE.Color,
    lit: THREE.Color, shade: THREE.Color,
  ) {
    this.field = makeCoverField();
    this.lit = lit;
    this.shade = shade;
    const deck = wx.deck;
    if (!deck) return;
    const tex = new THREE.DataTexture(this.field, FIELD_N, FIELD_N, THREE.RedFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(520000, 520000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    for (const side of [-1, 1]) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: deck.cover < 0.99,
        depthWrite: true,
        side: THREE.DoubleSide,
        uniforms: {
          uField: { value: tex },
          uDrift: { value: this.drift },
          uCover: { value: deck.cover },
          uY: { value: side > 0 ? deck.top : deck.base },
          uLit: { value: lit },
          uShade: { value: shade },
          uFogColor: { value: fogColor },
          uFogNear: { value: 2000 },
          uFogFar: { value: 7000 },
          uCamPos: { value: new THREE.Vector3() },
          uRes: { value: new THREE.Vector2(1, 1) },
          uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
          uCamRot: { value: new THREE.Matrix3() },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = side > 0 ? deck.top : deck.base;
      mesh.frustumCulled = false;
      // after the water sheet (1), before the cumulus sprites (5): it
      // writes depth, so puffs and contrails beyond it are hidden by it
      mesh.renderOrder = 3;
      mesh.onBeforeRender = (renderer, _scene, camera) => {
        const u = mat.uniforms;
        renderer.getDrawingBufferSize(u.uRes.value);
        const p = camera.projectionMatrix.elements;
        u.uProj.value.set(1 / p[0], 1 / p[5], p[8], p[9]);
        u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
        u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      };
      scene.add(mesh);
      this.mats.push(mat);
      this.meshes.push(mesh);
    }
  }

  /** Cloud density at a point, 0..1 (layer profile × local coverage). */
  densityAt(x: number, y: number, z: number): number {
    const deck = this.wx.deck;
    if (!deck) return 0;
    const d = layerDensity(deck, y);
    if (d <= 0) return 0;
    return d * coverAt(this.field, x + this.drift.x, z + this.drift.y, deck.cover);
  }

  /** Follow the camera, carry the fog range, drift with the wind aloft. */
  update(camPos: THREE.Vector3, fogNear: number, fogFar: number, dt: number, windX: number, windZ: number): void {
    // the field moves with the wind: the lookup shifts the other way
    this.drift.x -= windX * dt;
    this.drift.y -= windZ * dt;
    for (let i = 0; i < this.meshes.length; i++) {
      this.meshes[i].position.x = Math.round(camPos.x / 500) * 500;
      this.meshes[i].position.z = Math.round(camPos.z / 500) * 500;
      this.mats[i].uniforms.uFogNear.value = fogNear;
      this.mats[i].uniforms.uFogFar.value = fogFar;
    }
  }
}

/* ------------------------------------------------------------------ rain ---- */

const RAIN_VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aSeed;
  attribute float aEnd;
  uniform vec3 uBox;
  uniform vec3 uOff;      // (drop travel − camera position) mod box, from the CPU in doubles
  uniform vec3 uStreak;   // streak vector, m
  uniform vec3 uCam;
  varying float vA;
  void main() {
    vec3 p = mod(aSeed * uBox + uOff, uBox) - uBox * 0.5;
    p += uStreak * aEnd;
    // drops near the faces of the box fade, so the box has no visible walls
    vec3 q = abs(p) / (uBox * 0.5);
    vA = (1.0 - smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)))) * (1.0 - aEnd * 0.6);
    vec4 mvPosition = viewMatrix * vec4(p + uCam, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const RAIN_FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vA;
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(uColor, vA * uAlpha);
  }
`;

export class Rain {
  private mat: THREE.ShaderMaterial;
  private lines: THREE.LineSegments;
  private travel = new THREE.Vector3();
  private box = new THREE.Vector3(64, 44, 64);

  constructor(scene: THREE.Scene, count: number, color: THREE.Color) {
    const seed = new Float32Array(count * 6);
    const end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = Math.random(), y = Math.random(), z = Math.random();
      seed.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uBox: { value: this.box },
        uOff: { value: new THREE.Vector3() },
        uStreak: { value: new THREE.Vector3(0, 0.4, 0) },
        uCam: { value: new THREE.Vector3() },
        uColor: { value: color },
        uAlpha: { value: 0 },
      },
    });
    this.lines = new THREE.LineSegments(geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 8;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  /**
   * `amount` 0..1 (0 hides it); `camVel` the camera's velocity, m/s; the
   * wind carries the drops.
   */
  update(cam: THREE.Vector3, camVel: THREE.Vector3, amount: number, dt: number, windX: number, windZ: number): void {
    this.lines.visible = amount > 0.01;
    if (!this.lines.visible) return;
    const u = this.mat.uniforms;
    const b = this.box;
    // drops fall at ~9 m/s and ride the wind
    this.travel.x = (this.travel.x + windX * dt) % b.x;
    this.travel.y = (this.travel.y - 9 * dt) % b.y;
    this.travel.z = (this.travel.z + windZ * dt) % b.z;
    const wrap = (v: number, m: number): number => ((v % m) + m) % m;
    u.uOff.value.set(wrap(this.travel.x - cam.x, b.x), wrap(this.travel.y - cam.y, b.y), wrap(this.travel.z - cam.z, b.z));
    u.uCam.value.copy(cam);
    // the streak lies along the drop's motion relative to the eye, one
    // 30th of a second long (capped: at jet speeds it is a blur, not a spear)
    const rx = windX - camVel.x;
    const ry = -9 - camVel.y;
    const rz = windZ - camVel.z;
    const sp = Math.hypot(rx, ry, rz);
    const len = Math.min(sp / 30, 7) / Math.max(sp, 0.001);
    u.uStreak.value.set(-rx * len, -ry * len, -rz * len);
    u.uAlpha.value = 0.34 * amount;
  }
}
