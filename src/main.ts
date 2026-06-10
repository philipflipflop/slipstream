/**
 * SLIPSTREAM — entry point and game orchestration.
 * Owns the renderer, the state machine (menu → flying → paused/crashed/
 * victory), the fixed-step simulation loop, and all the wiring between
 * world, aircraft, input, audio, HUD and DOM chrome.
 */
import * as THREE from 'three';
import './styles.css';

import { WorldGen } from './world/heightfield';
import { TerrainManager, CHUNK_SIZE } from './world/terrain';
import { Water } from './world/water';
import { Sky } from './world/sky';
import { Airport } from './world/airport';
import { RingCourse, RING_COUNT } from './world/rings';
import { Aircraft } from './aircraft/aircraft';
import { specById } from './aircraft/catalog';
import { InputManager } from './input/input';
import { TouchControls, isTouchDevice } from './input/touch';
import { FlightCamera } from './camera';
import { SoundEngine } from './audio/sound';
import { Hud, HudData } from './ui/hud';
import { Screens, DebriefStats } from './ui/screens';
import { loadSave, persist, Quality } from './save';
import { clamp, MS_TO_KT, M_TO_FT, wrapAngle } from './core/math';

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
  private screens: Screens;
  private save = loadSave();

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

  // ?autofly=1[&ac=vector] — demo/smoke-test mode: takes off by itself
  private autoFly = false;

  constructor() {
    const touch = isTouchDevice();

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
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
    this.airport = new Airport(this.scene);
    this.rings = new RingCourse(this.scene, this.gen);

    this.aircraft = new Aircraft(specById(this.save.aircraft));
    this.scene.add(this.aircraft.model);
    this.aircraft.resetOnRunway(this.heightFn);

    this.flightCam = new FlightCamera(window.innerWidth / window.innerHeight);
    this.screens = new Screens(this.save, touch);
    if (touch) this.touch = new TouchControls(this.input);

    const params = new URLSearchParams(location.search);
    this.autoFly = params.get('autofly') === '1';
    if (params.get('mode') === 'race') this.save.mode = 'race';
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

    if (this.touch) {
      this.touch.onCamera = () => {
        if (this.state !== 'flying') return;
        this.flightCam.cycle();
      };
    }
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
    const view = this.terrain.radius * CHUNK_SIZE;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = view * 0.38;
    fog.far = view * 0.96;
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
    this.aircraft.resetOnRunway(this.heightFn);
    this.sound.uiClick();
    persist(this.save);
  }

  private startFlight(): void {
    this.sound.init();
    this.input.resetForFlight();
    this.aircraft.resetOnRunway(this.heightFn);
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
    this.state = 'flying';
    this.screens.show(null);
    this.hud.visible = true;
    this.touch?.show(true);
    this.touch?.setThrottle(0);
    this.screens.toast(this.save.mode === 'race' ? 'RING RUSH — GO!' : 'CLEARED FOR TAKEOFF', 2400);
  }

  private pause(): void {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.screens.show('pause');
    this.touch?.show(false);
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'flying';
    this.screens.show(null);
    this.touch?.show(true);
    this.timer.update(); // swallow the pause gap
  }

  private toHangar(): void {
    this.sound.uiClick();
    this.state = 'menu';
    this.hud.visible = false;
    this.hud.clear();
    this.touch?.show(false);
    this.rings.stop();
    this.aircraft.resetOnRunway(this.heightFn);
    this.screens.show('menu');
    this.screens.refreshMenu();
  }

  private onCrash(): void {
    this.state = 'crashed';
    this.crashTimer = 1.1;
    this.flightCam.addShake(1.4);
    this.sound.crashBoom();
    this.hud.visible = false;
    this.touch?.show(false);
  }

  private finishRace(): void {
    this.state = 'victory';
    this.sound.finishFanfare();
    this.hud.visible = false;
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
    const dt = clamp(this.timer.getDelta(), 0, 0.1);
    this.simTime += dt;
    const st = this.aircraft.state;

    // stream the world around the player (also while in menu, for the view)
    this.terrain.update(st.pos.x, st.pos.z);
    this.water.update(this.simTime, this.flightCam.camera.position);
    this.sky.update(st.pos);
    this.airport.update(this.simTime);

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

    this.renderer.render(this.scene, this.flightCam.camera);
  }

  private bootFrame(): void {
    this.menuFrame(0.016);
    const ready = this.terrain.isReadyAround(0, 0, 1) || this.simTime > 8;
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
    if (st.stalled) this.flightCam.addShake(0.06);
    this.sound.update(
      this.input.controls.throttle, st.thrustFrac, st.airspeed, st.stalled, this.simTime,
    );
    this.hud.draw(this.hudData(), dt);

    this.touch?.syncState(
      this.input.controls.gearDown, this.input.controls.flaps, this.aircraft.spec.retractableGear,
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
      const absBearing = Math.atan2(-dx, -dz); // 0 = north
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
