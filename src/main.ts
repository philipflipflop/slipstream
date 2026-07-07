/**
 * SLIPSTREAM — entry point and game orchestration.
 * Owns the renderer, the state machine (menu → flying → paused/crashed/
 * victory), the fixed-step simulation loop, and all the wiring between
 * world, aircraft, input, audio, HUD and DOM chrome.
 */
import * as THREE from 'three';
import './styles.css';

import { WorldGen, AIRPORTS, WORLDS, WorldTheme, AirfieldDef } from './world/heightfield';
import { daylightById, DAYLIGHTS, DaylightPreset, TimeOfDay } from './world/daylight';
import { TerrainManager, CHUNK_SIZE } from './world/terrain';
import { Water } from './world/water';
import { Sky } from './world/sky';
import { Airport } from './world/airport';
import { RingCourse, RING_COUNT } from './world/rings';
import { Traffic } from './world/traffic';
import { GunneryRange } from './combat/range';
import { ObstacleField } from './world/obstacles';
import { setTurbulence, setWind, crash } from './aircraft/flightModel';
import { Route, bearingTo, distanceTo } from './nav/route';
import {
  IlsApproach, tuneIls, solveIls, LOC_FULL_SCALE, GS_FULL_SCALE,
} from './nav/ils';
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

  // world (constructed in the ctor: the theme comes from the save / URL)
  private gen!: WorldGen;
  private terrain: TerrainManager;
  private water: Water;
  private sky: Sky;
  private airport: Airport;
  private rings: RingCourse;
  private traffic: Traffic;
  private range: GunneryRange;
  private obstacles!: ObstacleField;
  private route = new Route();

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
  private coarseDepth = false; // touch + low preset: no log depth buffer
  private nearIdx = 0;         // stepped near-plane band on the coarse path

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

  // steady wind for this flight (aviation: heading it blows FROM + knots)
  private windFromDeg = 0;
  private windKt = 0;

  // ILS receiver: auto-tunes the best runway end ahead about once a second
  private ilsTuned: IlsApproach | null = null;
  private ilsTimer = 0;
  private ilsFieldScratch: AirfieldDef[] = [];
  private ilsScratch: IlsApproach[] = [];

  private daylight: DaylightPreset;

  constructor() {
    const touch = isTouchDevice();

    // world theme: ?world= overrides the saved choice (smoke tests)
    const worldParam = new URLSearchParams(location.search).get('world') as WorldTheme | null;
    const theme = worldParam && WORLDS.some((w) => w.id === worldParam) ? worldParam : this.save.world;
    this.gen = new WorldGen(undefined, theme);

    // time of day: ?tod= overrides the saved choice (smoke tests)
    const todParam = new URLSearchParams(location.search).get('tod') as TimeOfDay | null;
    this.daylight = daylightById(
      todParam && DAYLIGHTS.some((d) => d.id === todParam) ? todParam : this.save.tod,
    );
    this.save.tod = this.daylight.id; // menu chips reflect the active preset

    // uniform relative depth precision at any distance — kills shoreline
    // z-fighting without biasing the water. It defeats early-Z, so the only
    // devices that skip it are touch devices on the LOW preset; those fall
    // back to the stepped near plane + water depth bias. (The flag is fixed
    // at renderer creation: a quality change applies it on the next reload.)
    this.coarseDepth = touch && this.save.quality === 'low';
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: !this.coarseDepth,
    });
    this.renderer.domElement.classList.add('gl');
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    document.getElementById('app')!.appendChild(this.renderer.domElement);

    this.sky = new Sky(this.scene, touch ? 26 : 56, this.daylight);
    this.scene.fog = new THREE.Fog(this.sky.fogColor, 2500, 7000);
    this.scene.background = null; // dome handles it

    this.terrain = new TerrainManager(this.scene, this.gen, this.daylight.windowGlow);
    // without the log depth buffer the water needs the depth-bias path
    this.water = new Water(this.scene, this.sky.fogColor, this.sky.sunDir, this.coarseDepth, this.daylight);
    this.airport = new Airport(this.scene, this.gen, this.daylight.landingLight);
    this.rings = new RingCourse(this.scene, this.gen);
    this.traffic = new Traffic(this.scene, this.gen);
    this.obstacles = new ObstacleField(this.gen);
    this.range = new GunneryRange(this.scene, this.gen);
    this.range.onHit = (hits, total) => this.screens.toast(`TARGET DOWN — ${hits}/${total}`);
    this.range.onClear = () => this.screens.toast('RANGE CLEAR — ALL TARGETS DESTROYED');
    this.range.solid = (x, y, z) => this.obstacles.solidAt(x, y, z);
    setTurbulence(0.7); // light chop down low; tests run with 0

    this.aircraft = new Aircraft(specById(this.save.aircraft));
    this.aircraft.addExteriorLights(this.daylight.landingLight);
    this.scene.add(this.aircraft.model);
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);

    this.flightCam = new FlightCamera(window.innerWidth / window.innerHeight);
    this.minimap = new Minimap(this.gen);
    this.minimap.onWaypoint = (wp) => {
      if (!wp.name) wp.name = `WP${this.route.waypoints.length + 1}`;
      this.route.add(wp);
    };
    this.minimap.onUndo = () => this.route.removeLast();
    this.minimap.onClear = () => { this.route.clear(); this.screens.toast('FLIGHT PLAN CLEARED'); };
    this.minimap.onEngage = () => this.toggleNavEngage();
    this.screens = new Screens(this.save, touch);
    if (touch) this.touch = new TouchControls(this.input);
    this.wireCameraPointer();

    const params = new URLSearchParams(location.search);
    this.autoFly = params.get('autofly') === '1';
    // ?morphhold=1 — freeze chunks at geomorph start (debug: any visible tile
    // seam in a still frame = the pop players would see at tile arrival)
    this.terrain.morphHold = params.get('morphhold') === '1';
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
    s.onWorld = (w) => {
      // a world swap regenerates literally everything — a clean reload is
      // simpler and leak-proof compared to disposing the whole scene graph
      this.save.world = w;
      persist(this.save);
      location.reload();
    };
    s.onTod = (t) => {
      // same story: the palette threads through shaders, materials and
      // lights fixed at construction — reload and come back re-lit
      this.save.tod = t;
      persist(this.save);
      location.reload();
    };
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
        case 'Quote': this.apAdjust('vs', 1); break;
        case 'Semicolon': this.apAdjust('vs', -1); break;
      }
    });

    const pauseAction = (): void => {
      if (this.minimap.expanded) { this.toggleNav(); return; } // ESC closes the chart first
      if (this.state === 'flying') this.pause();
      else if (this.state === 'paused') this.resume();
    };
    this.input.on('pause', pauseAction);
    this.input.on('nav', () => this.toggleNav());
    this.input.on('navzoomin', () => this.minimap.zoom(-1));
    this.input.on('navzoomout', () => this.minimap.zoom(1));
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
      if (this.aircraft.spec.flapsCl <= 0) {
        this.input.resetFlaps();
        this.screens.toast('NO FLAPS FITTED');
        return;
      }
      const f = Math.round(this.input.controls.flaps * 3);
      this.screens.toast(f === 0 ? 'FLAPS UP' : `FLAPS ${f}`);
    });
    this.input.on('reset', () => {
      if (this.state === 'flying' || this.state === 'crashed') this.startFlight();
    });
    this.input.on('autopilot', () => this.toggleAutopilot());
    this.input.on('airbrake', () => this.toggleAirbrake());
    this.input.on('enginecut', () => this.toggleEngineCut());
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
      this.touch.onNav = () => this.toggleNav();
      this.touch.onPause = pauseAction;
      this.touch.onEngineCut = () => this.toggleEngineCut();
    }
    this.minimap.onCloseNav = () => {
      if (this.minimap.expanded) this.toggleNav();
    };
  }

  /** Open/close the expanded planning chart (the onboard computer). */
  private toggleNav(): void {
    if (this.state !== 'flying' && !this.minimap.expanded) return;
    this.minimap.setExpanded(!this.minimap.expanded);
    this.minimap.show(true);
  }

  /** ENGAGE NAV: autopilot flies the flight plan, sequencing waypoints. */
  private toggleNavEngage(): void {
    const st = this.aircraft.state;
    if (this.route.engaged) {
      this.route.engaged = false;
      this.screens.toast('NAV DISENGAGED');
      return;
    }
    if (this.route.isEmpty) {
      this.screens.toast('NO FLIGHT PLAN — CLICK THE CHART TO ADD WAYPOINTS');
      return;
    }
    if (st.onGround) {
      this.screens.toast('AIRBORNE FIRST — THEN ENGAGE NAV');
      return;
    }
    if (this.route.complete) this.route.arm();
    this.route.engaged = true;
    if (!this.autopilot.engaged) this.toggleAutopilot();
    this.screens.toast('NAV ENGAGED — AUTOPILOT TRACKING FLIGHT PLAN');
  }

  private toggleAutopilot(): void {
    if (this.state !== 'flying') return;
    const st = this.aircraft.state;
    if (this.autopilot.engaged) {
      this.autopilot.disengage();
      this.screens.setApPanel(false);
      this.screens.toast('AUTOPILOT OFF');
    } else if (!st.onGround) {
      const heli = this.aircraft.spec.engine === 'heli';
      this.autopilot.engage(st, this.input.controls.throttle, heli ? 0 : 30);
      const ft = Math.round(st.pos.y * M_TO_FT / 100) * 100;
      this.screens.toast(
        heli && st.airspeed < 4 ? `AP HOVER HOLD ${ft} FT` : `AP HOLDING ${ft} FT`, 2200,
      );
    } else {
      this.screens.toast('AP UNAVAILABLE ON THE GROUND');
    }
  }

  /** Slew an autopilot target bug: hdg ±5°, alt ±500 ft, spd ±10 kt, V/S ±200 fpm. */
  private apAdjust(kind: 'hdg' | 'alt' | 'spd' | 'vs', dir: number): void {
    if (!this.autopilot.engaged) return;
    if (kind === 'hdg') this.autopilot.adjustHeading(dir * 5 * Math.PI / 180);
    else if (kind === 'alt') this.autopilot.adjustAltitude(dir * 152.4);
    else if (kind === 'vs') {
      const heli = this.aircraft.spec.engine === 'heli';
      this.autopilot.adjustVs(dir * 1.016, heli ? 7.62 : 25.4); // cap 1,500 / 5,000 fpm
    } else this.autopilot.adjustSpeed(dir * 5.144, this.aircraft.spec.vne * 0.92);
  }

  /** Practice engine failure (helicopter only): X cuts and relights. */
  private toggleEngineCut(): void {
    if (this.state !== 'flying' || this.aircraft.spec.engine !== 'heli') return;
    const c = this.input.controls;
    c.engineCut = !c.engineCut;
    this.sound.gearThunk();
    this.screens.toast(
      c.engineCut
        ? 'ENGINE FAILURE — COLLECTIVE DOWN, AUTOROTATE'
        : 'ENGINE RELIGHT — GOVERNOR SPOOLING NR',
      2600,
    );
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
      // phones run dpr 3 — capping lower upscales shorelines into sub-pixel
      // scintillation (edge twinkle), so medium renders at up to 2
      this.renderer.setPixelRatio(Math.min(dpr, 2));
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
    // circular streaming holds ~27% fewer chunks than the old square at the
    // same radius — spent here on wider high-altitude reach, growing with
    // altitude tiers so 20k ft still has terrain streaming ahead of the seam
    this.terrain.altBonusTiers =
      q === 'low' ? [0, 4, 5, 6] : q === 'medium' ? [0, 7, 9, 11] : [0, 8, 11, 14];
    // far horizon shell density, how far each LOD reaches (in rings), and
    // how far the fog may open up at altitude (cap stays well inside the
    // shell so its edge is never visible)
    const t = this.terrain;
    // shell cellSize MUST share a small LCM with CHUNK_SIZE (900): the
    // recenter grid is that LCM, so 380/460/680-m cells made the horizon
    // lurch forward in 17–30 km jumps ("deficit builds, then the edge pops
    // in one go") — 450/600 recenter every 900–1800 m, imperceptibly
    if (q === 'low') {
      t.configureFar(90, 600); // 54 km shell
      [t.ultraRing, t.fineRing, t.midRing, t.fineRingHigh, t.midRingHigh] = [-1, 2, 5, 3, 6];
      this.fogFarCap = 15000;
    } else if (q === 'medium') {
      t.configureFar(150, 450); // 67.5 km shell
      [t.ultraRing, t.fineRing, t.midRing, t.fineRingHigh, t.midRingHigh] = [0, 3, 6, 4, 7];
      this.fogFarCap = 23000;
    } else {
      t.configureFar(180, 450); // 81 km shell
      [t.ultraRing, t.fineRing, t.midRing, t.fineRingHigh, t.midRingHigh] = [1, 4, 6, 5, 9];
      this.fogFarCap = 30000;
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
    this.aircraft.addExteriorLights(this.daylight.landingLight);
    this.scene.add(this.aircraft.model);
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    this.sound.uiClick();
    persist(this.save);
  }

  /**
   * Roll the flight's wind. Free flight gets a light random breeze (3–15 kt)
   * so no two approaches are the same; races and autofly smoke tests stay
   * calm so times and trajectories are comparable. ?wind=hdg,kt overrides.
   */
  private rollWind(): void {
    const p = new URLSearchParams(location.search).get('wind');
    if (p) {
      const [h, k] = p.split(',').map(Number);
      this.windFromDeg = ((h || 0) % 360 + 360) % 360;
      this.windKt = Math.max(0, k || 0);
    } else if (this.save.mode === 'race' || this.autoFly) {
      this.windFromDeg = 0;
      this.windKt = 0;
    } else {
      this.windFromDeg = Math.floor(Math.random() * 360);
      this.windKt = Math.round(3 + Math.random() * 12);
    }
    const ms = this.windKt / MS_TO_KT;
    const rad = (this.windFromDeg * Math.PI) / 180;
    // wind vector points TOWARD from-heading + 180°
    setWind(-Math.sin(rad) * ms, Math.cos(rad) * ms);
    this.airport.setWind(rad, this.windKt);
  }

  private startFlight(): void {
    this.sound.init();
    this.input.resetForFlight();
    this.rollWind();
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    this.sound.setEngineKind(this.aircraft.spec.engine);
    this.flightCam.set('chase');
    this.stats = { flightTime: 0, distanceKm: 0, maxAltFt: 0, maxSpdKt: 0 };
    this.raceTime = 0;
    this.raceRunning = false;
    this.wasOnGround = true;
    this.range.reset();
    if (this.save.mode === 'race') {
      this.rings.start(this.aircraft.state.pos);
    } else {
      this.rings.stop();
    }
    this.autopilot.disengage();
    this.ilsTuned = null;
    this.ilsTimer = 0;
    this.state = 'flying';
    this.screens.show(null);
    this.hud.visible = true;
    this.minimap.show(true);
    this.touch?.show(true);
    this.touch?.setThrottle(0);
    this.screens.toast(
      this.save.mode === 'race'
        ? 'RING RUSH — GO!'
        : this.windKt > 0
          ? `CLEARED FOR TAKEOFF — WIND ${String(this.windFromDeg).padStart(3, '0')}° AT ${this.windKt} KT`
          : 'CLEARED FOR TAKEOFF',
      2800,
    );
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

    // stream the world around a point led ahead of the aircraft (~5 s of
    // travel, capped at 5 chunks): chunks in the direction of flight reach
    // full resolution well before you arrive, not as you cross each ring
    const agl = st.pos.y - this.gen.heightAt(st.pos.x, st.pos.z);
    const leadX = st.pos.x + clamp(st.vel.x * 5, -4500, 4500);
    const leadZ = st.pos.z + clamp(st.vel.z * 5, -4500, 4500);
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
    this.airport.update(this.simTime, st.pos.x, st.pos.z, st.pos.y);
    // NPC traffic: parked aircraft everywhere; the airborne layer stays out
    // of Ring Rush so the course reads clean
    this.traffic.update(dt, st.pos.x, st.pos.z, this.simTime, !this.rings.active);

    // coarse-depth fallback (touch + low, no log buffer): step the near
    // plane out with altitude to reclaim precision. Discrete bands with
    // hysteresis — a continuously sliding near plane re-quantises the depth
    // buffer every frame, which itself reads as shoreline flicker.
    const cam = this.flightCam.camera;
    if (this.coarseDepth && (this.state === 'flying' || this.state === 'crashed')) {
      const up = [500, 1050, 1700];
      const down = [340, 820, 1400];
      if (this.nearIdx < 3 && agl > up[this.nearIdx]) this.nearIdx++;
      else if (this.nearIdx > 0 && agl < down[this.nearIdx - 1]) this.nearIdx--;
    } else {
      this.nearIdx = 0;
    }
    const nearWant = [1, 3, 6, 10][this.nearIdx]; // cap below chase-cam range
    if (cam.near !== nearWant) {
      cam.near = nearWant;
      cam.updateProjectionMatrix();
    }

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
        // &hdg=deg — point the takeoff somewhere specific (smoke tests)
        const hdgP = Number(new URLSearchParams(location.search).get('hdg') ?? NaN);
        if (Number.isFinite(hdgP)) {
          this.aircraft.state.quat.setFromEuler(
            new THREE.Euler(this.aircraft.spec.groundPitch, (-hdgP * Math.PI) / 180, 0, 'YXZ'),
          );
        }
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
          // &nav=1 — open the planning chart (smoke test)
          if (new URLSearchParams(location.search).get('nav') === '1') this.toggleNav();
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

    // NAV mode: sequence waypoints and slave the AP heading bug to the route
    if (this.route.engaged && !this.rings.active) {
      const passed = this.route.sequence(st.pos.x, st.pos.z);
      if (passed) this.screens.toast(`${passed.name} — WAYPOINT PASSED`, 1800);
      const want = this.route.desiredHeading(st.pos.x, st.pos.z);
      if (want === null) {
        this.route.engaged = false;
        this.screens.toast('FLIGHT PLAN COMPLETE — HOLDING HEADING', 3000);
      } else if (this.autopilot.engaged) {
        this.autopilot.targetHdg = want;
      }
    }

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
          `${Math.round(this.autopilot.targetVs * 196.85 / 100) * 100} FPM`,
        );
      }
    }

    this.aircraft.update(this.input.controls, dt, this.heightFn);

    // ILS receiver: retune to the best approach ahead about once a second
    this.ilsTimer -= dt;
    if (this.ilsTimer <= 0) {
      this.ilsTimer = 1;
      this.gen.airfieldsNear(st.pos.x, st.pos.z, 36000, this.ilsFieldScratch);
      this.ilsTuned = tuneIls(
        this.ilsFieldScratch, st.pos.x, st.pos.z, st.pos.y, st.heading,
        this.ilsTuned, this.ilsScratch,
      );
    }

    // buildings, trees and rock pinnacles are as solid as the terrain
    this.obstacles.warm(st.pos.x, st.pos.z);
    if (!st.crashed && !st.onGround) {
      const wall = this.obstacles.hit(st.pos.x, st.pos.y, st.pos.z, 2.5);
      if (wall) crash(st, wall);
    }

    // cannon: brake control doubles as the trigger once airborne
    const firing =
      !!this.aircraft.spec.gun && !st.onGround && !st.crashed && this.input.controls.brakes;
    this.range.update(dt, st, firing);

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
    const heli = this.aircraft.spec.engine === 'heli';
    if (heli && st.vrs > 0.25) this.flightCam.addShake(0.004 * st.vrs); // ring buffet
    this.sound.update(
      this.input.controls.throttle, st.thrustFrac, st.airspeed, st.stalled, this.simTime,
      heli ? st.rotorRpm : 1,
      heli && !st.onGround && st.rotorRpm < 0.9, // low-rotor-RPM horn
    );
    this.hud.draw(this.hudData(), dt);
    this.minimap.update(
      st.pos.x, st.pos.z, st.heading, this.rings, this.route,
      Math.hypot(st.vel.x, st.vel.z),
    );

    this.touch?.syncState(
      this.input.controls.gearDown,
      this.input.controls.flaps,
      this.aircraft.spec.retractableGear,
      this.autopilot.engaged,
      this.input.controls.airbrake,
      this.aircraft.spec.airbrakeCd > 0,
      this.aircraft.spec.flapsCl > 0,
      this.aircraft.spec.engine === 'heli',
      this.input.controls.engineCut === true,
    );
    this.screens.setPortraitWarning(true);
  }

  private applyAutoFly(): void {
    const st = this.aircraft.state;
    const c = this.input.controls;
    c.throttle = 1;
    const radar = st.pos.y - this.gen.heightAt(st.pos.x, st.pos.z);
    if (this.aircraft.spec.engine === 'heli') {
      // vertical climb-out, then nose over to accelerate into cruise
      c.pitch = radar > 30 && st.airspeed < 40 ? -0.5 : 0;
      c.roll = 0;
    } else {
      const spec = this.aircraft.spec;
      const rotateSpeed = Math.sqrt((2 * spec.mass * 9.81) /
        (1.225 * spec.wingArea * 1.1)) * 0.85;
      // transport wing loadings need takeoff flap and a proper rotation
      const heavy = spec.mass / spec.wingArea > 400;
      if (st.onGround && heavy) c.flaps = 2 / 3;
      const pull = Math.min(0.85, 0.3 + spec.mass / (spec.wingArea * 1500));
      c.pitch = st.airspeed > rotateSpeed && st.pitchAngle < 0.14 ? pull : 0;
      c.roll = 0;
      if (!st.onGround && radar > 150) c.flaps = 0;
    }
    if (!st.onGround && radar > 50) c.gearDown = false;
    const apDbg = (this.airport as unknown as { built: Map<string, { aeroBeacon: unknown }> }).built;
    let beacons = 0;
    for (const f of apDbg.values()) if (f.aeroBeacon) beacons++;
    document.title =
      `v=${st.airspeed.toFixed(1)} x=${st.pos.x.toFixed(0)} y=${st.pos.y.toFixed(1)} z=${st.pos.z.toFixed(0)} ` +
      `gnd=${st.onGround} thr=${c.throttle.toFixed(2)} tf=${st.thrustFrac.toFixed(2)} ` +
      `pit=${st.pitchAngle.toFixed(2)} crash=${st.crashed} flds=${apDbg.size} bcn=${beacons}`;
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
      wind: this.windKt > 0 ? { fromDeg: this.windFromDeg, kt: this.windKt } : null,
      heli: spec.engine === 'heli'
        ? {
            trq: st.thrustFrac,
            nr: st.rotorRpm,
            vrs: st.vrs > 0.25,
            lowRpm: st.rotorRpm < 0.9 && !st.onGround,
            engineOut: c.engineCut === true,
          }
        : null,
      gun: spec.gun
        ? {
            ammo: this.range.ammo,
            firing: !st.onGround && c.brakes,
            hits: this.range.hits,
            targets: this.range.total,
          }
        : null,
      ils: (() => {
        // guidance shows once airborne (or rolling out after touchdown on
        // the tuned runway); races keep the HUD clear for the gates
        if (!this.ilsTuned || race || (st.onGround && st.airspeed < 3)) return null;
        const d = solveIls(this.ilsTuned, st.pos.x, st.pos.y, st.pos.z);
        if (d.toGo > 30000 || d.toGo < -this.ilsTuned.length) return null;
        return {
          name: d.name,
          ident: d.ident,
          dme: d.dme,
          locDev: d.locDev,
          gsDev: d.gsDev,
          locFull: LOC_FULL_SCALE,
          gsFull: GS_FULL_SCALE,
        };
      })(),
      nav: (() => {
        if (race || !this.route.engaged) return null;
        const wp = this.route.target();
        if (!wp) return null;
        const dist = distanceTo(st.pos.x, st.pos.z, wp.x, wp.z);
        const gs = Math.hypot(st.vel.x, st.vel.z);
        return {
          name: wp.name,
          distance: dist,
          bearing: wrapAngle(bearingTo(st.pos.x, st.pos.z, wp.x, wp.z) - st.heading),
          eteSec: gs > 2 ? dist / gs : null,
        };
      })(),
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
