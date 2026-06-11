/**
 * SLIPSTREAM — entry point and game orchestration.
 * Owns the renderer, the state machine (menu → flying → paused/crashed/
 * victory), the fixed-step simulation loop, and all the wiring between
 * world, aircraft, input, audio, HUD and DOM chrome.
 */
import * as THREE from 'three';
import './styles.css';

import { WorldGen, AIRPORTS } from './world/heightfield';
import { TerrainManager, CHUNK_SIZE } from './world/terrain';
import { Water } from './world/water';
import { Sky } from './world/sky';
import { Airport } from './world/airport';
import { RingCourse, RING_COUNT } from './world/rings';
import { Aircraft } from './aircraft/aircraft';
import { specById } from './aircraft/catalog';
import { Autopilot } from './aircraft/autopilot';
import { InputManager } from './input/input';
import { TouchControls, isTouchDevice } from './input/touch';
import { FlightCamera } from './camera';
import { SoundEngine } from './audio/sound';
import { Hud, HudData } from './ui/hud';
import { Minimap } from './ui/minimap';
import { Screens, DebriefStats } from './ui/screens';
import { loadSave, persist, Quality } from './save';
import { clamp, damp, MS_TO_KT, M_TO_FT, wrapAngle } from './core/math';

type GameState = 'boot' | 'menu' | 'flying' | 'paused' | 'crashed' | 'victory';

const _menuTarget = new THREE.Vector3();
const _menuDir = new THREE.Vector3();
const _menuRight = new THREE.Vector3();

class Game {
  // three.js core
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();

  // world
  private gen = new WorldGen();
  private terrain: TerrainManager;
  private water: Water;
  private sky: Sky;
  private airport: Airport;
  private rings: RingCourse;

  // actors & systems
  private aircraft: Aircraft;
  private input = new InputManager();
  private touch: TouchControls | null = null;
  private flightCam: FlightCamera;
  private sound = new SoundEngine();
  private hud = new Hud();
  private minimap: Minimap;
  private autopilot = new Autopilot();
  private screens: Screens;
  private save = loadSave();
  private baseFogNear = 2500;
  private baseFogFar = 7000;
  private fogFarCap = 26000;

  // state
  private state: GameState = 'boot';
  private timer = new THREE.Timer();
  private simTime = 0;
  private menuOrbit = 0;
  private crashTimer = 0;
  private wasOnGround = true;
  private prevSinkRate = 0;

  // flight stats
  private stats = { flightTime: 0, distanceKm: 0, maxAltFt: 0, maxSpdKt: 0 };
  private raceTime = 0;
  private raceRunning = false;

  private heightFn = (x: number, z: number): number => this.gen.heightAt(x, z);

  // ?autofly=1[&ac=vector][&apt=1] — demo/smoke-test mode: takes off by itself
  private autoFly = false;
  private spawnField = AIRPORTS[0];

  constructor() {
    const touch = isTouchDevice();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      // uniform relative depth precision at any distance — kills shoreline
      // z-fighting without biasing the water (a bias floods low terrain when
      // viewed from far away). Skipped on touch GPUs: it defeats early-Z.
      logarithmicDepthBuffer: !touch,
    });
    this.renderer.domElement.classList.add('gl');
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    document.getElementById('app')!.appendChild(this.renderer.domElement);

    this.sky = new Sky(this.scene, touch ? 26 : 56);
    this.scene.fog = new THREE.Fog(this.sky.fogColor, 2500, 7000);
    this.scene.background = null; // dome handles it

    this.terrain = new TerrainManager(this.scene, this.gen);
    this.water = new Water(this.scene, this.sky.fogColor, this.sky.sunDir);
    this.airport = new Airport(this.scene, this.gen);
    this.rings = new RingCourse(this.scene, this.gen);

    this.aircraft = new Aircraft(specById(this.save.aircraft));
    this.scene.add(this.aircraft.model);
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);

    this.flightCam = new FlightCamera(window.innerWidth / window.innerHeight);
    this.minimap = new Minimap(this.gen);
    this.screens = new Screens(this.save, touch);
    if (touch) this.touch = new TouchControls(this.input);
    this.wireCameraPointer();

    const params = new URLSearchParams(location.search);
    this.autoFly = params.get('autofly') === '1';
    if (params.get('mode') === 'race') this.save.mode = 'race';
    const aptParam = Number(params.get('apt') ?? '0');
    if (aptParam > 0 && aptParam < AIRPORTS.length) this.spawnField = AIRPORTS[aptParam];
    const acParam = params.get('ac');
    if (acParam && acParam !== this.save.aircraft) {
      this.save.aircraft = acParam;
      this.swapAircraft(acParam);
      this.screens.refreshMenu();
    }

    this.wireUi();
    this.applyQuality(this.save.quality);
    this.applySettings();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'flying') this.pause();
    });

    this.renderer.setAnimationLoop(() => this.frame());
  }

  /* ------------------------------------------------ wiring ---- */

  /** Drag on the 3D canvas orbits the camera; wheel zooms. */
  private wireCameraPointer(): void {
    const el = this.renderer.domElement;
    let activePointer: number | null = null;
    let lastX = 0;
    let lastY = 0;

    el.addEventListener('pointerdown', (e) => {
      if (this.state !== 'flying' || activePointer !== null) return;
      activePointer = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      this.flightCam.beginDrag();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activePointer) return;
      this.flightCam.drag(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    const release = (e: PointerEvent): void => {
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      this.flightCam.endDrag();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('wheel', (e) => {
      if (this.state !== 'flying') return;
      e.preventDefault();
      this.flightCam.wheel(e.deltaY);
    }, { passive: false });
  }

  private wireUi(): void {
    const s = this.screens;
    s.onAnyClick = () => this.sound.init();
    s.onFly = () => this.startFlight();
    s.onAircraft = (id) => this.swapAircraft(id);
    s.onMode = () => { persist(this.save); };
    s.onSettings = () => { this.applyQuality(this.save.quality); this.applySettings(); persist(this.save); };
    s.onResume = () => {
      if (this.state === 'paused') this.resume();
      else if (this.state === 'flying') this.pause();
    };
    s.onRestart = () => { this.sound.uiClick(); this.startFlight(); };
    s.onHangar = () => this.toHangar();
    s.onApAdjust = (kind, dir) => this.apAdjust(kind, dir);

    // desktop AP bug hotkeys (repeat allowed — hold to slew)
    window.addEventListener('keydown', (e) => {
      if (this.state !== 'flying' || !this.autopilot.engaged) return;
      switch (e.code) {
        case 'BracketLeft': this.apAdjust('hdg', -1); break;
        case 'BracketRight': this.apAdjust('hdg', 1); break;
        case 'PageUp': e.preventDefault(); this.apAdjust('alt', 1); break;
        case 'PageDown': e.preventDefault(); this.apAdjust('alt', -1); break;
        case 'Home': e.preventDefault(); this.apAdjust('spd', 1); break;
        case 'End': e.preventDefault(); this.apAdjust('spd', -1); break;
      }
    });

    this.input.on('pause', () => {
      if (this.state === 'flying') this.pause();
      else if (this.state === 'paused') this.resume();
    });
    this.input.on('camera', () => {
      if (this.state !== 'flying') return;
      const mode = this.flightCam.cycle();
      this.screens.toast(mode === 'chase' ? 'CHASE CAMERA' : mode === 'cockpit' ? 'COCKPIT VIEW' : 'CINEMATIC ORBIT');
    });
    this.input.on('gear', () => {
      if (this.state !== 'flying' || !this.aircraft.spec.retractableGear) return;
      this.sound.gearThunk();
      this.screens.toast(this.input.controls.gearDown ? 'GEAR DOWN' : 'GEAR UP');
    });
    this.input.on('flaps', () => {
      if (this.state !== 'flying') return;
      const f = Math.round(this.input.controls.flaps * 3);
      this.screens.toast(f === 0 ? 'FLAPS UP' : `FLAPS ${f}`);
    });
    this.input.on('reset', () => {
      if (this.state === 'flying' || this.state === 'crashed') this.startFlight();
    });
    this.input.on('autopilot', () => this.toggleAutopilot());
    this.input.on('airbrake', () => this.toggleAirbrake());
    this.input.on('hud', () => {
      if (this.state !== 'flying') return;
      const mode = this.hud.cycleMode();
      this.screens.toast(mode === 'full' ? 'HUD FULL' : mode === 'min' ? 'HUD MINIMAL' : 'HUD OFF');
    });
    this.input.on('map', () => {
      if (this.state !== 'flying') return;
      this.minimap.setVisible(!this.minimap.visible);
      this.screens.toast(this.minimap.visible ? 'MAP ON' : 'MAP OFF');
    });

    if (this.touch) {
      this.touch.onCamera = () => {
        if (this.state !== 'flying') return;
        this.flightCam.cycle();
      };
      this.touch.onAutopilot = () => this.toggleAutopilot();
      this.touch.onAirbrake = () => this.toggleAirbrake();
    }
  }

  private toggleAutopilot(): void {
    if (this.state !== 'flying') return;
    const st = this.aircraft.state;
    if (this.autopilot.engaged) {
      this.autopilot.disengage();
      this.screens.setApPanel(false);
      this.screens.toast('AUTOPILOT OFF');
    } else if (!st.onGround) {
      this.autopilot.engage(st, this.input.controls.throttle);
      const ft = Math.round(st.pos.y * M_TO_FT / 100) * 100;
      this.screens.toast(`AP HOLDING ${ft} FT`, 2200);
    } else {
      this.screens.toast('AP UNAVAILABLE ON THE GROUND');
    }
  }

  /** Slew an autopilot target bug: hdg ±5°, alt ±500 ft, spd ±10 kt. */
  private apAdjust(kind: 'hdg' | 'alt' | 'spd', dir: number): void {
    if (!this.autopilot.engaged) return;
    if (kind === 'hdg') this.autopilot.adjustHeading(dir * 5 * Math.PI / 180);
    else if (kind === 'alt') this.autopilot.adjustAltitude(dir * 152.4);
    else this.autopilot.adjustSpeed(dir * 5.144, this.aircraft.spec.vne * 0.92);
  }

  private toggleAirbrake(): void {
    if (this.state !== 'flying') return;
    if (this.aircraft.spec.airbrakeCd <= 0) {
      this.screens.toast('NO SPEED BRAKE FITTED');
      return;
    }
    const out = this.input.toggleAirbrake();
    this.sound.gearThunk();
    this.screens.toast(out ? 'SPEED BRAKE OUT' : 'SPEED BRAKE IN');
  }

  /* ------------------------------------------------ settings ---- */

  private applyQuality(q: Quality): void {
    const dpr = window.devicePixelRatio || 1;
    if (q === 'low') {
      this.renderer.setPixelRatio(Math.min(dpr, 1));
      this.renderer.shadowMap.enabled = false;
      this.sky.setShadows(false);
      this.terrain.radius = 4;
      this.terrain.buildBudget = 1;
    } else if (q === 'medium') {
      this.renderer.setPixelRatio(Math.min(dpr, 1.5));
      this.renderer.shadowMap.enabled = true;
      this.sky.setShadows(true);
      this.terrain.radius = 6;
      this.terrain.buildBudget = 2;
    } else {
      this.renderer.setPixelRatio(Math.min(dpr, 2));
      this.renderer.shadowMap.enabled = true;
      this.sky.setShadows(true);
      this.terrain.radius = 8;
      this.terrain.buildBudget = 2;
    }
    this.terrain.altBonus = q === 'low' ? 2 : 4;
    // far horizon shell density, how far each LOD reaches (in rings), and
    // how far the fog may open up at altitude (cap stays well inside the
    // shell so its edge is never visible)
    const t = this.terrain;
    if (q === 'low') {
      t.configureFar(80, 600); // 48 km shell
      [t.fineRing, t.midRing, t.fineRingHigh, t.midRingHigh] = [2, 4, 3, 5];
      this.fogFarCap = 14000;
    } else if (q === 'medium') {
      t.configureFar(150, 360); // 54 km shell
      [t.fineRing, t.midRing, t.fineRingHigh, t.midRingHigh] = [3, 5, 4, 6];
      this.fogFarCap = 20000;
    } else {
      t.configureFar(210, 300); // 63 km shell
      [t.fineRing, t.midRing, t.fineRingHigh, t.midRingHigh] = [3, 5, 5, 8];
      this.fogFarCap = 26000;
    }
    const view = this.terrain.radius * CHUNK_SIZE;
    this.baseFogNear = view * 0.38;
    this.baseFogFar = view * 0.96;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.baseFogNear;
    fog.far = this.baseFogFar;
    this.water.setFogRange(fog.near, fog.far);
    // force material recompile for shadow toggle
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
  }

  private applySettings(): void {
    this.input.invertY = this.save.invertY;
    this.input.sensitivity = this.save.sensitivity;
    this.sound.setMuted(this.save.muted);
    this.screens.syncSettings();
  }

  /* ------------------------------------------------ state flow ---- */

  private swapAircraft(id: string): void {
    this.scene.remove(this.aircraft.model);
    this.aircraft.dispose();
    this.aircraft = new Aircraft(specById(id));
    this.scene.add(this.aircraft.model);
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    this.sound.uiClick();
    persist(this.save);
  }

  private startFlight(): void {
    this.sound.init();
    this.input.resetForFlight();
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    this.sound.setEngineKind(this.aircraft.spec.engine);
    this.flightCam.set('chase');
    this.stats = { flightTime: 0, distanceKm: 0, maxAltFt: 0, maxSpdKt: 0 };
    this.raceTime = 0;
    this.raceRunning = false;
    this.wasOnGround = true;
    if (this.save.mode === 'race') {
      this.rings.start(this.aircraft.state.pos);
    } else {
      this.rings.stop();
    }
    this.autopilot.disengage();
    this.state = 'flying';
    this.screens.show(null);
    this.hud.visible = true;
    this.minimap.show(true);
    this.touch?.show(true);
    this.touch?.setThrottle(0);
    this.screens.toast(this.save.mode === 'race' ? 'RING RUSH — GO!' : 'CLEARED FOR TAKEOFF', 2400);
  }

  private pause(): void {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.screens.show('pause');
    this.minimap.show(false);
    this.touch?.show(false);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'flying';
    this.screens.show(null);
    this.minimap.show(true);
    this.touch?.show(true);
    this.timer.update(); // swallow the pause gap
  }

  private toHangar(): void {
    this.sound.uiClick();
    this.state = 'menu';
    this.hud.visible = false;
    this.hud.clear();
    this.minimap.show(false);
    this.touch?.show(false);
    this.rings.stop();
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    this.screens.show('menu');
    this.screens.refreshMenu();
  }

  private onCrash(): void {
    this.state = 'crashed';
    this.crashTimer = 1.1;
    this.flightCam.addShake(1.4);
    this.sound.crashBoom();
    this.hud.visible = false;
    this.minimap.show(false);
    this.touch?.show(false);
  }

  private finishRace(): void {
    this.state = 'victory';
    this.sound.finishFanfare();
    this.hud.visible = false;
    this.minimap.show(false);
    this.touch?.show(false);
    const id = this.aircraft.spec.id;
    const prev = this.save.bestTimes[id];
    const isRecord = prev === undefined || this.raceTime < prev;
    if (isRecord) {
      this.save.bestTimes[id] = this.raceTime;
      persist(this.save);
    }
    this.screens.showVictory(this.raceTime, this.save.bestTimes[id], isRecord, this.debrief());
  }

  private debrief(): DebriefStats {
    return {
      flightTime: this.stats.flightTime,
      distanceKm: this.stats.distanceKm,
      maxAltFt: this.stats.maxAltFt,
      maxSpdKt: this.stats.maxSpdKt,
    };
  }

  /* ------------------------------------------------ frame ---- */

  private frame(): void {
    this.timer.update();
    // tight clamp: a dropped frame slows the sim a hair instead of letting
    // the world visibly jump ("rubber banding")
    const dt = clamp(this.timer.getDelta(), 0, 0.04);
    this.simTime += dt;
    const st = this.aircraft.state;

    // stream the world around a point led ahead of the aircraft (~3 s of
    // travel, capped at 3 chunks): chunks in the direction of flight reach
    // full resolution before you arrive, not as you cross into each ring
    const agl = st.pos.y - this.gen.heightAt(st.pos.x, st.pos.z);
    const leadX = st.pos.x + clamp(st.vel.x * 3, -2700, 2700);
    const leadZ = st.pos.z + clamp(st.vel.z * 3, -2700, 2700);
    this.terrain.update(leadX, leadZ, agl, dt);

    // fog opens out with the streamed radius and, above that, with altitude:
    // the far shell carries the horizon out to ~30 km, so the higher you fly
    // the further the eye is allowed to reach before the haze closes in
    const fog = this.scene.fog as THREE.Fog;
    const scale = this.terrain.effRadius() / this.terrain.radius;
    const farT = Math.min(this.baseFogFar * scale + Math.max(agl - 400, 0) * 6, this.fogFarCap);
    const nearT = farT * (this.baseFogNear / this.baseFogFar);
    fog.near = clamp(damp(fog.near, nearT, 0.8, dt), 100, 40000);
    fog.far = clamp(damp(fog.far, farT, 0.8, dt), 200, 41000);
    this.water.setFogRange(fog.near, fog.far);

    this.water.update(this.simTime, this.flightCam.camera.position);
    this.sky.update(st.pos, fog.far, dt);
    this.airport.update(this.simTime, st.pos.x, st.pos.z);

    switch (this.state) {
      case 'boot':
        this.bootFrame();
        break;
      case 'menu':
        this.menuFrame(dt);
        break;
      case 'flying':
        this.flyFrame(dt);
        break;
      case 'crashed':
        this.crashFrame(dt);
        break;
      case 'paused':
      case 'victory':
        break;
    }

    // in cockpit view the airframe shell is hidden — the models have no
    // interiors, so clipping through the nose looks far worse than a clean
    // HUD-only view
    this.aircraft.model.visible = !(
      this.flightCam.mode === 'cockpit' &&
      this.state !== 'menu' &&
      this.state !== 'boot'
    );

    this.renderer.render(this.scene, this.flightCam.camera);
  }

  private bootFrame(): void {
    this.menuFrame(0.016);
    const st = this.aircraft.state;
    const ready = this.terrain.isReadyAround(st.pos.x, st.pos.z, 1) || this.simTime > 8;
    if (ready) {
      document.getElementById('boot')?.classList.add('gone');
      this.state = 'menu';
      this.screens.show('menu');
      if (this.autoFly) {
        this.startFlight();
        // ?ff=N — deterministic fast-forward for smoke tests
        const ff = Number(new URLSearchParams(location.search).get('ff') ?? '0');
        if (ff > 0) {
          const step = 1 / 60;
          for (let t = 0; t < ff; t += step) {
            this.applyAutoFly();
            this.input.update(step);
            this.aircraft.update(this.input.controls, step, this.heightFn);
            if (this.aircraft.state.crashed) break;
          }
          this.wasOnGround = this.aircraft.state.onGround;
          // &ap=1 — engage the autopilot after the fast-forward (smoke test)
          if (new URLSearchParams(location.search).get('ap') === '1' && !this.aircraft.state.onGround) {
            this.toggleAutopilot();
          }
        }
      }
    }
  }

  private menuFrame(dt: number): void {
    // slow showroom orbit around the parked aircraft
    this.menuOrbit += dt * 0.16;
    const st = this.aircraft.state;
    const spec = this.aircraft.spec;
    const r = spec.chaseDist * 1.85;
    const cam = this.flightCam.camera;
    cam.position.set(
      st.pos.x + Math.cos(this.menuOrbit) * r,
      st.pos.y + spec.chaseHeight * 1.1,
      st.pos.z + Math.sin(this.menuOrbit) * r,
    );
    const groundMin = this.gen.heightAt(cam.position.x, cam.position.z) + 2;
    if (cam.position.y < groundMin) cam.position.y = groundMin;

    // on wide layouts, shift the look target so the aircraft sits in the
    // hangar pane to the left of the spec card
    _menuTarget.set(st.pos.x, st.pos.y + 1.2, st.pos.z);
    if (window.innerWidth > 880) {
      _menuDir.subVectors(_menuTarget, cam.position).normalize();
      _menuRight.crossVectors(_menuDir, THREE.Object3D.DEFAULT_UP).normalize();
      _menuTarget.addScaledVector(_menuRight, r * 0.28);
    }
    cam.lookAt(_menuTarget);
    cam.fov = 50;
    cam.updateProjectionMatrix();
  }

  private flyFrame(dt: number): void {
    const st = this.aircraft.state;
    this.input.update(dt);
    if (this.autoFly) this.applyAutoFly();

    // autopilot: manual stick input kicks it off, like the real thing
    if (this.autopilot.engaged) {
      if (this.input.hasManualStick()) {
        this.autopilot.disengage();
        this.screens.setApPanel(false);
        this.screens.toast('AP DISENGAGED — MANUAL INPUT');
      } else {
        this.autopilot.update(this.aircraft.spec, st, this.input.controls, dt);
        this.touch?.setThrottle(this.input.controls.throttle);
        const hdg = ((this.autopilot.targetHdg * 180 / Math.PI) % 360 + 360) % 360;
        this.screens.setApPanel(
          true,
          `${String(Math.round(hdg)).padStart(3, '0')}°`,
          `${Math.round(this.autopilot.targetAlt * M_TO_FT / 50) * 50} FT`,
          `${Math.round(this.autopilot.targetSpd * MS_TO_KT)} KT`,
        );
      }
    }

    this.aircraft.update(this.input.controls, dt, this.heightFn);

    // landing / takeoff transitions
    if (!st.crashed) {
      if (this.wasOnGround && !st.onGround) {
        this.screens.toast('POSITIVE CLIMB', 1500);
      } else if (!this.wasOnGround && st.onGround) {
        this.sound.touchdown();
        this.flightCam.addShake(clamp(this.prevSinkRate * 0.12, 0.1, 0.8));
        if (this.prevSinkRate < 1.6 && this.gen.isOnRunway(st.pos.x, st.pos.z)) {
          this.screens.toast('GREASED IT — BEAUTIFUL LANDING', 2400);
        }
      }
      this.prevSinkRate = -st.vel.y;
      this.wasOnGround = st.onGround;
    }

    // stats
    this.stats.flightTime += dt;
    this.stats.distanceKm += (st.airspeed * dt) / 1000;
    this.stats.maxAltFt = Math.max(this.stats.maxAltFt, st.pos.y * M_TO_FT);
    this.stats.maxSpdKt = Math.max(this.stats.maxSpdKt, st.airspeed * MS_TO_KT);

    // race
    if (this.rings.active) {
      if (!this.raceRunning && st.airspeed > 4) this.raceRunning = true;
      if (this.raceRunning) this.raceTime += dt;
      const result = this.rings.update(st.pos, this.simTime);
      if (result === 'pass') {
        this.sound.ringChime();
        this.screens.toast(`GATE ${this.rings.current}/${RING_COUNT}`, 1100);
      } else if (result === 'finish') {
        this.sound.ringChime();
        this.finishRace();
        return;
      }
    }

    if (st.crashed) {
      this.onCrash();
      return;
    }

    // camera, audio, HUD
    this.flightCam.update(this.aircraft, dt, this.heightFn);
    if (st.stalled) this.flightCam.addShake(0.005); // light pre-stall buffet, not an earthquake
    this.sound.update(
      this.input.controls.throttle, st.thrustFrac, st.airspeed, st.stalled, this.simTime,
    );
    this.hud.draw(this.hudData(), dt);
    this.minimap.update(st.pos.x, st.pos.z, st.heading, this.rings);

    this.touch?.syncState(
      this.input.controls.gearDown,
      this.input.controls.flaps,
      this.aircraft.spec.retractableGear,
      this.autopilot.engaged,
      this.input.controls.airbrake,
      this.aircraft.spec.airbrakeCd > 0,
    );
    this.screens.setPortraitWarning(true);
  }

  private applyAutoFly(): void {
    const st = this.aircraft.state;
    const c = this.input.controls;
    c.throttle = 1;
    const radar = st.pos.y - this.gen.heightAt(st.pos.x, st.pos.z);
    const rotateSpeed = Math.sqrt((2 * this.aircraft.spec.mass * 9.81) /
      (1.225 * this.aircraft.spec.wingArea * 1.1)) * 0.85;
    c.pitch = st.airspeed > rotateSpeed && st.pitchAngle < 0.14 ? 0.3 : 0;
    c.roll = 0;
    if (!st.onGround && radar > 50) c.gearDown = false;
    document.title =
      `v=${st.airspeed.toFixed(1)} y=${st.pos.y.toFixed(1)} z=${st.pos.z.toFixed(0)} ` +
      `gnd=${st.onGround} thr=${c.throttle.toFixed(2)} tf=${st.thrustFrac.toFixed(2)} ` +
      `pit=${st.pitchAngle.toFixed(2)} crash=${st.crashed}`;
  }

  private crashFrame(dt: number): void {
    this.crashTimer -= dt;
    this.flightCam.update(this.aircraft, dt, this.heightFn);
    this.sound.update(0, 0, 0, false, this.simTime);
    if (this.crashTimer <= 0 && this.screens.current !== 'crash') {
      this.screens.showCrash(this.aircraft.state.crashReason, this.debrief());
    }
  }

  private hudData(): HudData {
    const st = this.aircraft.state;
    const spec = this.aircraft.spec;
    const c = this.input.controls;

    let race: HudData['race'] = null;
    const target = this.rings.target();
    if (target) {
      const dx = target.pos.x - st.pos.x;
      const dy = target.pos.y - st.pos.y;
      const dz = target.pos.z - st.pos.z;
      const distH = Math.hypot(dx, dz);
      const absBearing = Math.atan2(dx, -dz); // compass bearing, 0 = north
      race = {
        gate: this.rings.current + 1,
        total: RING_COUNT,
        time: this.raceTime,
        best: this.save.bestTimes[spec.id] ?? null,
        bearing: wrapAngle(absBearing - st.heading),
        elev: Math.atan2(dy, distH),
        distance: Math.hypot(distH, dy),
      };
    }

    return {
      airspeed: st.airspeed,
      groundspeed: Math.hypot(st.vel.x, st.vel.z),
      altitude: st.pos.y,
      radarAlt: st.pos.y - this.gen.heightAt(st.pos.x, st.pos.z),
      heading: st.heading,
      pitch: st.pitchAngle,
      roll: st.rollAngle,
      vs: st.vel.y,
      throttle: c.throttle,
      gForce: st.gForce,
      flaps: c.flaps,
      gearDown: c.gearDown,
      retractable: spec.retractableGear,
      brakes: c.brakes,
      airbrake: c.airbrake,
      autopilot: this.autopilot.engaged,
      stalled: st.stalled,
      afterburner: !!spec.afterburner && c.throttle >= 0.995,
      vne: spec.vne,
      race,
    };
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.flightCam.camera.aspect = w / h;
    this.flightCam.camera.updateProjectionMatrix();
    this.screens.setPortraitWarning(this.state === 'flying');
  }
}

new Game();
