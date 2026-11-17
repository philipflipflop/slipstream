/**
 * The weather you can see: the cloud layer (weather.ts) and rain.
 *
 * LAYER. Not two sheets: a VOLUME, marched per pixel. weather.deckSurfaces
 * gives the top and the base of the cloud at any point — an undulating,
 * lumpy top with embedded cumulus standing out of it, a ragged base, lens-
 * shaped bodies in a broken layer — and the cloud thickens over `soft`
 * metres inside those surfaces. The fragment shader evaluates that SAME
 * formula from the SAME bytes (one RGB texture) along each view ray,
 * accumulating opacity, so tops have silhouettes and parallax, edges are
 * wisps, and where the picture shows a gap the sim (densityAt) has one.
 * Drawn as one full-screen triangle; depth is written analytically from the
 * distance where the cloud was met (nothing is interpolated across
 * geometry, as with the water sheet). Rules that keep it cheap and stable:
 *   · steps are as long as the clearance to the surfaces allows (the top is
 *     a heightfield of bounded slope) and grow with distance; a per-pixel
 *     jitter turns what banding is left into grain.
 *   · geometry relaxes onto the mean surfaces with distance (`uFlat`), so a
 *     ray that runs out of steps meets the same flat cloud it would have
 *     been handed; LIGHTING keeps the full relief (a far top is a bump map).
 *   · extinction is the sim's own in-cloud visibility near the eye — the
 *     aircraft in front of the camera must not vanish behind a wall — and
 *     tightens with distance so far cloud is solid in a step or two.
 *
 * RAIN. A box of streaks that travels with the camera; each streak is a
 * world-space drop wrapped into the box, drawn as a line along its motion
 * RELATIVE to the camera — so parked they fall, and at 140 kt they come at
 * the windscreen.
 */
import * as THREE from 'three';
import {
  WeatherPreset, CloudFields, makeCloudFields, deckDensity, deckLight, FIELD_N, FIELD_TILE, COVER_EDGE,
  DETAIL_SCALE, DETAIL_OFF, MEAN_TOP, MEAN_BASE, CLOUD_ABSORB,
} from './weather';

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const f1 = (v: number): string => v.toFixed(4);

const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D uField;  // R coverage, G lumps, B towers, A region
  uniform vec2 uDrift;
  uniform vec4 uDeck;        // base, top, cover, extinction per m
  uniform vec4 uShape;       // relief, towers, ragged, soft
  uniform vec2 uMean;        // mean top, mean base
  uniform vec3 uThick;       // thinnest the layer gets, 1 / its range, 1 / ragged
  uniform float uLumpy;
  uniform float uFlat;       // range at which the relief has relaxed, m
  uniform vec3 uLit;         // cloud in sunlight
  uniform vec3 uShade;       // cloud from beneath
  uniform vec3 uSunDir;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uCamPos;
  uniform vec2 uRes;
  uniform vec4 uProj;
  uniform mat3 uCamRot;
  uniform vec2 uDepthAB;     // projection [10], [14] — for the plain depth buffer

  const float INV_TILE = ${(1 / FIELD_TILE).toExponential(8)};
  const float TEXEL = ${f1(FIELD_TILE / FIELD_N)};
  const float EDGE = ${f1(COVER_EDGE)};

  // weather.deckSurfaces, per pixel. fl = how far the geometry has relaxed
  // onto the mean surfaces; ht = the top with its full relief (lighting).
  // py: the height being tested. One lookup bounds the layer; the detail
  // lookup is only made when py is close enough for it to matter — in
  // clear air the bound is returned (yt high, yb low: clearance is safe).
  void surf(in vec2 xz, in float lod, in float fl, in float py, out float yt, out float yb, out float ht, out float gap) {
    vec2 uv = (xz + uDrift) * INV_TILE;
    vec4 a = textureLod(uField, uv, lod);
    float amp = uShape.x * (0.4 + 0.6 * a.a);
    float tw = uShape.y * smoothstep(0.8, 0.97, a.b) * smoothstep(0.35, 0.65, a.a) * (0.7 + 0.3 * a.g);
    float e = 1.0;
    float mid = 0.5 * (uDeck.x + uDeck.y);
    gap = 0.0;
    if (uDeck.z < 0.99) {
      float th = 1.0 - uDeck.z;
      float cov = smoothstep(th - EDGE, th + EDGE, a.r);
      if (cov < 0.002) {
        yt = mid - 1.0;
        yb = mid + 1.0;
        ht = mid;
        gap = max(th - EDGE - a.r, 0.0) * 1100.0;
        return;
      }
      e = cov * (2.0 - cov);
    }
    // bounds: every small lump at its highest, the base at its lowest
    ht = uDeck.y - amp * (1.0 - mix(a.g, 1.0, uLumpy)) + tw;
    float hb = uDeck.x;
    yt = mid + (mix(ht, uMean.x, fl) - mid) * e;
    yb = mid - (mid - mix(hb, uMean.y, fl)) * e;
    if (py > yt || py < yb) return;
    vec3 b = textureLod(uField, uv * ${f1(DETAIL_SCALE)} + vec2(${f1(DETAIL_OFF[0])}, ${f1(DETAIL_OFF[1])}), lod + ${f1(Math.log2(DETAIL_SCALE))}).rgb;
    ht = uDeck.y - amp * (1.0 - mix(a.g, b.g, uLumpy)) + tw;
    hb = uDeck.x + uShape.z * smoothstep(0.25, 0.8, b.r);
    yt = mid + (mix(ht, uMean.x, fl) - mid) * e;
    yb = mid - (mid - mix(hb, uMean.y, fl)) * e;
    ht = mid + (ht - mid) * e;
  }

  void main() {
    vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
    vec3 rv = uCamRot * vec3((ndc + uProj.zw) * uProj.xy, -1.0);
    float rl = length(rv);
    vec3 d = rv / rl;
    if (abs(d.y) < 1e-5) d.y = d.y < 0.0 ? -1e-5 : 1e-5;

    // the stretch of this ray between the lowest base and the highest top
    float yLo = uDeck.x;
    float yHi = uDeck.y + uShape.y;
    float ta = (yLo - uCamPos.y) / d.y;
    float tb = (yHi - uCamPos.y) / d.y;
    float t0 = max(min(ta, tb), 0.0);
    float tEnd = min(max(ta, tb), uFogFar * 1.03);   // beyond full haze cloud and sky are one colour
    if (tEnd <= t0) discard;

    float pix = uProj.y * 2.0 / uRes.y;              // one pixel, as a tangent
    float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float dsBase = max(uShape.w * 0.3, 14.0);

    // jitter the START only (a per-step factor compounds: at 8 km neighbouring
    // pixels sampled 800 m apart, and far cloud came out as grain)
    float t = t0 + jit * (dsBase + t0 * 0.06) * 0.6;
    float T = 1.0;        // transmittance so far
    float sT = 0.0;       // Σ weight × distance / light / height / thickness
    float sIll = 0.0;
    float sAo = 0.0;
    float sThick = 0.0;
    bool spent = true;
    float tOut = -1.0;    // the last sample that was in clear air, and its depth
    float mOut = -1.0;
    float yt, yb, ht, gap;
    for (int i = 0; i < STEPS; i++) {
      if (t >= tEnd || T < 0.03) { spent = false; break; }
      vec3 p = uCamPos + d * t;
      float lod = clamp(log2(max(t * pix * 1.5, 1.0) / TEXEL), 0.0, 7.0);
      float fl = smoothstep(0.5, 1.0, t / uFlat);
      surf(p.xz, lod, fl, p.y, yt, yb, ht, gap);
      float m = min(yt - p.y, p.y - yb);
      float dsMin = dsBase + t * 0.06;
      float ds;
      if (m <= 0.0) {
        // clear air: as far as the clearance allows for a surface this steep
        tOut = t;
        mOut = m - gap - 0.01;
        ds = clamp((gap - m) / (abs(d.y) + 0.42 * (1.0 - fl) + 0.03), dsMin, max(900.0, t * 0.3));
      } else {
        if (tOut >= 0.0) {
          // stepped in from clear air: find where (the edge then lies on
          // the surface itself, not on a ring of step lengths)
          // (false position: the depth is close to linear along the ray, so
          // three goes land within a metre or two — plain bisection of a
          // 500 m far step left 60 m terraces, drawn as contour lines)
          float lo = tOut;
          float hi = t;
          float mLo = mOut;
          float mHi = m;
          for (int k = 0; k < 3; k++) {
            float tm = lo + (hi - lo) * clamp(-mLo / (mHi - mLo), 0.08, 0.92);
            vec3 pm = uCamPos + d * tm;
            surf(pm.xz, lod, fl, pm.y, yt, yb, ht, gap);
            float mm = min(yt - pm.y, pm.y - yb);
            if (mm > 0.0) { hi = tm; mHi = mm; } else { lo = tm; mLo = mm - 0.01; }
          }
          t = lo + (hi - lo) * clamp(-mLo / (mHi - mLo), 0.0, 1.0);
          p = uCamPos + d * t;
          surf(p.xz, lod, fl, p.y, yt, yb, ht, gap);
          m = max(min(yt - p.y, p.y - yb), 0.0);
          tOut = -1.0;
        }
        // resolve the diffuse edge: no more than half of it per step
        ds = min(dsMin, uShape.w * 0.5 / max(abs(d.y), 0.06));
        m += 0.5 * ds * min(abs(d.y), 0.5);   // the density half a step on
        float rho = smoothstep(0.0, uShape.w, m);
        float a = 1.0 - exp(-uDeck.w * (1.0 + t / 220.0) * rho * ds);
        float w = T * a;
        sT += w * (t + ds * 0.4);
        sIll += w * exp(-(yt - p.y) * ${f1(1 / CLOUD_ABSORB)});
        sAo += w * clamp((ht - (uDeck.y - uShape.x)) / (uShape.x + 0.6 * uShape.y), 0.0, 1.0);
        sThick += w * (clamp((yt - yb - uThick.x) * uThick.y, 0.0, 1.0) - 0.45 * clamp((yb - uDeck.x) * uThick.z, 0.0, 1.0));
        T *= 1.0 - a;
      }
      t += ds;
    }

    float w = 1.0 - T;
    // out of steps with the ray still running: it meets the relaxed layer —
    // the mean top from above, the mean base from beneath, or the cloud it
    // is already down among
    if (spent && T > 0.03 && t < tEnd) {
      float tp = -1.0;
      float py = uCamPos.y + d.y * t;
      if (d.y < 0.0 && py > uMean.x) tp = (uCamPos.y - uMean.x) / (-d.y);
      else if (d.y > 0.0 && py < uMean.y) tp = (uMean.y - uCamPos.y) / d.y;
      else if (py < uMean.x && py > uMean.y) tp = t;
      if (tp >= t && tp < tEnd) {
        vec3 p = uCamPos + d * tp;
        float lod = clamp(log2(max(tp * pix * 1.5, 1.0) / TEXEL), 0.0, 7.0);
        surf(p.xz, lod, 1.0, uMean.x - 1.0, yt, yb, ht, gap);
        float a = yt > yb ? T : 0.0;
        sT += a * tp;
        sIll += a * (d.y < 0.0 ? 0.85 : 0.0);
        sAo += a * clamp((ht - (uDeck.y - uShape.x)) / (uShape.x + 0.6 * uShape.y), 0.0, 1.0);
        sThick += a * (clamp((yt - yb - uThick.x) * uThick.y, 0.0, 1.0) - 0.45 * clamp((yb - uDeck.x) * uThick.z, 0.0, 1.0));
        w += a;
      }
    }
    if (w < 0.012) discard;

    float tc = sT / w;
    float ill = sIll / w;
    // from beneath: dark under the thick places and where scud hangs low
    vec3 col = uShade * (1.1 - 0.34 * sThick / w);
    if (ill > 0.02) {
      // the lit top: bright domes over dimmer valleys, modelled by the sun
      vec3 q = uCamPos + d * tc;
      float lod = clamp(log2(max(tc * pix * 2.0, 1.0) / TEXEL), 0.0, 7.0);
      float e = max(55.0, tc * pix * 3.0);
      float h0, hx, hz;
      float yMid = 0.5 * (uDeck.x + uDeck.y);   // inside the layer: the exact surface, not the bound
      surf(q.xz, lod, 0.0, yMid, yt, yb, h0, gap);
      surf(q.xz + vec2(e, 0.0), lod, 0.0, yMid, yt, yb, hx, gap);
      surf(q.xz + vec2(0.0, e), lod, 0.0, yMid, yt, yb, hz, gap);
      vec3 n = normalize(vec3(h0 - hx, e, h0 - hz));
      float lam = clamp(dot(n, uSunDir) * 0.85 + 0.3, 0.0, 1.0);
      vec3 top = uLit * (0.74 + 0.26 * sAo / w) * (0.6 + 0.4 * lam);
      col = mix(col, top, ill);
    }
    col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, tc));

    float vd = max(tc / rl, 0.05);       // view depth of where the cloud was met
    #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
      gl_FragDepth = log2(1.0 + vd) * logDepthBufFC * 0.5;
    #else
      gl_FragDepth = clamp((uDepthAB.y - uDepthAB.x * vd) / vd * 0.5 + 0.5, 0.0, 1.0);
    #endif
    gl_FragColor = vec4(col, w);
  }
`;

export class CloudDeckView {
  /** the fields the picture is drawn from — and the sim flies through */
  readonly fields: CloudFields;
  private mat: THREE.ShaderMaterial | null = null;
  private drift = new THREE.Vector2();

  /**
   * `lit` / `shade`: cloud in sunlight and from beneath (raw shader space);
   * `steps`: march budget per pixel.
   */
  constructor(
    scene: THREE.Scene, private wx: WeatherPreset, fogColor: THREE.Color,
    lit: THREE.Color, shade: THREE.Color, sunDir: THREE.Vector3, steps = 40,
  ) {
    this.fields = makeCloudFields();
    const deck = wx.deck;
    if (!deck) return;
    const N = FIELD_N;
    const px = new Uint8Array(N * N * 4);
    for (let i = 0; i < N * N; i++) {
      px[i * 4] = this.fields.cover[i];
      px[i * 4 + 1] = this.fields.lump[i];
      px[i * 4 + 2] = this.fields.tower[i];
      px[i * 4 + 3] = this.fields.region[i];
    }
    const tex = new THREE.DataTexture(px, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;

    // one triangle over the whole screen; the shader finds the cloud
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: { STEPS: Math.round(steps) },
      transparent: true,
      depthWrite: true,
      uniforms: {
        uField: { value: tex },
        uDrift: { value: this.drift },
        uDeck: { value: new THREE.Vector4(deck.base, deck.top, deck.cover, 3 / wx.cloudVis) },
        uShape: { value: new THREE.Vector4(deck.relief, deck.towers, deck.ragged, deck.soft) },
        uMean: { value: new THREE.Vector2(deck.top - MEAN_TOP * deck.relief, deck.base + MEAN_BASE * deck.ragged) },
        uThick: {
          value: new THREE.Vector3(
            deck.cover < 0.99 ? 0 : deck.top - deck.relief - deck.base - deck.ragged,
            1 / (deck.cover < 0.99 ? deck.top - deck.base + deck.towers : deck.relief + deck.towers * 0.6 + deck.ragged),
            1 / Math.max(deck.ragged, 1),
          ),
        },
        uLumpy: { value: deck.lumpy },
        uFlat: { value: 9000 },
        uLit: { value: lit },
        uShade: { value: shade },
        uSunDir: { value: sunDir },
        uFogColor: { value: fogColor },
        uFogNear: { value: 2000 },
        uFogFar: { value: 7000 },
        uCamPos: { value: new THREE.Vector3() },
        uRes: { value: new THREE.Vector2(1, 1) },
        uProj: { value: new THREE.Vector4(1, 1, 0, 0) },
        uCamRot: { value: new THREE.Matrix3() },
        uDepthAB: { value: new THREE.Vector2(-1, -1) },
      },
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    // after the water sheet (1), before the cumulus sprites (5): it writes
    // depth, so puffs and contrails beyond it are hidden by it
    mesh.renderOrder = 3;
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      const u = mat.uniforms;
      renderer.getDrawingBufferSize(u.uRes.value);
      const p = camera.projectionMatrix.elements;
      u.uProj.value.set(1 / p[0], 1 / p[5], p[8], p[9]);
      u.uDepthAB.value.set(p[10], p[14]);
      u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    };
    scene.add(mesh);
    this.mat = mat;
  }

  /** Cloud at a point, 0..1 — the same volume the picture is marched through. */
  densityAt(x: number, y: number, z: number): number {
    return deckDensity(this.wx.deck, this.fields, x + this.drift.x, y, z + this.drift.y);
  }

  /** 0..1 sunlight at a point in or under the layer (what colour its murk is). */
  lightAt(x: number, y: number, z: number): number {
    return deckLight(this.wx.deck, this.fields, x + this.drift.x, y, z + this.drift.y);
  }

  /** Carry the fog range, drift with the wind aloft. */
  update(camPos: THREE.Vector3, fogNear: number, fogFar: number, dt: number, windX: number, windZ: number): void {
    // the field moves with the wind: the lookup shifts the other way
    this.drift.x -= windX * dt;
    this.drift.y -= windZ * dt;
    const deck = this.wx.deck;
    if (!this.mat || !deck) return;
    const u = this.mat.uniforms;
    u.uFogNear.value = fogNear;
    u.uFogFar.value = fogFar;
    // relief holds to 9 km from inside the layer and further the further
    // off the eye is (from high above, the whole near field keeps its lumps)
    const off = Math.max(camPos.y - (deck.top + deck.towers), deck.base - camPos.y, 0);
    u.uFlat.value = 9000 + off * 9;
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
