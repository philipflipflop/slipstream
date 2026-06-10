/**
 * Atmosphere: gradient sky dome with sun disc, hemisphere + directional
 * lighting (shadow frustum follows the player), and a wrapping layer of
 * billboard cumulus clouds built from a generated canvas texture.
 */
import * as THREE from 'three';

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
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(max(h, 0.0), 0.62));
    col = mix(uGroundGlow, col, smoothstep(-0.18, 0.06, h));

    float sunAmt = max(dot(d, uSunDir), 0.0);
    // warm haze around the sun
    col += vec3(1.0, 0.55, 0.22) * pow(sunAmt, 14.0) * 0.42;
    // the disc itself
    col += vec3(1.0, 0.88, 0.66) * smoothstep(0.9994, 0.9999, sunAmt) * 6.0;
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
  readonly sunDir = new THREE.Vector3(0.42, 0.46, -0.55).normalize();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fogColor = new THREE.Color(0xc6d3e0);
  private dome: THREE.Mesh;
  private clouds: THREE.Sprite[] = [];
  private cloudSpan = 9000;

  constructor(scene: THREE.Scene, cloudCount: number) {
    const geo = new THREE.SphereGeometry(1, 32, 18);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: this.sunDir.clone() },
        uZenith: { value: new THREE.Color(0x2c63b8) },
        // horizon band IS the fog colour — fogged geometry then melts
        // seamlessly into the sky instead of silhouetting a "map edge"
        uHorizon: { value: this.fogColor.clone() },
        uGroundGlow: { value: this.fogColor.clone().multiplyScalar(0.82) },
      },
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    this.dome.scale.setScalar(30000);
    scene.add(this.dome);

    this.hemi = new THREE.HemisphereLight(0xbcd3f5, 0x57604c, 0.75);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
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
        transparent: true,
        opacity: 0.5 + Math.random() * 0.32,
        depthWrite: false,
        fog: false,
      });
      const sp = new THREE.Sprite(mat2);
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

  update(center: THREE.Vector3): void {
    this.dome.position.copy(center);

    // shadow frustum chases the player
    this.sun.position.copy(center).addScaledVector(this.sunDir, 1800);
    this.sun.target.position.copy(center);

    // wrap clouds around the player so the layer never ends
    const span = this.cloudSpan;
    for (const c of this.clouds) {
      let dx = c.position.x - center.x;
      let dz = c.position.z - center.z;
      if (dx > span) c.position.x -= span * 2;
      else if (dx < -span) c.position.x += span * 2;
      if (dz > span) c.position.z -= span * 2;
      else if (dz < -span) c.position.z += span * 2;
    }
  }
}
