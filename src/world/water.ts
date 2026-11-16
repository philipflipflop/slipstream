/**
 * A single large animated water sheet that follows the camera.
 *
 * The sheet's two triangles only say WHICH pixels are sea. Where each pixel
 * is — its world position and its depth — is computed in the fragment
 * shader by intersecting that pixel's view ray with the water plane, never
 * interpolated from the vertices: across triangles hundreds of kilometres
 * wide (one corner always behind the camera) the rasteriser's interpolation
 * is metres out, and the error changes with every turn of the camera and
 * every step of the sheet.
 *
 * THE SHORELINE IS NOT DECIDED BY THE DEPTH BUFFER, on any device. A coast
 * is where two nearly parallel surfaces cross, and no depth test settles
 * that at range: even with exact water depth and a 24-bit logarithmic
 * buffer the comparison is only good to a few parts per million of range
 * (GPU log2 + interpolation), which from 20,000 ft is ±3–4 cm of height —
 * and with a hundred kilometres of coast in view, hundreds of shoreline
 * pixels sit inside that band and flip on every sub-pixel camera movement
 * ("edge flicker", and dashes along the shell's facets). Instead every
 * terrain shader DISCARDS below the waterline (TerrainManager `clipY`),
 * which is exact per fragment at any range, and the sheet is opaque and
 * merely fills what is left:
 *  · log depth (desktop, phones above Low): drawn after the opaque scene,
 *    depth-tested so hulls and gear still sink into it, but pushed BACK by
 *    2 parts in 10,000 of range so it can never win a pixel from land that
 *    is above the waterline (0.2 mm at the aircraft, ~1 m from cruise).
 *  · coarse depth (touch + Low): drawn FIRST, untested — a plain 24-bit
 *    buffer cannot even do the above. Never bias the sheet TOWARD the eye
 *    (the old polygon offset): its slope term is kilometres per pixel at
 *    altitude and it drowned every coast under ~50–100 m.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from './heightfield';
import type { DaylightPreset } from './daylight';

/** world height of the water sheet (a hair proud of the nominal level) */
export const WATER_SURFACE_Y = WATER_LEVEL + 0.18;

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
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uGlint;
  uniform float uGlintNear;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uWaterY;
  uniform vec2 uRes;      // drawing buffer size, px
  uniform vec4 uProj;     // 1/P00, 1/P11, P02, P12 of the projection matrix
  uniform mat3 uCamRot;   // camera → world rotation

  // three directional swells at non-orthogonal angles and incommensurate
  // frequencies — interference stays organic instead of forming a dot grid
  vec3 waveNormal(vec2 p, float t) {
    vec2 d1 = vec2( 0.8660, 0.5000);
    vec2 d2 = vec2(-0.3420, 0.9397);
    vec2 d3 = vec2( 0.6225, -0.7826);
    float w1 = dot(p, d1) * 0.041 + t * 0.85;
    float w2 = dot(p, d2) * 0.073 + t * 1.31;
    float w3 = dot(p, d3) * 0.157 + t * 2.10;
    vec2 g = d1 * (cos(w1) * 0.058)
           + d2 * (cos(w2) * 0.052)
           + d3 * (cos(w3) * 0.038);
    return normalize(vec3(-g.x * 5.0, 1.0, -g.y * 5.0));
  }

  void main() {
    // this pixel's view ray, scaled so its view-space depth is exactly 1:
    // s below is then the fragment's view depth (clip-space w)
    vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
    vec3 ray = uCamRot * vec3((ndc + uProj.zw) * uProj.xy, -1.0);
    float s = (uCamPos.y - uWaterY) / max(-ray.y, 1e-7);
    if (s <= 0.0) discard;   // eye under the sheet
    vec3 rel = ray * s;
    vec3 vWorld = vec3(uCamPos.x + rel.x, uWaterY, uCamPos.z + rel.z);
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      // pushed back (see the header): land above the waterline always wins
      gl_FragDepth = log2(1.0 + s * 1.0002) * logDepthBufFC * 0.5;
    #endif
    float dist = length(rel);

    // waves flatten with distance: their world-space frequency would beat
    // against the pixel grid (moiré) long before they stop being visible
    float waveAmt = smoothstep(5200.0, 600.0, dist);
    vec3 n = waveNormal(vWorld.xz, uTime);
    n = normalize(mix(vec3(0.0, 1.0, 0.0), n, waveAmt));

    vec3 viewDir = -normalize(ray);
    float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 base = mix(uDeep, uShallow, fres * 0.7 + 0.12);

    // sun/moon glint (sparkle also calms with distance). uGlintNear damps
    // the NEAR-field wave-crest glitter: over a bright daytime sea it reads
    // as sparkle, over a near-black night sea the same term reads as a
    // glowing dot grid — night presets fade it and keep the distant path
    vec3 hv = normalize(viewDir + uSunDir);
    float spec = pow(max(dot(n, hv), 0.0), 220.0) * 1.6 * mix(1.0, uGlintNear, waveAmt);
    float sparkle = pow(max(dot(n, hv), 0.0), 36.0) * 0.25 * waveAmt * uGlintNear;
    vec3 col = base + (spec + sparkle) * uGlint;

    // the SAME falloff as the scene fog (sky.ts: smoothstep on the radial
    // distance) — terrain and water must fade identically or the boundary
    // between them reads as a "map edge"
    float fog = smoothstep(uFogNear, uFogFar, dist);
    col = mix(col, uFogColor, fog);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Water {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(
    scene: THREE.Scene, fogColor: THREE.Color, sunDir: THREE.Vector3,
    coarseDepth = false, preset?: DaylightPreset,
  ) {
    // big enough to underlie the entire horizon shell (180 km radius plus
    // its re-centre drift)
    const geo = new THREE.PlaneGeometry(420000, 420000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      // opaque on every path: nothing is drawn beneath it (see the header)
      transparent: false,
      depthWrite: false,
      depthTest: !coarseDepth,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDir.clone() },
        uCamPos: { value: new THREE.Vector3() },
        uShallow: { value: new THREE.Color(preset?.waterShallow ?? 0x2e8c9e) },
        uDeep: { value: new THREE.Color(preset?.waterDeep ?? 0x0a3550) },
        uGlint: { value: new THREE.Vector3(...(preset?.glint ?? [1.0, 0.92, 0.75])) },
        uGlintNear: { value: preset?.glintNear ?? 1 },
        uFogColor: { value: fogColor.clone() },
        uFogNear: { value: 2000 },
        uFogFar: { value: 7000 },
        uWaterY: { value: WATER_SURFACE_Y },
        uRes: { value: new THREE.Vector2(1, 1) },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uCamRot: { value: new THREE.Matrix3() },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.position.y = WATER_SURFACE_Y;
    // the ray set-up is taken from the camera the frame is actually drawn
    // with, at draw time — after the chase camera and its shake have moved
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      const u = this.mat.uniforms;
      renderer.getDrawingBufferSize(u.uRes.value);
      const p = camera.projectionMatrix.elements;
      u.uProj.value.set(1 / p[0], 1 / p[5], p[8], p[9]);
      u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    };
    // coarse path: after the sky dome (−10), before everything else;
    // otherwise after the opaque scene and before anything transparent
    this.mesh.renderOrder = coarseDepth ? -5 : 1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** The haze colour changes with the weather around the eye (sky.setAir). */
  setFogColor(c: THREE.Color): void {
    (this.mat.uniforms.uFogColor.value as THREE.Color).copy(c);
  }

  setFogRange(near: number, far: number): void {
    this.mat.uniforms.uFogNear.value = near;
    this.mat.uniforms.uFogFar.value = far;
  }

  update(time: number, camPos: THREE.Vector3): void {
    // follow the camera; the sheet only supplies coverage (see the header),
    // so where exactly it sits makes no difference to any pixel
    this.mesh.position.x = Math.round(camPos.x / 500) * 500;
    this.mesh.position.z = Math.round(camPos.z / 500) * 500;
    this.mat.uniforms.uTime.value = time;
  }
}
