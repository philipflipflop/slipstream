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
  three twin-runway INTERNATIONALS ~50 km apart (rwySep/rwy2Len on
  AirfieldDef; spawn = Meridian Intl's WESTERN runway at across −rwySep/2) —
  plus procedural strips on a 12 km cell grid, ~⅓ of cells, longest ones
  major regionals). Change terrain in one place only. `intlBuildings()` is
  the ONE list of terminal/pier/tower/hangar boxes: airport.ts renders it
  and obstacles.ts derives rotated-box collision from it — never define
  airport buildings anywhere else. The international concrete slab +
  taxiway lines are PAINTED into colorAt at the mesh's own texel (taxi
  lines fade like the city grid). Kilometre-scale ground overlay planes
  z-fight against mismatched terrain tones — only runway-sized planes over
  SAME-TONE terrain paint are safe.
- `src/world/terrainBuilder.ts` — pure payload builder (no three.js/DOM), runs in
  `terrain.worker.ts` with a synchronous fallback. Chunk LODs nest (56/28/14) and
  every payload carries `baseY` geomorph starts; the far horizon shell shares
  `shellVertexHeight` so fresh chunks rise exactly off the rendered shell.
  Payloads also carry `baseCols`/`baseNrms` colour- and normal-morph starts,
  blended by the same `uMorph` in makeChunkMat: arriving tiles sharpen
  gradually in shape, paint AND shading. THE RULE: a morph start must
  reproduce EXACTLY what the replaced mesh rendered — sample colour/normal at
  the REPLACED mesh's own lattice (its heights, its slopes, its texel) and
  splitLerp between lattice points; re-evaluating the field at the fine
  vertices (even at a coarse texel) starts the crossfade from an image that
  was never on screen and the difference pops in the arrival frame. Verify
  with `?morphhold=1` (freezes every chunk at morph start): a frozen frame
  must show a seamless coarse landscape — any visible tile seam IS the pop.
- `src/world/terrain.ts` — streaming, LOD rings (quality-set `fineRing`/`midRing`
  + high-altitude variants), geomorph animation, horizon shell management (shell
  builds only when the chunk queue is idle — keep it that way).
- `src/world/obstacles.ts` — solid-object collision (towers/houses/trees/hoodoos),
  pure. Hit volumes derive from `buildScatter` in terrainBuilder — the SAME lists
  the renderer instances. Never place scatter outside `buildScatter`, or rendering
  and collision will disagree.
- Scatter invariants: a lower scatter level's lists must stay an exact PREFIX of a
  higher level's (same RNG stream, only loop bounds differ) and towers must be
  identical at every level — chunk upgrades keep prefix instances full-size and
  grow only the new suffix, so violating this reintroduces scatter pop-in.
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
  auto-tune (main.ts, 1 Hz) captures the best runway ahead with hysteresis.
  HUD draws fly-toward diamonds; deviation signs: + = right of centreline /
  above the slope (test 15).
- `src/world/traffic.ts` — NPC aircraft. Parked: single-geometry planes on
  intl stands / regional aprons / strip edges, hash-seeded per field —
  deterministic and NEVER on pavement (test 17 asserts this; keep stands
  |across| < 560 at internationals). Airborne: 5 cruisers in a 30 km
  bubble, terrain look-ahead, drained during Ring Rush. No collision, like
  the rest of the airport furniture.
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
- Streaming is EUCLIDEAN (disc, not Chebyshev square): requeue/feed/
  finalize all use hypot; the far shell's OUTER edge is also trimmed to a
  disc and the below-horizon sky dome (groundGlow ≈ 0.95–0.97 of fog)
  must stay near the fog colour or the shell edge ghosts through as a
  colour step at altitude. Keep any new ring logic circular.
- far-shell cellSize MUST have a small LCM with CHUNK_SIZE (900) — the
  recenter snap grid is that LCM. 450→900, 600→1800 are fine; 380/460/680
  gave 17–30 km snap grids and the horizon lurched forward in giant jumps
  ("deficit builds then the edge pops in one go" at cruise).
- Minimap sampling is LED ~15 s ahead along the ground track (pan
  overrides the lead) — a lazily trailing sample centre leaves a black
  band hatching in at the map's leading edge at speed. The expanded chart
  pans (drag; tap = waypoint, ⌖ ACFT recenters) — it draws from the
  ANALYTIC heightfield, so planning range costs no 3D streaming.
- The far-shell hole must NEVER outrun real coverage: rebuildFarIndex
  clamps it to nearestGapRing() − 1.2 (closest missing chunk), and it is
  re-punched wider when the queue drains (farHoleDirty). Punching the
  planned radius while chunks are still baking shows sky-dome void below
  and makes every arriving tile pop against nothing — this was the true
  cause of the "tiles jump into frame at altitude" reports. Streaming
  radius grows through altitude TIERS (altBonusTiers[4], hysteresis at
  1150/3200/5200 m up), and the finalize budget triples on deep backlogs.
- Conventions: -Z = north = heading 0; runway along Z at origin; heading =
  `atan2(fwd.x, -fwd.z)`.

## Verification

- Physics/feel changes: add or extend a Node harness test in `tests/` — tune with
  time-series traces, not end-state asserts.
- Visual changes: headless Chrome needs
  `--headless=new --disable-frame-rate-limit --disable-gpu-vsync --virtual-time-budget=N --screenshot=...`
  (without the frame-rate flags it pumps ~3 rAF frames and captures the boot
  screen). Dev URL params: `?autofly=1&ff=N&ac=vector&apt=N&ap=1&tod=night`;
  telemetry is in the tab title. Runs are occasionally flaky — retry. Dark
  screenshots legitimately compress below 100 kB — don't use a large
  min-size gate to detect boot-screen captures on night scenes.
  In containers where virtual-time never advances rAF (screenshot stuck on
  the boot screen no matter the budget), drive real time with the globally
  installed Playwright instead: launch chromium with
  `--use-angle=swiftshader --enable-unsafe-swiftshader`, goto the preview
  URL, `waitForTimeout(12000+)`, then screenshot.
