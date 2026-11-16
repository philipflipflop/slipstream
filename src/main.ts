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
import { weatherById, weatherVisibility, beneath, WEATHERS, WeatherPreset } from './world/weather';
import { CloudDeckView, Rain } from './world/clouds';
import { TerrainManager, CHUNK_SIZE } from './world/terrain';
import { visibility, GROUND_VIEW, HAZE_NEAR } from './world/lod';
import { Water, WATER_SURFACE_Y } from './world/water';
import { Sky } from './world/sky';
import { Airport } from './world/airport';
import { RingCourse, RING_COUNT } from './world/rings';
import { Traffic, TrafficBlip } from './world/traffic';
import { Tower, RadioTraffic } from './nav/radio';
import { GunneryRange } from './combat/range';
import { ObstacleField } from './world/obstacles';
import { setTurbulence, setWind, crash, approachSpeed, stallSpeed, bestGlideSpeed } from './aircraft/flightModel';
import { Route, bearingTo, distanceTo } from './nav/route';
import {
  IlsApproach, tuneIls, solveIls, approachesOf, LOC_FULL_SCALE, GS_FULL_SCALE,
} from './nav/ils';
import { runwayUnder, scoreLanding, LandingScore, RunwayContact } from './nav/landing';
import { Job, jobsFrom, scoreJob, atField, Comfort } from './nav/jobs';
import { Aircraft } from './aircraft/aircraft';
import { specById } from './aircraft/catalog';
import { Autopilot } from './aircraft/autopilot';
import { InputManager } from './input/input';
import { TouchControls, isTouchDevice } from './input/touch';
import { FlightCamera } from './camera';
import { SoundEngine } from './audio/sound';
import { Hud, HudData } from './ui/hud';
import { Minimap } from './ui/minimap';
import { Screens, DebriefStats, LandingReport } from './ui/screens';
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
  /** the wind as a velocity (same vector the flight model gets), m/s */
  private windVX = 0;
  private windVZ = 0;
  private wx: WeatherPreset;
  private tower = new Tower();
  /** the job being flown (Charter mode), and how it is going */
  private job: Job | null = null;
  private jobTime = 0;
  private jobComfort = new Comfort();
  private jobLanding: number | null = null;
  private jobSerial = 0;
  private jobLineT = 0;
  private jobWrong = false;
  private blipBuf: TrafficBlip[] = [];
  private radioBuf: RadioTraffic[] = [];
  private toweredCache = new Map<string, boolean>();
  private deck: CloudDeckView;
  private rain: Rain | null = null;
  /** clear-air visibility, smoothed — the weather acts on top of it, at once */
  private hazeFar = 7000;
  private cloudCol = new THREE.Color();

  // ILS receiver: auto-tunes the best runway end ahead about once a second
  // and then HOLDS the station like a real tuned radio; I toggles it off
  private ilsTuned: IlsApproach | null = null;
  private ilsOn = true;
  private ilsTimer = 0;
  private ilsFieldScratch: AirfieldDef[] = [];
  private ilsScratch: IlsApproach[] = [];

  // landing grading: every runway touchdown after a real airborne segment
  // is scored (sink / centreline / touchdown zone); Final Approach mode ends
  // with the debrief once the aircraft has stopped
  private airMaxAgl = 0;      // highest AGL since the wheels last left the ground
  private touchedDown = false;
  private stopTimer = 0;
  private lastLanding: { score: LandingScore; rw: RunwayContact } | null = null;
  private landingFields: AirfieldDef[] = [];
  private landingScratch: IlsApproach[] = [];

  // master warning (terrain ahead / gear / overspeed), latched briefly
  private warn: string | null = null;
  private warnHold = 0;
  private lastApprPhase = 'off';
  private autoArmed = false; // autofly approach smoke test has armed APPR

  private daylight: DaylightPreset;
  private lodTint = false;
  private fps = 0;
  private fpsFrames = 0;
  private fpsT0 = 0;

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

    // weather: ?wx= overrides the saved choice
    const wxParam = new URLSearchParams(location.search).get('wx');
    this.wx = weatherById(wxParam && WEATHERS.some((w) => w.id === wxParam) ? wxParam : this.save.wx);
    this.save.wx = this.wx.id;

    // graphics quality: ?q=low|medium|high overrides the saved choice (smoke tests)
    const qParam = new URLSearchParams(location.search).get('q');
    if (qParam === 'low' || qParam === 'medium' || qParam === 'high') this.save.quality = qParam;

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

    this.sky = new Sky(this.scene, touch ? 26 : 56, this.daylight, this.wx);
    this.deck = new CloudDeckView(this.scene, this.wx, this.sky.fogColor, this.sky.cloudLit, this.sky.cloudShade);
    if (this.wx.rain > 0) this.rain = new Rain(this.scene, touch ? 500 : 1500, new THREE.Color(0.78, 0.82, 0.88));
    this.scene.fog = new THREE.Fog(this.sky.sceneFogColor, 2500, 7000);
    this.scene.background = null; // dome handles it

    // terrain cuts itself off at the waterline; the water sheet fills in
    // (water.ts — the shoreline is never left to the depth buffer)
    this.terrain = new TerrainManager(this.scene, this.gen, this.daylight.windowGlow, WATER_SURFACE_Y);
    this.water = new Water(this.scene, this.sky.fogColor, this.sky.sunDir, this.coarseDepth, this.daylight);
    this.airport = new Airport(this.scene, this.gen, this.daylight.landingLight);
    this.rings = new RingCourse(this.scene, this.gen);
    this.traffic = new Traffic(this.scene, this.gen);
    this.traffic.onPlayerBlock = (field) => {
      if (this.state !== 'flying') return;
      this.sound.radio();
      this.screens.toast(`${field.replace(/ INTL$/, '')} TOWER — TRAFFIC ON FINAL IS GOING AROUND: YOU ARE ON THE ACTIVE RUNWAY`, 5000);
    };
    this.obstacles = new ObstacleField(this.gen);
    this.range = new GunneryRange(this.scene, this.gen);
    this.range.onHit = (hits, total) => this.screens.toast(`TARGET DOWN — ${hits}/${total}`);
    this.range.onClear = () => this.screens.toast('RANGE CLEAR — ALL TARGETS DESTROYED');
    this.range.solid = (x, y, z) => this.obstacles.solidAt(x, y, z);
    setTurbulence(this.wx.turb); // light chop down low in fair weather; tests run with 0

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
    // smoke tests drive the sim from the DevTools console (see CLAUDE.md)
    if (this.autoFly) (window as unknown as { __sim: unknown }).__sim = this;
    // ?lodtint=1 — tint chunks by LOD level, darkened by how far each vertex
    // is collapsed toward its parent look (debug: the distance blend bands
    // become rings; level boundaries must sit where fine = dark, coarse = lit)
    this.lodTint = params.get('lodtint') === '1';
    this.terrain.lodTint = this.lodTint;
    this.terrain.logLate = params.get('lodlog') === '1';
    // ?shellonly=1 — hide all chunks, render the shell everywhere (debug)
    this.terrain.shellOnly = params.get('shellonly') === '1';
    if (params.get('mode') === 'race') this.save.mode = 'race';
    if (params.get('mode') === 'approach') this.save.mode = 'approach';
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
    s.onFly = () => (this.save.mode === 'job' ? this.openJobs() : this.startFlight());
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
    s.onWeather = (w) => {
      // the weather picks the sky's palette, the cloud deck and the light
      this.save.wx = w;
      persist(this.save);
      location.reload();
    };
    s.onSettings = () => { this.applyQuality(this.save.quality); this.applySettings(); persist(this.save); };
    s.onResume = () => {
      if (this.state === 'paused') this.resume();
      else if (this.state === 'flying') this.pause();
    };
    s.onRestart = () => {
      this.sound.uiClick();
      if (this.save.mode === 'job') this.openJobs();
      else this.startFlight();
    };
    s.onHangar = () => this.toHangar();
    s.onApAdjust = (kind, dir) => this.apAdjust(kind, dir);
    s.onApproach = () => this.toggleApproach();

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
      // squat switch: the lever only moves in flight — never on the ground,
      // in a menu or while paused (a gear-up touchdown is now a write-off)
      const c = this.input.controls;
      if (this.state !== 'flying' || !this.aircraft.spec.retractableGear || this.aircraft.state.onGround) {
        const blocked = this.state === 'flying' && this.aircraft.spec.retractableGear && !c.gearDown;
        c.gearDown = true;
        if (blocked) this.screens.toast('GEAR LOCKED DOWN — WEIGHT ON WHEELS');
        return;
      }
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
    this.input.on('approach', () => this.toggleApproach());
    this.input.onPadConnected = () => {
      if (this.state === 'flying') this.screens.toast('GAMEPAD CONNECTED — SEE CONTROLS FOR THE LAYOUT', 2600);
    };
    this.input.on('airbrake', () => this.toggleAirbrake());
    this.input.on('enginecut', () => this.toggleEngineCut());
    this.input.on('hud', () => {
      if (this.state !== 'flying') return;
      const mode = this.hud.cycleMode();
      this.screens.toast(mode === 'full' ? 'HUD FULL' : mode === 'min' ? 'HUD MINIMAL' : 'HUD OFF');
    });
    this.input.on('ils', () => {
      if (this.state !== 'flying') return;
      this.ilsOn = !this.ilsOn;
      if (!this.ilsOn) this.ilsTuned = null;
      this.ilsTimer = 0;
      this.screens.toast(this.ilsOn ? 'ILS AUTO — TUNES THE RUNWAY AHEAD' : 'ILS OFF', 2200);
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

  /**
   * APPR: couple the autopilot to the tuned ILS — localizer, glideslope,
   * flare, rollout (see Autopilot.flyApproach). Pressing it again drops
   * back to plain heading/altitude hold.
   */
  private toggleApproach(): void {
    if (this.state !== 'flying') return;
    const st = this.aircraft.state;
    if (this.aircraft.spec.engine === 'heli') {
      this.screens.toast('APPR IS FIXED-WING ONLY — FLY THE DIAMONDS');
      return;
    }
    if (this.autopilot.approach) {
      this.autopilot.cancelApproach(st);
      this.screens.toast('APPR OFF — HOLDING HEADING AND ALTITUDE', 2200);
      return;
    }
    if (st.onGround) {
      this.screens.toast('AP UNAVAILABLE ON THE GROUND');
      return;
    }
    if (!this.ilsTuned) {
      this.screens.toast('NO ILS TUNED — POINT AT A RUNWAY FIRST', 2400);
      return;
    }
    if (!this.autopilot.engaged) this.autopilot.engage(st, this.input.controls.throttle, 30);
    this.autopilot.armApproach(this.ilsTuned);
    this.route.engaged = false;
    this.lastApprPhase = 'loc';
    this.screens.toast(`APPR ARMED — ILS ${this.ilsTuned.ident} ${this.ilsTuned.fieldName}`, 2600);
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

  /**
   * Practice engine failure: X. Helicopter — cuts and relights. Fixed-wing —
   * singles lose the engine; twins lose No.1 (the left one) first, then
   * both; one more press relights everything.
   */
  private toggleEngineCut(): void {
    if (this.state !== 'flying') return;
    const c = this.input.controls;
    const spec = this.aircraft.spec;
    if (spec.engine !== 'heli') {
      const n = spec.engines ?? 1;
      c.enginesOut = ((c.enginesOut ?? 0) + 1) % (n + 1);
      this.sound.gearThunk();
      const glide = Math.round(bestGlideSpeed(spec, this.aircraft.state.pos.y) * MS_TO_KT);
      this.screens.toast(
        c.enginesOut === 0
          ? (n > 1 ? 'ENGINES RELIT' : 'ENGINE RELIT')
          : c.enginesOut < n
            ? 'ENGINE 1 FAILURE — RIGHT RUDDER, HOLD THE SPEED UP'
            : `${n > 1 ? 'BOTH ENGINES OUT' : 'ENGINE FAILURE'} — BEST GLIDE ${glide} KT, PICK A FIELD`,
        4200,
      );
      return;
    }
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
      this.terrain.buildBudget = 1;
    } else if (q === 'medium') {
      // phones run dpr 3 — capping lower upscales shorelines into sub-pixel
      // scintillation (edge twinkle), so medium renders at up to 2
      this.renderer.setPixelRatio(Math.min(dpr, 2));
      this.renderer.shadowMap.enabled = true;
      this.sky.setShadows(true);
      this.terrain.buildBudget = 2;
    } else {
      this.renderer.setPixelRatio(Math.min(dpr, 2));
      this.renderer.shadowMap.enabled = true;
      this.sky.setShadows(true);
      this.terrain.buildBudget = 2;
    }
    // LOD reach and load radius per quality live in world/lod.ts (detail is
    // a continuous function of distance and altitude — no rings, no tiers)
    const t = this.terrain;
    t.setQuality(q);
    // (shell lattices and the altitude haze cap are in lod.ts SHELL_PRESETS)
    // ground-level visibility the fog is tuned to, m
    this.baseFogFar = GROUND_VIEW[q];
    this.baseFogNear = this.baseFogFar * HAZE_NEAR;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.baseFogNear;
    fog.far = this.baseFogFar;
    this.hazeFar = this.baseFogFar;
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
  private rollWind(appr: IlsApproach | null = null): void {
    const p = new URLSearchParams(location.search).get('wind');
    if (p) {
      const [h, k] = p.split(',').map(Number);
      this.windFromDeg = ((h || 0) % 360 + 360) % 360;
      this.windKt = Math.max(0, k || 0);
    } else if (appr && !this.autoFly) {
      // Final Approach: always something to fly — a head/crosswind from
      // 25–110° off the runway heading, either side (never a tailwind)
      const off = (25 + Math.random() * 85) * (Math.random() < 0.5 ? -1 : 1);
      const from = (appr.course * 180) / Math.PI + off;
      this.windFromDeg = Math.round(((from % 360) + 360) % 360);
      this.windKt = Math.round(Math.max(4, this.wx.wind[0]) + Math.random() * (Math.max(16, this.wx.wind[1]) - Math.max(4, this.wx.wind[0])) * (this.wx.wind[1] > 16 ? 1 : 0.75));
    } else if (this.save.mode === 'race' || this.autoFly) {
      this.windFromDeg = 0;
      this.windKt = 0;
    } else {
      // the weather sets how hard it blows
      this.windFromDeg = Math.floor(Math.random() * 360);
      this.windKt = Math.round(this.wx.wind[0] + Math.random() * (this.wx.wind[1] - this.wx.wind[0]));
    }
    const ms = this.windKt / MS_TO_KT;
    const rad = (this.windFromDeg * Math.PI) / 180;
    // wind vector points TOWARD from-heading + 180°
    this.windVX = -Math.sin(rad) * ms;
    this.windVZ = Math.cos(rad) * ms;
    setWind(-Math.sin(rad) * ms, Math.cos(rad) * ms);
    this.traffic.setWind(-Math.sin(rad) * ms, Math.cos(rad) * ms);
    this.airport.setWind(rad, this.windKt);
  }

  /**
   * Charter mode: the job board of the field you are at. Picking a job puts
   * you on its runway with the destination in the flight plan; delivering it
   * makes the destination your new base, with a fresh board.
   */
  private openJobs(): void {
    this.sound.init();
    this.job = null;
    this.state = 'menu';
    this.sound.silence();
    this.autopilot.disengage();
    this.screens.setApPanel(false);
    this.hud.visible = false;
    this.hud.clear();
    this.minimap.show(false);
    this.touch?.show(false);
    this.rings.stop();
    this.screens.setJobLine(null);
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    const spec = this.aircraft.spec;
    const jobs = jobsFrom(this.gen, this.spawnField, spec, this.jobSerial);
    const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    this.screens.showJobs(
      this.spawnField.name, spec.name,
      jobs.map((j) => ({
        kind: j.kind, title: j.title, to: j.to.name, km: j.distance / 1000, bearing: j.bearing,
        par: mmss(j.par), pay: j.pay,
        note: j.to.intl ? 'international' : j.to.major ? 'regional field' : `${Math.round(j.to.length)} m strip`,
      })),
      this.save.credits,
      (i) => {
        this.sound.uiClick();
        this.job = jobs[i];
        this.startFlight();
      },
    );
  }

  /** Per-frame job bookkeeping: the clock, the ride, the strip, the arrival. */
  private stepJob(dt: number): void {
    const job = this.job;
    if (!job) return;
    const st = this.aircraft.state;
    this.jobTime += dt;
    this.jobComfort.step(dt, st.gForce, st.rollAngle, st.onGround);
    const km = Math.hypot(job.to.x - st.pos.x, job.to.z - st.pos.z) / 1000;
    const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    if ((this.jobLineT -= dt) <= 0) {
      this.jobLineT = 0.25;
      this.screens.setJobLine(
        `${job.title} → ${job.to.name} · ${km.toFixed(km < 10 ? 1 : 0)} KM · ${mmss(this.jobTime)} / PAR ${mmss(job.par)}` +
        (job.comfort ? ` · RIDE ${Math.round(this.jobComfort.value * 100)}%` : ''),
      );
    }
    // delivered once you are down and stopped on the destination field
    if (this.touchedDown && st.onGround && Math.hypot(st.vel.x, st.vel.z) < 1.2) {
      this.stopTimer += dt;
      if (this.stopTimer > 1.2) {
        if (atField(job.to, st.pos.x, st.pos.z)) {
          this.finishJob();
        } else if (!this.jobWrong) {
          this.jobWrong = true;
          this.screens.toast(`THIS IS NOT ${job.to.name} — ${km.toFixed(0)} KM TO GO`, 4200);
        }
      }
    } else {
      this.stopTimer = 0;
      if (!st.onGround) this.jobWrong = false;
    }
  }

  private finishJob(): void {
    const job = this.job;
    if (!job) return;
    const heli = this.aircraft.spec.engine === 'heli';
    // fixed-wing: the fee expects wheels on a runway (no grade = no credit
    // for the landing); helicopters are not graded
    const landing = heli ? null : this.jobLanding ?? 0;
    const res = scoreJob(job, { time: this.jobTime, landing, comfort: this.jobComfort.value });
    this.save.credits += res.pay;
    this.save.jobs++;
    this.save.bestJob = Math.max(this.save.bestJob, res.pay);
    persist(this.save);
    // the destination is home now, with a fresh board
    this.spawnField = job.to;
    this.jobSerial++;
    this.job = null;
    this.state = 'victory';
    this.sound.silence();
    if (res.grade.startsWith('A')) this.sound.finishFanfare();
    this.autopilot.disengage();
    this.screens.setApPanel(false);
    this.hud.visible = false;
    this.hud.clear();
    this.minimap.show(false);
    this.minimap.setDestination(null);
    this.route.clear();
    this.touch?.show(false);
    this.screens.setJobLine(null);
    const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    this.screens.showJobDone({
      title: job.title, to: job.to.name, grade: res.grade, fee: job.pay, pay: res.pay,
      time: mmss(this.jobTime), par: mmss(job.par), timePct: res.timeMul,
      landing: heli ? 'not graded' : this.jobLanding === null ? 'off the runway' : `${Math.round(this.jobLanding)} / 100`,
      landPct: res.landMul,
      comfort: job.comfort ? `${Math.round(this.jobComfort.value * 100)}%` : null,
      comfortPct: res.comfortMul,
      credits: this.save.credits, jobs: this.save.jobs,
    }, this.debrief());
  }

  private startFlight(): void {
    this.sound.init();
    this.input.resetForFlight();
    // Final Approach: one of the spawn field's runway ends, a few
    // kilometres out, a little off the centreline and the glide path
    let appr: IlsApproach | null = null;
    if (this.save.mode === 'approach') {
      const apps: IlsApproach[] = [];
      approachesOf(this.spawnField, apps);
      appr = apps[this.autoFly ? 0 : Math.floor(Math.random() * apps.length)];
    }
    this.rollWind(appr);
    if (appr) {
      const spec = this.aircraft.spec;
      const heli = spec.engine === 'heli';
      const dist = heli ? 1800 : clamp(approachSpeed(spec, 2 / 3) * 70, 3500, 8000);
      const jitter = this.autoFly ? 0 : 1;
      const set = this.aircraft.resetOnApproach(
        appr, dist, 2 / 3,
        (Math.random() - 0.5) * dist * 0.05 * jitter,
        (Math.random() - 0.5) * 40 * jitter,
      );
      this.input.controls.throttle = set.throttle;
      this.input.setFlapsStep(Math.round(set.flaps * 3));
    } else {
      this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    }
    this.sound.setEngineKind(this.aircraft.spec.engine);
    this.flightCam.set('chase');
    this.stats = { flightTime: 0, distanceKm: 0, maxAltFt: 0, maxSpdKt: 0 };
    this.raceTime = 0;
    this.raceRunning = false;
    this.wasOnGround = !appr;
    this.airMaxAgl = appr ? 999 : 0;
    this.touchedDown = false;
    this.autoArmed = false;
    this.stopTimer = 0;
    this.lastLanding = null;
    this.warn = null;
    this.range.reset();
    if (this.save.mode === 'race') {
      this.rings.start(this.aircraft.state.pos);
    } else {
      this.rings.stop();
    }
    this.autopilot.disengage();
    this.tower.reset(appr || this.job ? 6.5 : 3);
    if (this.save.mode === 'job' && this.job) {
      // the destination goes into the flight plan and onto the map
      const to = this.job.to;
      this.route.clear();
      this.route.add({
        x: to.x, z: to.z, name: to.name,
        airfield: { code: to.code, heading: to.heading, elev: to.elev, length: to.length },
      });
      this.minimap.setDestination(to);
      this.jobTime = 0;
      this.jobComfort = new Comfort();
      this.jobLanding = null;
      this.jobWrong = false;
      this.jobLineT = 0;
    } else {
      this.job = null;
      this.minimap.setDestination(null);
      this.screens.setJobLine(null);
    }
    this.screens.setApPanel(false);
    this.ilsTuned = appr; // on final the receiver is already on the runway
    this.ilsTimer = appr ? 1 : 0;
    this.state = 'flying';
    this.screens.show(null);
    this.hud.visible = true;
    this.minimap.show(true);
    this.touch?.show(true);
    this.touch?.setThrottle(this.input.controls.throttle);
    const windTxt = this.windText();
    const sky = this.skyText();
    this.screens.toast(
      this.job
        ? `${this.job.title} → ${this.job.to.name} · ${(this.job.distance / 1000).toFixed(0)} KM ON ${String(this.job.bearing).padStart(3, '0')}° · ${windTxt}${sky}`
        : appr
        ? `FINAL APPROACH — RWY ${appr.ident} · ${windTxt}${sky} · LAND AND STOP`
        : this.save.mode === 'race'
        ? 'RING RUSH — GO!'
        : `CLEARED FOR TAKEOFF — ${windTxt}${sky}`,
      this.job ? 6000 : appr || sky ? 4600 : 2800,
    );
  }

  /** The wind as the tower says it. */
  private windText(): string {
    return this.windKt > 0
      ? `WIND ${String(this.windFromDeg).padStart(3, '0')}° AT ${this.windKt} KT`
      : 'WIND CALM';
  }

  /** The sky as the tower says it ("" in fair weather). */
  private skyText(): string {
    const d = this.wx.deck;
    if (!d) return '';
    if (this.wx.id === 'fog') return ` · FOG, VISIBILITY ${this.wx.vis} M`;
    const ft = (Math.round((d.base * M_TO_FT) / 100) * 100).toLocaleString('en-US');
    return ` · ${this.wx.rain > 0 ? 'RAIN, ' : ''}${d.cover < 0.99 ? 'BROKEN' : 'OVERCAST'} ${ft} FT`;
  }

  /** A field with a tower: internationals and the regional fields. */
  private isTowered(app: IlsApproach): boolean {
    let t = this.toweredCache.get(app.fieldName);
    if (t === undefined) {
      t = this.gen.airfieldsNear(app.thrX, app.thrZ, 6000, this.landingFields)
        .some((f) => f.name === app.fieldName && (f.intl === true || f.major === true));
      this.toweredCache.set(app.fieldName, t);
    }
    return t;
  }

  private pause(): void {
    if (this.state !== 'flying') return;
    this.state = 'paused';
    this.sound.silence();
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
    this.sound.silence();
    this.autopilot.disengage();
    this.state = 'menu';
    this.hud.visible = false;
    this.hud.clear();
    this.minimap.show(false);
    this.touch?.show(false);
    this.rings.stop();
    this.job = null;
    this.minimap.setDestination(null);
    this.screens.setJobLine(null);
    this.aircraft.resetOnRunway(this.heightFn, this.spawnField);
    this.screens.show('menu');
    this.screens.refreshMenu();
  }

  private onCrash(): void {
    this.state = 'crashed';
    this.crashTimer = 1.1;
    this.job = null; // undelivered
    this.screens.setJobLine(null);
    this.flightCam.addShake(1.4);
    this.sound.crashBoom();
    this.hud.visible = false;
    this.minimap.show(false);
    this.touch?.show(false);
  }

  /** Final Approach: stopped — grade the landing and show the debrief. */
  private finishApproach(): void {
    this.state = 'victory';
    this.sound.silence();
    this.autopilot.disengage();
    this.screens.setApPanel(false);
    this.hud.visible = false;
    this.hud.clear();
    this.minimap.show(false);
    this.touch?.show(false);
    const id = this.aircraft.spec.id;
    const wind = this.windKt > 0
      ? `${String(this.windFromDeg).padStart(3, '0')}° / ${this.windKt} KT`
      : 'CALM';
    const l = this.lastLanding;
    if (!l) {
      this.screens.showLanding({
        runway: '', score: 0, grade: '—', verdict: '', fpm: 0, cross: 0, past: 0, aim: 0,
        wind, best: this.save.bestLandings[id] ?? null, isRecord: false,
      }, this.debrief());
      return;
    }
    if (l.score.score >= 88) this.sound.finishFanfare();
    const report: LandingReport = {
      runway: `${l.rw.ident} · ${l.rw.fieldName}`,
      score: l.score.score, grade: l.score.grade, verdict: l.score.verdict,
      fpm: l.score.fpm, cross: l.rw.cross, past: l.rw.past, aim: l.score.aim,
      wind, best: this.save.bestLandings[id] ?? null,
      isRecord: this.landingWasRecord,
    };
    this.screens.showLanding(report, this.debrief());
  }

  private landingWasRecord = false;

  /**
   * Wheels just touched after a real airborne segment: find the runway
   * under them and grade the arrival. Hops and bounces (never above 15 m)
   * are not landings; neither is Ring Rush.
   */
  private gradeTouchdown(sink: number): void {
    const st = this.aircraft.state;
    const spec = this.aircraft.spec;
    const real = this.airMaxAgl > 15;
    this.airMaxAgl = 0;
    if (!real || this.rings.active) return;
    this.touchedDown = true;
    if (this.job) {
      this.jobComfort.touchdown(sink);
      this.jobLanding = null; // only a graded landing on the destination counts
    }
    // helicopters land anywhere — only Final Approach grades them
    if (spec.engine === 'heli' && this.save.mode !== 'approach') return;
    const gs = Math.hypot(st.vel.x, st.vel.z);
    const track = gs > 3 ? Math.atan2(st.vel.x, -st.vel.z) : st.heading;
    this.gen.airfieldsNear(st.pos.x, st.pos.z, 6000, this.landingFields);
    const rw = runwayUnder(this.landingFields, st.pos.x, st.pos.z, track, this.landingScratch);
    if (!rw) {
      this.lastLanding = null;
      if (sink < 1.6) this.screens.toast('SMOOTH — BUT THAT IS NOT A RUNWAY', 2400);
      return;
    }
    const score = scoreLanding({
      sink, cross: rw.cross, past: rw.past, length: rw.length, width: rw.width,
    });
    this.lastLanding = { score, rw };
    if (this.job && atField(this.job.to, st.pos.x, st.pos.z)) this.jobLanding = score.score;
    const prev = this.save.bestLandings[spec.id];
    this.landingWasRecord = prev === undefined || score.score > prev;
    if (this.landingWasRecord) this.save.bestLandings[spec.id] = score.score;
    this.save.landings++;
    persist(this.save);
    const side = Math.abs(rw.cross) < 0.5 ? 'ON THE LINE'
      : `${Math.abs(rw.cross).toFixed(0)} m ${rw.cross > 0 ? 'RIGHT' : 'LEFT'}`;
    this.screens.toast(
      `${score.grade === 'A+' ? 'GREASED IT' : 'LANDING'} · ${score.grade} (${score.score}) · ` +
      `${Math.round(score.fpm)} FPM · ${side} · ${Math.round(rw.past)} m IN`,
      4200,
    );
  }

  /**
   * Master warning. PULL UP: the flight path, held straight, meets terrain
   * (or the sea) within ~8 s — unless that is a configured arrival at an
   * airfield, or a slow deliberate off-field landing. TOO LOW — GEAR: low,
   * slow and descending with the wheels up. OVERSPEED: past VNE.
   */
  private checkWarnings(radar: number, dt: number): void {
    const st = this.aircraft.state;
    const spec = this.aircraft.spec;
    const c = this.input.controls;
    let w: string | null = null;
    if (!st.onGround && !st.crashed) {
      const heli = spec.engine === 'heli';
      const gearOk = c.gearDown || !spec.retractableGear;
      if (st.airspeed > spec.vne * 1.01) w = 'OVERSPEED';
      // slow, configured, gentle sink close to the ground = landing on purpose
      const settling = gearOk && radar < 70 && st.vel.y > -4.5 &&
        (heli ? st.airspeed < 26 : st.airspeed < stallSpeed(spec, 0) * 1.45);
      if (!settling) {
        for (let t = 2; t <= 8; t += 2) {
          const x = st.pos.x + st.vel.x * t;
          const z = st.pos.z + st.vel.z * t;
          const y = st.pos.y + st.vel.y * t - spec.gearHeight;
          if (y < Math.max(this.gen.heightAt(x, z), 0) + 8) {
            const arriving = gearOk && st.vel.y > -9 &&
              this.gen.airfieldsNear(x, z, 3200, this.landingFields).length > 0;
            if (!arriving) w = 'PULL UP';
            break;
          }
        }
      }
      if (!w && spec.retractableGear && !c.gearDown && radar < 150 && st.vel.y < -0.5 &&
          st.airspeed < stallSpeed(spec, 0) * 1.7) {
        w = 'TOO LOW — GEAR';
      }
    }
    // latch for half a second so a marginal trigger reads as a call, not a flicker
    if (w) {
      this.warn = w;
      this.warnHold = 0.5;
    } else if (this.warn) {
      this.warnHold -= dt;
      if (this.warnHold <= 0) this.warn = null;
    }
  }

  private finishRace(): void {
    this.state = 'victory';
    this.sound.silence();
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
    // frame-rate telemetry (autofly title)
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.fpsT0 >= 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsT0));
      this.fpsFrames = 0;
      this.fpsT0 = now;
    }
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

    // haze opens out with the streamed radius and, above that, with
    // altitude (lod.visibility): the horizon shell carries terrain out to
    // 90–216 km, so at cruise the eye reaches almost to the true horizon.
    // It never opens past what is actually built (viewLimit) — the rim of
    // the outermost shell must stay under full haze.
    const fog = this.scene.fog as THREE.Fog;
    const scale = this.terrain.fogScale();
    const farT = Math.min(
      visibility(this.baseFogFar * scale, agl, this.terrain.fogCap()),
      Math.max(this.terrain.viewLimit(), this.baseFogFar),
    );
    this.hazeFar = clamp(damp(this.hazeFar, farT, 0.8, dt), 200, 240000);
    // WEATHER acts on the clear-air figure, and at once (the damping above
    // is for the slow breathing of haze with height — entering cloud is not
    // slow): beneath the deck the weather's visibility, inside it a few
    // hundred metres, and the light and sky colour of wherever the eye is.
    const eye = this.flightCam.camera.position;
    const deckDef = this.wx.deck;
    const dens = this.deck.densityAt(eye.x, eye.y, eye.z);
    const under = beneath(deckDef, eye.y);
    fog.far = weatherVisibility(this.wx, this.hazeFar, eye.y, dens);
    fog.near = fog.far * (this.baseFogNear / this.baseFogFar) * (1 - 0.9 * dens);
    if (deckDef) {
      this.cloudCol.lerpColors(
        this.sky.cloudShade, this.sky.cloudLit,
        clamp((eye.y - deckDef.base) / (deckDef.top - deckDef.base), 0, 1),
      );
    }
    this.sky.setAir(under, dens, this.cloudCol);
    fog.color.copy(this.sky.sceneFogColor);
    this.water.setFogColor(this.sky.fogColor);
    this.terrain.hazeFar = fog.far;
    this.water.setFogRange(fog.near, fog.far);
    this.deck.update(eye, fog.near, fog.far, dt, this.windVX, this.windVZ);
    if (this.rain) {
      // rain falls from the deck: none once you are up in the top of it
      const wet = deckDef ? 1 - clamp((eye.y - (deckDef.top - 400)) / 300, 0, 1) : 1;
      this.rain.update(eye, st.vel, this.wx.rain * wet, dt, this.windVX, this.windVZ);
    }

    this.water.update(this.simTime, this.flightCam.camera.position);
    this.sky.update(st.pos, fog.far, dt);
    this.airport.update(this.simTime, st.pos.x, st.pos.z, st.pos.y);
    // NPC traffic: parked aircraft everywhere; the airborne layer stays out
    // of Ring Rush so the course reads clean
    this.traffic.update(this.state === 'paused' ? 0 : dt, st.pos.x, st.pos.z, this.simTime, !this.rings.active, agl);

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
        // keep polling a gamepad while paused so Start can resume (dt 0:
        // nothing moves, button edges still fire)
        this.input.update(0);
        break;
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
            if (this.autopilot.engaged) {
              const s = this.aircraft.state;
              this.autopilot.update(
                this.aircraft.spec, s, this.input.controls, step,
                s.pos.y - Math.max(this.gen.heightAt(s.pos.x, s.pos.z), 0) - this.aircraft.spec.gearHeight,
              );
            }
            this.aircraft.update(this.input.controls, step, this.heightFn);
            if (this.aircraft.state.crashed) break;
          }
          this.wasOnGround = this.aircraft.state.onGround;
          // debug captures need the shell NOW — virtual-time headless runs
          // race the worker build, and both comparisons are shell-relative
          if (this.lodTint || this.terrain.shellOnly) {
            const p = this.aircraft.state.pos;
            this.terrain.forceFarBuild(p.x, p.z);
          }
          // &alt=metres — jump straight to a cruise altitude on the current
          // heading (horizon / far-terrain captures without a 5-minute climb)
          const altP = Number(new URLSearchParams(location.search).get('alt') ?? NaN);
          if (Number.isFinite(altP) && altP > 0) {
            const s = this.aircraft.state;
            const sp = this.aircraft.spec;
            _menuDir.set(0, 0, -1).applyQuaternion(s.quat);
            const hdg = Math.atan2(_menuDir.x, -_menuDir.z);
            const v = sp.engine === 'heli' ? 45 : sp.vne * 0.62;
            s.pos.y = altP;
            s.vel.set(Math.sin(hdg) * v, 0, -Math.cos(hdg) * v);
            s.quat.setFromEuler(new THREE.Euler(0.03, -hdg, 0, 'YXZ'));
            s.angVel.set(0, 0, 0);
            s.airspeed = v; // the autopilot captures this as its speed target
            s.onGround = false;
            this.input.controls.gearDown = false;
            this.input.controls.flaps = 0;
            this.wasOnGround = false;
          }
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
      } else if (this.autopilot.engaged && !this.autopilot.approach) {
        this.autopilot.targetHdg = want;
      }
    }

    const radar = st.pos.y - Math.max(this.gen.heightAt(st.pos.x, st.pos.z), 0) - this.aircraft.spec.gearHeight;

    // autopilot: manual stick input kicks it off, like the real thing
    if (this.autopilot.engaged) {
      if (this.input.hasManualStick()) {
        this.autopilot.disengage();
        this.screens.setApPanel(false);
        this.screens.toast('AP DISENGAGED — MANUAL INPUT');
      } else {
        const ap = this.autopilot;
        ap.update(this.aircraft.spec, st, this.input.controls, dt, radar);
        this.touch?.setThrottle(this.input.controls.throttle);
        const appr = ap.approach;
        // call the approach phases as they change
        if (appr && ap.apprPhase !== this.lastApprPhase) {
          this.lastApprPhase = ap.apprPhase;
          if (ap.apprPhase === 'gs') {
            // gear and flap stay with the pilot (the mode flies the speed for
            // whatever flap is set, and goes around rather than land gear-up)
            const c = this.input.controls;
            const cfg = this.aircraft.spec.retractableGear && !c.gearDown
              ? ' — YOUR JOB: GEAR DOWN, THEN FLAPS'
              : c.flaps < 0.99 ? ' — YOUR JOB: SET LANDING FLAPS' : '';
            this.screens.toast(`GLIDESLOPE CAPTURED${cfg}`, 3600);
          } else if (ap.apprPhase === 'flare') this.screens.toast('FLARE — RETARD', 1600);
          else if (ap.apprPhase === 'rollout') this.screens.toast('ROLLOUT — AUTOBRAKE', 2200);
        }
        if (ap.goAround) {
          // the approach could not end on the runway: back in the basic
          // modes, climbing on runway heading — say why
          this.screens.toast(ap.goAround, 5200);
          ap.goAround = null;
          this.lastApprPhase = 'off';
        }
        if (!ap.engaged) {
          // the approach mode hands the aircraft back once it has stopped
          this.screens.setApPanel(false);
          this.screens.toast('AUTOLAND COMPLETE — YOUR AIRCRAFT', 2800);
        } else {
          const hdg = ((ap.targetHdg * 180 / Math.PI) % 360 + 360) % 360;
          this.screens.setApPanel(
            true,
            appr ? `LOC ${appr.ident}` : `${String(Math.round(hdg)).padStart(3, '0')}°`,
            appr && ap.apprPhase !== 'loc' ? 'G/S' : `${Math.round(ap.targetAlt * M_TO_FT / 50) * 50} FT`,
            `${Math.round(ap.targetSpd * MS_TO_KT)} KT`,
            `${Math.round(ap.targetVs * 196.85 / 100) * 100} FPM`,
          );
          this.screens.setApAppr(
            this.aircraft.spec.engine !== 'heli', !!appr,
            appr ? `APPR · ${ap.apprPhase === 'gs' ? 'G/S' : ap.apprPhase.toUpperCase()}` : 'APPR',
          );
        }
      }
    }

    this.aircraft.update(this.input.controls, dt, this.heightFn);

    // other traffic: onto the map, and to the tower — which clears you to
    // land (or tells you to keep coming / go around) and calls conflicts
    {
      const n = this.traffic.blips(this.blipBuf);
      this.minimap.setTraffic(this.blipBuf, n, st.pos.y);
      if (!this.rings.active) {
        let nAir = 0;
        for (let i = 0; i < n; i++) {
          const b = this.blipBuf[i];
          if (b.kind !== 0) continue;
          const r = this.radioBuf[nAir] ?? (this.radioBuf[nAir] = { id: 0, x: 0, y: 0, z: 0 });
          r.id = b.id; r.x = b.x; r.y = b.y; r.z = b.z;
          nAir++;
        }
        const app = this.ilsTuned && this.isTowered(this.ilsTuned) ? this.ilsTuned : null;
        const call = this.tower.update(
          dt, { x: st.pos.x, y: st.pos.y, z: st.pos.z, hdg: st.heading, onGround: st.onGround },
          app, app ? this.traffic.runwayOccupied(app) : false, this.windText(), this.radioBuf, nAir,
        );
        if (call) {
          this.sound.radio();
          this.screens.toast(call, 4600);
        }
      }
    }

    // ILS receiver: retune to the best approach ahead about once a second
    this.ilsTimer -= dt;
    if (this.autopilot.approach) {
      // coupled: the receiver stays on the approach being flown
      this.ilsTuned = this.autopilot.approach;
    } else if (this.ilsTimer <= 0 && this.ilsOn && !st.onGround) {
      // (airborne only: sitting on the runway it would "capture" the strip
      // under the wheels and its toast wiped the take-off clearance and
      // wind call a second after they appeared)
      this.ilsTimer = 1;
      const hadIls = this.ilsTuned;
      this.gen.airfieldsNear(st.pos.x, st.pos.z, 36000, this.ilsFieldScratch);
      this.ilsTuned = tuneIls(
        this.ilsFieldScratch, st.pos.x, st.pos.z, st.pos.y, st.heading,
        this.ilsTuned, this.ilsScratch,
      );
      if (this.ilsTuned && (
        !hadIls || hadIls.ident !== this.ilsTuned.ident ||
        hadIls.fieldName !== this.ilsTuned.fieldName
      )) {
        this.screens.toast(`ILS ${this.ilsTuned.ident} ${this.ilsTuned.fieldName} TUNED`, 2000);
      }
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
      if (!st.onGround && radar > this.airMaxAgl) this.airMaxAgl = radar;
      if (this.wasOnGround && !st.onGround) {
        if (!this.touchedDown) this.screens.toast('POSITIVE CLIMB', 1500);
      } else if (!this.wasOnGround && st.onGround) {
        this.sound.touchdown();
        this.flightCam.addShake(clamp(this.prevSinkRate * 0.12, 0.1, 0.8));
        this.gradeTouchdown(this.prevSinkRate);
      }
      this.prevSinkRate = -st.vel.y;
      this.wasOnGround = st.onGround;

      // Final Approach ends once the aircraft has come to rest
      if (this.job) {
        this.stepJob(dt);
        if (this.state !== 'flying') return;
      } else if (this.save.mode === 'approach' && this.touchedDown && st.onGround &&
          Math.hypot(st.vel.x, st.vel.z) < 1.2) {
        this.stopTimer += dt;
        if (this.stopTimer > 0.9) {
          this.finishApproach();
          return;
        }
      } else {
        this.stopTimer = 0;
      }
    }
    this.checkWarnings(radar, dt);

    // stats (distance over the GROUND — airspeed counted a headwind as progress)
    this.stats.flightTime += dt;
    this.stats.distanceKm += (Math.hypot(st.vel.x, st.vel.z) * dt) / 1000;
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
      this.warn !== null,
      1 - (this.input.controls.enginesOut ?? 0) / (this.aircraft.spec.engines ?? 1),
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
      true,
      this.input.controls.engineCut === true || (this.input.controls.enginesOut ?? 0) > 0,
    );
    this.screens.setPortraitWarning(true);
  }

  private applyAutoFly(): void {
    const st = this.aircraft.state;
    const c = this.input.controls;
    const radar = st.pos.y - this.gen.heightAt(st.pos.x, st.pos.z);
    if (this.save.mode === 'approach') {
      // smoke test: let the autopilot fly the ILS to a full autoland
      if (this.aircraft.spec.engine !== 'heli') {
        if (!this.autoArmed && !this.touchedDown && !st.onGround && !this.autopilot.approach && this.ilsTuned) {
          this.autoArmed = true; // once: a go-around must not be re-armed in a loop
          this.autopilot.engage(st, c.throttle, 30);
          this.autopilot.armApproach(this.ilsTuned);
        }
        if (this.autopilot.apprPhase === 'gs' && c.flaps < 1) this.input.setFlapsStep(3);
      }
    } else if (this.aircraft.spec.engine === 'heli') {
      c.throttle = 1;
      // vertical climb-out, then nose over to accelerate into cruise
      c.pitch = radar > 30 && st.airspeed < 40 ? -0.5 : 0;
      c.roll = 0;
    } else {
      c.throttle = 1;
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
    if (this.save.mode !== 'approach' && !st.onGround && radar > 50) c.gearDown = false;
    const ts = this.terrain.stats; // swaps / late swaps / arrivals / late arrivals / dropped
    const apDbg = (this.airport as unknown as { built: Map<string, { aeroBeacon: unknown }> }).built;
    let beacons = 0;
    for (const f of apDbg.values()) if (f.aeroBeacon) beacons++;
    document.title =
      `v=${st.airspeed.toFixed(1)} x=${st.pos.x.toFixed(0)} y=${st.pos.y.toFixed(1)} z=${st.pos.z.toFixed(0)} ` +
      `gnd=${st.onGround} thr=${c.throttle.toFixed(2)} tf=${st.thrustFrac.toFixed(2)} ` +
      `pit=${st.pitchAngle.toFixed(2)} crash=${st.crashed} flds=${apDbg.size} bcn=${beacons} ` +
      `lod=${ts.swaps}/${ts.late}/${ts.fresh}/${ts.lateFresh}/${ts.dropped} sh=${this.terrain.shellInfo()} npc=${this.traffic.info()} ` +
      `fog=${((this.scene.fog as THREE.Fog).far / 1000).toFixed(0)} fps=${this.fps} ` +
      `appr=${this.autopilot.apprPhase} ldg=${this.lastLanding ? this.lastLanding.score.score : '-'} ` +
      `warn=${this.warn ?? '-'} state=${this.state}`;
  }

  private crashFrame(dt: number): void {
    this.crashTimer -= dt;
    this.flightCam.update(this.aircraft, dt, this.heightFn);
    this.sound.silence(); // the engine is not idling in the wreckage
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
      apMode: this.autopilot.approach
        ? ({ loc: 'AP · LOC', gs: 'AP · G/S', flare: 'FLARE', rollout: 'ROLLOUT' } as Record<string, string>)[
            this.autopilot.apprPhase] ?? 'AP'
        : this.route.engaged ? 'AP · NAV' : 'AP',
      warn: this.warn,
      stalled: st.stalled,
      afterburner: !!spec.afterburner && c.throttle >= 0.995,
      vne: spec.vne,
      engFail: (() => {
        const out = c.enginesOut ?? 0;
        if (out === 0 || spec.engine === 'heli') return null;
        return out < (spec.engines ?? 1)
          ? 'ENG 1 OUT'
          : `ENG OUT · GLIDE ${Math.round(bestGlideSpeed(spec, st.pos.y) * MS_TO_KT)}`;
      })(),
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
        // shown whenever a station is tuned (needles peg off-beam rather
        // than the display popping in and out); races keep the HUD clear
        if (!this.ilsTuned || race || (st.onGround && st.airspeed < 3)) return null;
        const d = solveIls(this.ilsTuned, st.pos.x, st.pos.y, st.pos.z);
        return {
          name: d.name,
          ident: d.ident,
          course: d.course,
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
