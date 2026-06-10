/**
 * A single large animated water sheet that follows the camera,
 * snapped to its grid so the waves don't appear to slide.
 */
import * as THREE from 'three';
import { WATER_LEVEL } from './heightfield';

const VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uCamPos;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vWorld;

  // cheap layered wave normal
  vec3 waveNormal(vec2 p, float t) {
    float a = sin(p.x * 0.045 + t * 0.9) + sin(p.y * 0.032 + t * 0.7);
    float b = sin((p.x + p.y) * 0.085 + t * 1.7) * 0.6;
    float c = sin((p.x - p.y * 1.3) * 0.21 + t * 2.3) * 0.25;
    float dx = cos(p.x * 0.045 + t * 0.9) * 0.045 + cos((p.x + p.y) * 0.085 + t * 1.7) * 0.051
             + cos((p.x - p.y * 1.3) * 0.21 + t * 2.3) * 0.052;
    float dy = cos(p.y * 0.032 + t * 0.7) * 0.032 + cos((p.x + p.y) * 0.085 + t * 1.7) * 0.051
             - cos((p.x - p.y * 1.3) * 0.21 + t * 2.3) * 0.068;
    return normalize(vec3(-dx * 6.0, 1.0, -dy * 6.0) + vec3(a, 0.0, b + c) * 0.001);
  }

  void main() {
    vec3 n = waveNormal(vWorld.xz, uTime);
    vec3 viewDir = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 3.0);
    vec3 base = mix(uDeep, uShallow, fres * 0.7 + 0.12);

    // sun glint
    vec3 hv = normalize(viewDir + uSunDir);
    float spec = pow(max(dot(n, hv), 0.0), 220.0) * 1.6;
    float sparkle = pow(max(dot(n, hv), 0.0), 36.0) * 0.25;
    vec3 col = base + (spec + sparkle) * vec3(1.0, 0.92, 0.75);

    float dist = distance(uCamPos, vWorld);
    float fog = smoothstep(uFogNear, uFogFar, dist);
    col = mix(col, uFogColor, fog);
    gl_FragColor = vec4(col, 0.93);
  }
`;

export class Water {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, fogColor: THREE.Color, sunDir: THREE.Vector3) {
    const geo = new THREE.PlaneGeometry(24000, 24000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
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
    this.mesh.position.y = WATER_LEVEL;
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
