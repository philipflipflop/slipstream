/**
 * A single large animated water sheet that follows the camera,
 * snapped to its grid so the waves don't appear to slide.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from './heightfield';

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
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
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorld;

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
    #include <logdepthbuf_fragment>
    float dist = distance(uCamPos, vWorld);

    // waves flatten with distance: their world-space frequency would beat
    // against the pixel grid (moiré) long before they stop being visible
    float waveAmt = smoothstep(5200.0, 600.0, dist);
    vec3 n = waveNormal(vWorld.xz, uTime);
    n = normalize(mix(vec3(0.0, 1.0, 0.0), n, waveAmt));

    vec3 viewDir = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 base = mix(uDeep, uShallow, fres * 0.7 + 0.12);

    // sun glint (sparkle also calms with distance)
    vec3 hv = normalize(viewDir + uSunDir);
    float spec = pow(max(dot(n, hv), 0.0), 220.0) * 1.6;
    float sparkle = pow(max(dot(n, hv), 0.0), 36.0) * 0.25 * waveAmt;
    vec3 col = base + (spec + sparkle) * vec3(1.0, 0.92, 0.75);

    // LINEAR falloff matching THREE.Fog exactly — terrain and water must
    // fade identically or the boundary between them reads as a "map edge"
    float fog = clamp((dist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    col = mix(col, uFogColor, fog);
    gl_FragColor = vec4(col, mix(0.93, 1.0, fog));
  }
`;

export class Water {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, fogColor: THREE.Color, sunDir: THREE.Vector3, coarseDepth = false) {
    // big enough to underlie the entire far terrain shell (~63 km)
    const geo = new THREE.PlaneGeometry(66000, 66000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // without the logarithmic depth buffer (mobile) far shorelines land
      // within depth-buffer noise of the sheet and flicker; bias the depth
      // test a few units toward the water so it wins those contests cleanly
      polygonOffset: coarseDepth,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -3,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDir.clone() },
        uCamPos: { value: new THREE.Vector3() },
        uShallow: { value: new THREE.Color(0x2e8c9e) },
        uDeep: { value: new THREE.Color(0x0a3550) },
        uFogColor: { value: fogColor.clone() },
        uFogNear: { value: 2000 },
        uFogFar: { value: 7000 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    // sit just proud of the z-fight band (higher where depth is coarse)
    this.mesh.position.y = WATER_LEVEL + (coarseDepth ? 0.55 : 0.18);
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setFogRange(near: number, far: number): void {
    this.mat.uniforms.uFogNear.value = near;
    this.mat.uniforms.uFogFar.value = far;
  }

  update(time: number, camPos: THREE.Vector3): void {
    // follow the camera snapped to a coarse grid (geometry is uniform, no swim)
    this.mesh.position.x = Math.round(camPos.x / 500) * 500;
    this.mesh.position.z = Math.round(camPos.z / 500) * 500;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uCamPos.value.copy(camPos);
  }
}
