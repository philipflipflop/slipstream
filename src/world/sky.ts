/**
 * Atmosphere: gradient sky dome with sun/moon disc and a procedural star
 * field, hemisphere + directional lighting (shadow frustum follows the
 * player), and a wrapping layer of billboard cumulus clouds built from a
 * generated canvas texture. All colours come from the daylight preset.
 */
import * as THREE from 'three';
import { clamp, damp } from '../core/math';
import type { DaylightPreset } from './daylight';

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = pos.xyww; // pin to far plane
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGroundGlow;
  uniform vec3 uGlowColor;
  uniform float uGlowAmt;
  uniform vec3 uDiscColor;
  uniform float uDiscBoost;
  uniform float uStars;
  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.62));
    col = mix(uGroundGlow, col, smoothstep(-0.18, 0.06, h));

    // star field: hashed cells on the direction vector — each bright cell is
    // a couple of pixels, i.e. a star. Fades toward the horizon haze.
    if (uStars > 0.001) {
      float star = smoothstep(0.9982, 1.0, hash13(floor(d * 480.0)));
      float twinkleSeed = hash13(floor(d * 480.0) + 7.0);
      col += vec3(0.9, 0.95, 1.0) * star * (0.4 + 0.6 * twinkleSeed)
        * uStars * smoothstep(0.02, 0.24, h);
    }

    float sunAmt = max(dot(d, uSunDir), 0.0);
    // haze around the disc
    col += uGlowColor * pow(sunAmt, 14.0) * uGlowAmt;
    // the disc itself (sun by day, moon by night)
    col += uDiscColor * smoothstep(0.9994, 0.9999, sunAmt) * uDiscBoost;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeCloudTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);
  // overlapping soft blobs make a puff
  const blobs = 26;
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * Math.PI * 2 * 3.7;
    const r = 36 + Math.sin(i * 12.9898) * 22;
    const x = 128 + Math.cos(a) * (62 - Math.abs(Math.sin(i * 3.3)) * 30);
    const y = 138 + Math.sin(a) * 26 - Math.abs(Math.cos(i * 1.7)) * 22;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.65, 'rgba(245,248,255,0.28)');
    grad.addColorStop(1, 'rgba(240,245,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Sky {
  readonly sunDir: THREE.Vector3;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fogColor: THREE.Color;
  private dome: THREE.Mesh;
  private clouds: THREE.Sprite[] = [];
  private cloudBaseOpacity: number[] = [];
  private cloudSpan = 9000;

  constructor(scene: THREE.Scene, cloudCount: number, preset: DaylightPreset) {
    this.sunDir = new THREE.Vector3(...preset.sunDir).normalize();
    this.fogColor = new THREE.Color(preset.horizon);

    const geo = new THREE.SphereGeometry(1, 32, 18);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDir.clone() },
        uZenith: { value: new THREE.Color(preset.zenith) },
        // horizon band IS the fog colour — fogged geometry then melts
        // seamlessly into the sky instead of silhouetting a "map edge"
        uHorizon: { value: this.fogColor.clone() },
        uGroundGlow: { value: this.fogColor.clone().multiplyScalar(preset.groundGlow) },
        uGlowColor: { value: new THREE.Vector3(...preset.glowColor) },
        uGlowAmt: { value: preset.glowAmt },
        uDiscColor: { value: new THREE.Color(preset.discColor) },
        uDiscBoost: { value: preset.discBoost },
        uStars: { value: preset.stars },
      },
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.dome.scale.setScalar(30000);
    scene.add(this.dome);

    this.hemi = new THREE.HemisphereLight(preset.hemiSky, preset.hemiGround, preset.hemiIntensity);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(preset.sunColor, preset.sunIntensity);
    this.sun.position.copy(this.sunDir).multiplyScalar(1800);
    this.sun.castShadow = false;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 200;
    this.sun.shadow.camera.far = 4200;
    const s = 420;
    this.sun.shadow.camera.left = -s;
    this.sun.shadow.camera.right = s;
    this.sun.shadow.camera.top = s;
    this.sun.shadow.camera.bottom = -s;
    this.sun.shadow.bias = -0.0004;
    scene.add(this.sun);
    scene.add(this.sun.target);

    const tex = makeCloudTexture();
    for (let i = 0; i < cloudCount; i++) {
      const mat2 = new THREE.SpriteMaterial({
        map: tex,
        color: preset.cloudTint,
        transparent: true,
        opacity: (0.5 + Math.random() * 0.32) * preset.cloudOpacity,
        depthWrite: false,
        fog: false,
      });
      const sp = new THREE.Sprite(mat2);
      this.cloudBaseOpacity.push(mat2.opacity);
      const w = 700 + Math.random() * 1600;
      sp.scale.set(w, w * (0.3 + Math.random() * 0.18), 1);
      sp.position.set(
        (Math.random() - 0.5) * this.cloudSpan * 2,
        850 + Math.random() * 900,
        (Math.random() - 0.5) * this.cloudSpan * 2,
      );
      sp.renderOrder = 5;
      this.clouds.push(sp);
      scene.add(sp);
    }
  }

  setShadows(enabled: boolean): void {
    this.sun.castShadow = enabled;
  }

  update(center: THREE.Vector3, fogFar = 7000, dt = 0.016): void {
    this.dome.position.copy(center);

    // shadow frustum chases the player
    this.sun.position.copy(center).addScaledVector(this.sunDir, 1800);
    this.sun.target.position.copy(center);

    // the cloud layer breathes with the fog: at altitude you can see much
    // further, so spread the layer out (scaling positions with the span keeps
    // the motion smooth — it reads as drift, not teleporting)
    const prevSpan = this.cloudSpan;
    this.cloudSpan = clamp(damp(this.cloudSpan, fogFar * 0.92 + 800, 0.6, dt), 9000, 28000);
    const k = this.cloudSpan / prevSpan;
    const span = this.cloudSpan;
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      if (k !== 1) {
        c.position.x = center.x + (c.position.x - center.x) * k;
        c.position.z = center.z + (c.position.z - center.z) * k;
      }
      // wrap around the player so the layer never ends
      const dx = c.position.x - center.x;
      const dz = c.position.z - center.z;
      if (dx > span) c.position.x -= span * 2;
      else if (dx < -span) c.position.x += span * 2;
      if (dz > span) c.position.z -= span * 2;
      else if (dz < -span) c.position.z += span * 2;
      // fade out near the wrap boundary so a recycled puff never pops
      const dist = Math.hypot(c.position.x - center.x, c.position.z - center.z);
      const fade = 1 - clamp((dist / span - 0.78) / 0.2, 0, 1);
      (c.material as THREE.SpriteMaterial).opacity = this.cloudBaseOpacity[i] * fade;
    }
  }
}
