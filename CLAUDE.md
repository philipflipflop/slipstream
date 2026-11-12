# SLIPSTREAM — notes for Claude Code

Browser flight simulator: three.js + Vite + TypeScript, zero asset files (all
procedural). Deployed as a static site on Cloudflare Pages via GitHub.

## Commands

- `npm test` — headless physics/world suite (compiles pure modules to `.test-build/`, no browser)
- `npm run build` — type-check + production bundle
- `npm run dev` / `npm run preview` — dev server / serve `dist/`

## package-lock.json — CRITICAL

Cloudflare builds with **npm 10.9.2**; local npm is 11. Two rules:

- After dependency changes, regenerate with Cloudflare's npm:
  `npx -y npm@10.9.2 install --package-lock-only --ignore-scripts`
- **Always check `git status package-lock.json` before committing.** Cold-cache
  `npx` runs under npm 11 silently prune the top-level `@emnapi/core` /
  `@emnapi/runtime` entries (~26 lines) that npm 10's `npm ci` requires, which
  breaks the Cloudflare deploy. If the lockfile changed and you didn't touch
  dependencies, restore it: `git checkout HEAD -- package-lock.json`. Never run
  bare `npx <tool>` in scripts — call local binaries directly (see
  `tests/run.mjs`).
- A pre-commit hook (`.githooks/pre-commit`, enabled via
  `git config core.hooksPath .githooks`) hard-blocks any commit that strips the
  @emnapi entries. If a fresh clone loses the hook, re-run that git config line.

## Architecture pointers

- `src/world/heightfield.ts` — analytic heightfield, single source of truth for
  rendering, collision, scatter, minimap, and airfield placement (5 fixed —
  three twin-runway INTERNATIONALS ~100 km apart (rwySep/rwy2Len on
  AirfieldDef; spawn = Meridian Intl's WESTERN runway at across −rwySep/2) —
  plus procedural strips on a 12 km cell grid, ~⅓ of cells, longest ones
  major regionals, AND procedural INTERNATIONALS on a 120 km supercell
  grid (intlForCell: ~70% of supercells try up to 8 jittered sites against
  flat-dry footprint probes). SUPERCELL RULE: hub jitter is capped at
  ±28 km, keeping every hub ≥32 km inside its own supercell — flattening,
  paint and the 14 km strip berth therefore consult ONLY the query point's
  own supercell (one intlForCell lookup in gatherFields/makeField);
  widening the jitter breaks that invariant. Change terrain in one place
  only. `intlBuildings()` is the ONE list of
  terminal/pier/tower/hangar/cargo/carpark/fuel boxes: airport.ts renders
  it and obstacles.ts derives rotated-box collision from it — never define
  airport buildings anywhere else. Same pattern for the taxiway system:
  `intlTaxiways()` is the ONE segment list (inner+outer parallels,
  right-angle + runway-end connectors, 30° rapid exits; memoised per
  runway length, pinned in tests/06) — airport.ts lays crisp textured
  ribbon planes, hold-short bars, red designator signs and blue night
  edge lights from it, and colorAt paints the SAME rectangles as backing.
  Heathrow ground rules: mowed turf inside the perimeter (mow stripes
  fade off above ~20 m texels like the city grid), pavement ONLY where
  aircraft roll; the CTA apron slab + stand boxes stay vertex-painted
  (wide enough to survive every texel). Kilometre-scale ground overlay
  planes z-fight against mismatched terrain tones — only runway-sized
  planes over SAME-TONE terrain paint are safe. Two corollaries: taxiway
  backing paint is gated texel 18→30 in (the fine ring shows the crisp
  ribbon over clean turf — no blurry paint halo, and depth is precise
  that close) and 90→140 out (far shell); and canvas pixels for any
  ground plane MUST go through airport.ts's lin→sRGB `rgb()` helper
  (PAVE/APRON/STAND constants) or the texture won't match the linear
  vertex paint beneath it. Ground-plane z-stack: parallels E+0.04,
  connectors/RETs +0.048, stand pads +0.052, hold bars +0.055, runways
  +0.06 — planes in the same class must never overlap each other.
- `src/world/lod.ts` — the terrain LOD POLICY, pure and fully tested
  (tests/19). Detail is a function of DISTANCE, not time: each chunk level
  (res 14/28/56/112) has a blend BAND, and swaps happen only in the dead
  zones between bands, where the finer mesh is fully collapsed onto its
  parent look (m = 0) and the coarser one is fully itself (m = 1) — so a
  swap, an arrival and a removal each change no pixel. Thresholds are on
  the chunk-CENTRE distance from the streaming centre; a transition at U
  keeps the finer band inside U − R − MARGIN and the coarser band outside
  U + HYST + R + MARGIN (R = chunk half-diagonal, 636 m). Consequences
  when retuning `LOD_PRESETS`: consecutive thresholds need ≥ ~2.3 km
  between them and the load radius ≥ ~3.2 km past `u28`, or a band
  collapses (test 19 section 1 fails loudly). Reach varies SMOOTHLY with a
  slew-limited AGL — never reintroduce altitude tiers: a tier flip moves
  every threshold at once, mid-band. THE HISTORY: five rounds of making the
  old timed geomorph more exact never removed the "pop", because arcs of
  tiles sharpening together every 900 m of travel is a temporal event the
  eye catches however exact the start frame is.
- `src/world/terrainBuilder.ts` — pure payload builder (no three.js/DOM), runs in
  `terrain.worker.ts` with a synchronous fallback. Every payload carries its
  PARENT look: `baseY` / `baseCols` / `baseNrms` sampled on the parent
  level's own lattice (`prevRes = res / 2`; the far shell via
  `shellVertexHeight` for res 14) and interpolated with the mesh's b–c
  diagonal split. THE RULE: the parent look must reproduce EXACTLY what the
  parent mesh renders — its heights, its slopes, its texel — with no
  clamps or fix-ups (a waterline clamp used to live here; it made swaps
  visible at coasts). Pinned bit-for-bit in tests/19 section 2 and tests/07.
- `src/world/terrain.ts` — the streamer: scan → feed → finalize. `scan()`
  re-plans the disc every 60 m of travel (or 6 m of AGL change): drops
  chunks beyond the load radius ONLY once collapsed onto the shell, queues
  one-level steps (`planStep` — never two levels: morph data only reaches
  the parent), re-punches the shell hole. The vertex shader blends parent →
  own per vertex: `tM = mix(uFade.x, 1 − smoothstep(band), uFade.y)` with
  shared `uCenter`/`uBands` uniforms. `uFade` is an arrival time-fade that
  only acts when a build lands LATE (inside a band) — on-time swaps skip it
  entirely. Worker results refeed from `onmessage` and uploads are budgeted
  by TIME, so throughput does not hang off the frame rate (it used to: at
  20 fps the worker idled 90% of the time and streaming fell behind).
  `stats` (swaps / late / fresh / lateFresh / dropped) is in the autofly
  tab title as `lod=`; after the initial fill `late` must stop growing —
  that is the in-browser proof swaps are seamless. Debug: `?lodtint=1`
  (tint by level, darkened by collapse — bands show as rings),
  `?lodlog=1` (console.warn each non-seamless swap), `?shellonly=1`.
  Shell builds only when the chunk queue is idle (first build) — keep it
  that way.
- Distant furniture grows in: airports (airport.ts) and parked NPC rows
  (traffic.ts) built more than 8 km away rise out of the ground over ~6 s
  (smoothstep scale.y about FIELD ELEVATION — scaling about world 0 sinks
  elevated fields like Highmoor underground). Builds within 8 km (boot/
  spawn) appear instantly at full size. Without this, the 20/16 km
  BUILD_RADIUS pops whole terminals into frame at cruise ("middle-distance
  pop").
- `src/world/obstacles.ts` — solid-object collision (towers/houses/trees/hoodoos),
  pure. Hit volumes derive from `buildScatter` in terrainBuilder — the SAME lists
  the renderer instances. Never place scatter outside `buildScatter`, or rendering
  and collision will disagree.
- Scatter invariants: a lower scatter level's lists must stay an exact PREFIX of a
  higher level's and towers must be identical at every level. Each category
  (trees / rocks / houses) has its OWN RNG stream for this — with one shared
  stream, rocks and houses started from a different state after 90 vs 240
  tree tries and re-rolled on every density change (614 of 625 mesa chunks;
  a real pop at ~3 km). The payload's `l1` gives the level-1 prefix length
  per list: the renderer puts prefix and suffix on different distance GROW
  bands (shared materials per kind × band), so a density change never
  moves, adds or removes a visible object. Pinned in tests/19 section 3.
- Patterns painted into vertex colours must respect the `texel` param of
  `colorAt` (city street grid fades to its average tone when under-sampled) —
  otherwise coarse LODs and the far shell alias into shimmering moiré.
- iOS audio: `navigator.audioSession.type = 'transient'` (sound.ts) — the
  MIXING media-channel type: bypasses the mute switch AND keeps the user's
  music playing ('playback' stopped music like a video app; 'ambient'
  obeys the mute switch). The silent `<audio>` keepalive is only for
  pre-16.4 WebKit — that element itself pauses music, never add it back
  on the modern path. iOS also parks interrupted contexts in state
  'interrupted' (WebKit extension) — resume on ANY state !== 'running'
  (every pointer gesture hits init via the body capture listener) and on
  visibilitychange, or the sim stays silent after Siri/calls/app switches.
- Fixed-wing autotrim: the pitch weathervane spring centres on
  `st.trimAoA` — the 1g trim AoA for current speed/flaps (fbw airframes
  retrim at 2.5/s like the A320's normal law, others at trim-wheel 0.5/s).
  Trim washes out with bank (past ~40°) and inside 30 m AGL (so flares end
  in landings), parks at 0 on the ground and below 0.85 × clean stall speed
  (capped at 30 m/s — a FLAT 30 m/s floor sat above the Skylark's and
  Islander's whole approach, so they lost trim on final and nosed over).
  Without autotrim, low-G transports burn ~¾ of their G-limit-capped pitch
  authority just holding level, nose over hands-off, and the AP saturates +
  descends in banked climbs — the "A320 doesn't fly right" bug (pinned in
  tests/16). Turbulence response scales with gust/airspeed (55/V) and slow
  envelopes de-rhythmize the gust sines: constant-amplitude chop at cruise
  reads as "rubber-banding".
- Ground physics: below 1.5 m/s ground speed, aero yaw moments are zeroed
  (static tire grip) — parked aircraft must not weathervane or slide in
  wind (pinned in tests/14). The parked-stance PITCH spring fades with
  weight-on-wheels (1 − L/W): without that, transport wing loadings (A320)
  can never rotate — the G-limit cap shrinks pitch authority with speed
  while the spring never weakened, pinning the nose at ~2° forever.
  Heavies take off with CONF-2 flap and a firm pull (see tests/16).
- Mobile rendering: touch devices skip the logarithmic depth buffer, so they rely
  on the AGL-scaled near plane (main.ts frame()) + the water sheet's polygon
  offset/raise (`Water` `coarseDepth` flag) to avoid shoreline z-fighting.
- `src/aircraft/flightModel.ts` — `stepFlight` branches to `stepHeli` when
  `spec.engine === 'heli'` (Bell 505): throttle = collective, cyclic is
  attitude-command (`inp.pitch·0.45` / `−inp.roll·0.6` are the target Euler
  angles — the autopilot's heli branch writes attitude targets straight
  through the stick; full deflection = ±40° pitch / ±54° bank), pedals
  are yaw rate. The rotor is driven by BOTH vertical upflow and forward
  airspeed (`drive = descend + min(vh,50)·0.064`) — chop the collective
  at cruise and it eases into a ~1,450 fpm / ~4:1 glide instead of
  free-falling while sink builds. Realism terms (all in stepHeli,
  each pinned by test 12): autorotation via `autoBite` (upflow drives the
  rotor — collective-down glides at ~1,700 fpm / 3:1, vertical drop stays
  deadly), vortex ring state (powered sink > ~6.5 m/s at vh < 11 loses lift
  + buffets; recover forward or collective down), flapback (nose-up moment
  ∝ vh — cruise needs standing forward stick), tail-rotor translating
  tendency (rightward hover drift). Rotor RPM is a real state
  (st.rotorRpm; lift ∝ NR², control authority fades with it): governed to 1
  while the engine runs, on `inp.engineCut` (X key) it lives off upflow vs
  collective load — collective-down keeps NR ≈ 1, frozen collective droops
  it fatally. HUD shows TRQ/NR + LOW ROTOR RPM / VORTEX RING cautions; the
  AP has a hover-hold (engage minSpd 0, pedals hold hover heading — bank
  would orbit the spot against torque). Skid-gear crash rules differ from
  wheels: sink > 5 m/s powered but 15.4 m/s (~30 kt impact) with the
  ENGINE OUT — a firm autorotation arrival is survivable by design; roll,
  slope, run-on > 16 m/s unchanged. The SAS attitude envelope is NOT a
  cage: the last ~8% of cyclic throw (|stick| > 0.92) washes the attitude
  hold into a pure rate command so a held full deflection rolls/flips
  through, and the attitude-error term is capped at 1.1 rad so recovery
  is a realistic rate, not a rubber band (both pinned in test 12 — keep
  scripted inputs ≤0.9 deflection unless a roll-through is intended).
- `src/combat/range.ts` — round↔balloon collision is SWEPT (segment vs
  sphere): at muzzle velocity a round outruns a balloon diameter per frame,
  so an end-of-step point test tunnels. Keep any new projectile/target
  check swept (test 13-balloons).
- `src/world/daylight.ts` — time-of-day presets (dawn/day/dusk/night). The
  palette is FIXED at construction and threads into Sky (dome uniforms,
  stars, disc, scene lights), Water (colors + glint), TerrainManager
  (windowGlow: emissive tower maps + supertall beacons — the emissiveMap is
  only attached when glow > 0 so the day preset keeps the cheap shader),
  and Aircraft.addExteriorLights (landing-light SpotLight only on dark
  presets: one extra scene light). Changing tod reloads, like worlds.
  Landing light lesson: a spotlight grazing a flat runway loses ~94% to
  Lambert's cosine — model it as a collimated beam (decay 0) with a huge
  intensity, aimed a few degrees below boresight.
- PAPI (airport.ts): rows of four at BOTH thresholds of every runway,
  per-frame red/white from the aircraft's actual angle to each box vs
  [3.5, 3.2, 2.8, 2.5]° (indexed i % 4); world positions captured after
  the field pivot via getWorldPosition. Runway designators are real per
  heading (36/18-style, L/R suffixes at internationals) via runwayIdent —
  textures cached per number pair.
- `src/nav/ils.ts` — pure ILS: one approach per runway END (four at
  internationals). LOC antenna 300 m past the stop end (±2.5° full scale),
  GS station 300 m in from the threshold on a 3.00° path (±0.7°), DME;
  auto-tune (main.ts, 1 Hz) ACQUIRES the best runway ahead but then HOLDS
  the station like a real tuned radio until out of range — needles peg
  off-beam instead of the display popping (test 15). `I` toggles the
  receiver off/auto. HUD draws fly-toward diamonds; deviation signs:
  + = right of centreline / above the slope.
- APPROACH SURFACES (heightfield.ts `approachSurface`): off every runway end
  a 2.0° plane (glide path 3.0°, low needle 2.3°) — terrain is squashed
  under it in `heightAt` (before flattening, so flattening wins) and
  `approachLimitAt` keeps trees / rocks / houses / city towers out of it in
  `buildScatter` (so collision agrees). Protected length 12 km at
  internationals, 7 km regionals, 5 km strips. Without it the procedural
  world parks hills ON the glide path (Meridian 36L: 98 m above it at 5 km;
  nearly every mesa approach was blocked). Pinned in tests/20 section 1.
- Autopilot APPR (`Autopilot.flyApproach`, `L` key / APPR button): steers
  GROUND TRACK at a point on the centreline (crab emerges, no integrator),
  holds altitude until the glide path arrives, rides it at 1.3 × stall for
  the flap set, exponential flare off the radio altimeter, rollout with
  autobrake, hands back when stopped. The path loop gain is scheduled on
  pitch AUTHORITY (G-limit cap) with a floor of 0.1: too loose and the
  phugoid rings against the autothrottle — a ±800 fpm porpoise down the
  glide path that only shows in a time-series trace (tests/20 asserts the
  sink-rate swing, not just the touchdown).
- `src/nav/landing.ts` — pure landing rubric: sink (40) / centreline (30) /
  touchdown zone (30). main.gradeTouchdown scores every runway touchdown
  after a real airborne segment (> 15 m — bounces don't re-grade); Final
  Approach mode (`save.mode === 'approach'`, `spawnOnApproach`) starts on
  final with a head/crosswind and ends with the debrief once stopped.
- Gear: a touchdown with retractable gear UP is a crash (flightModel), and
  main's `gear` handler is the squat switch — the lever only moves airborne
  and in the flying state. Scripted pilots must raise gear at positive
  climb, not at liftoff (tests/01's old script settled back and "passed" by
  rolling at 260 kt with the gear retracted).
- `src/input/gamepad.ts` — pure pad mapping (dead zone, expo, button edges;
  tests/21); InputManager polls each frame, and with dt 0 while paused so
  Start can resume. Non-standard layouts get axes 0/1 + trigger only.
- Audio: `sound.silence()` on pause / hangar / crash / debrief — the
  per-frame `update` only runs while flying, so the last engine note
  otherwise drones through every menu.
- `src/world/traffic.ts` — NPC aircraft + airport ground vehicles. Parked:
  single-geometry planes nose-in on `INTL_STANDS` (heightfield.ts — the ONE
  stand list shared with the jet bridges and stand paint, so gates, bridges
  and aircraft always line up), regional aprons, strip edges; hash-seeded,
  deterministic, NEVER on pavement (test 17). Airborne: 5 cruisers in a
  30 km bubble, terrain look-ahead, drained during Ring Rush; airborne NPCs
  must NOT castShadow — a flier crossing the sun's ±420 m player-chasing
  shadow box sweeps a popping shadow over shorelines ("water edge
  flicker"). No collision, like the rest of the airport furniture.
- Autopilot bank caps scale by airframe class (gLimit ≥ 7 → ~54°, ≤ 3 →
  airline ~30°, else 24°): a fixed light-aircraft cap turns fast jets into
  0.5°/s barges that "don't turn" (pinned in test 05).
- Airport z-fight rules: roof caps sink INTO building bodies (a bottom
  face coplanar with the body top shimmers), NPC wheels bury their bottom
  faces below the pavement, big flat airport buildings cast but don't
  receive shadows (acne crawls as the shadow box chases the player).
- Airfield lights are treated as POINT SOURCES: fog:false materials +
  per-frame rescaling so they hold ~2–3 px at any range (night divisor
  350, cap 60×), plus a white/green beacon + steady glow sprite per field
  after dark. GOTCHA: SpriteMaterial sizeAttenuation:false renders
  nothing under the logarithmicDepthBuffer — scale world-size sprites
  linearly with distance instead. InstancedMesh light strings need
  frustumCulled = false (their bounds are the tiny base geometry).
- Wind: `setWind(vx, vz)` in flightModel (module state, default calm —
  tests stay bit-exact). Aero uses air-relative velocity, integration is
  inertial. Heli ground-contact checks must use GROUND speed, not air.
  main.rollWind(): random 3–15 kt in free flight, calm in races/autofly,
  `?wind=hdg,kt` override; windsock orientation via Airport.setWind.
- Streaming is EUCLIDEAN (disc, not Chebyshev square): scan, hole and
  removal all use hypot from the continuous streaming centre; the far
  shell's OUTER edge is also trimmed to a disc and the below-horizon sky
  dome (groundGlow = 1) must stay at the fog colour or the shell edge
  ghosts through as a colour step at altitude. Keep any new ring logic
  circular.
- far-shell cellSize MUST have a small LCM with CHUNK_SIZE (900) — the
  recenter snap grid is that LCM. 450→900, 600→1800 are fine; 380/460/680
  gave 17–30 km snap grids and the horizon lurched forward in giant jumps
  ("deficit builds then the edge pops in one go" at cruise).
- Minimap sampling is LED ~15 s ahead along the ground track (pan
  overrides the lead) — a lazily trailing sample centre leaves a black
  band hatching in at the map's leading edge at speed. The expanded chart
  pans (drag; tap = waypoint, ⌖ ACFT recenters; pinch or , / . zooms) —
  it draws from the ANALYTIC heightfield, so planning range costs no 3D
  streaming. The terrain/field query only reaches ~100 km, so nearest-hub
  findability comes from a separate wide scan: `hubsNear` (480 km,
  cached supercell lookups) feeds amber rim arrows with name + distance
  to the nearest internationals (3 on the chart, 1 on the docked map) —
  without it the next hub over is invisible and the map reads hub-less.
- The far-shell hole must NEVER outrun real coverage: `scan()` clamps it to
  the nearest missing chunk (minus a re-punch step) and the level-0 blend
  band ends SHELL_SLACK inside it, so chunks sit exactly on the shell
  wherever the shell may still be drawn. Punching the planned radius while
  chunks are still baking shows sky-dome void below. The hole is re-punched
  every ~190 m (16-bit index, index-only upload).
- Conventions: -Z = north = heading 0; runway along Z at origin; heading =
  `atan2(fwd.x, -fwd.z)`.

## Verification

- Physics/feel changes: add or extend a Node harness test in `tests/` — tune with
  time-series traces, not end-state asserts.
- Visual changes: `--virtual-time-budget` headless captures are flaky and
  barely advance the sim after `ff` (a 45 s budget flew ~0.3 s). For
  anything that has to RUN — streaming, approaches, UI flows — drive a real
  headless Chrome over the DevTools Protocol instead: launch with
  `--headless=new --remote-debugging-port=N`, connect Node's built-in
  WebSocket to the page target, `Page.navigate`, wait real seconds, then
  `Runtime.evaluate('document.title')` / `Page.captureScreenshot` /
  `Input.dispatchKeyEvent`. No dependencies needed. For a single still,
  `--headless=new --disable-frame-rate-limit --disable-gpu-vsync
  --virtual-time-budget=N --screenshot=...` works with retries (a ~93 kB PNG
  is the boot screen).
  Dev URL params: `?autofly=1&ff=N&ac=vector&apt=N&ap=1&tod=night&q=low`,
  `&mode=approach` (autofly then flies the ILS to an autoland); telemetry
  is in the tab title (`lod=`, `fps=`, `appr=`, `ldg=`, `warn=`). Dark
  screenshots legitimately compress below 100 kB — don't use a large
  min-size gate to detect boot-screen captures on night scenes.
