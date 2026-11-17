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
- TERRAIN SHAPE (heightfield.ts `baseHeightAt`), rules learned from
  top-down hill-shaded maps (`node tests/map-probe.mjs theme cx cz span px
  out.ppm` — LOOK at terrain from above when changing it; from the cockpit
  the faults below went unseen for months):
  · The domain warp FOLDS (Jacobian down to ~0.15). Only the broad masks
    (continents, mountain regions, river courses, canyons) may ride the
    full warp (`wx, wz`); relief — hills, ridges, terraces, grit — is
    sampled through a quarter of it (`hx, hz`). Through the full warp
    every hill and coast was smeared 5–7× into parallel streaks.
  · Variety is regional: hill country (rounded 100–200 m downs), rivers
    (zero lines of a slow noise, cut BELOW sea level so the one water sheet
    fills them, only where land is under ~100 m), volcanoes (archipelago:
    one candidate per 56 km cell, memoised, never near a hand-placed
    field), free-standing mesas and dune seas (mesa). Rivers and buttes
    are kept off the fixed fields via the spawn boost. Features narrower
    than the far-shell lattice (450 m) dissolve at range — rivers become a
    chain of ponds beyond the chunk disc; keep new landmarks ≥ ~600 m.
  · The airfield flattening footprint must FADE to zero at its ends
    (`smoothstep(outer, outer*0.76, |along|)`). It used to stop dead on a
    world-axis box: an 88%-flattened surface met untouched hills along a
    ruler-straight wall 4–5 km off each runway end.
  · Colour: farmland is a jittered-lattice quilt (`fieldTone`, Chebyshev
    cells) that fades to its MEAN tone by texel like the city grid; upland
    heath, treeline (matches buildScatter's 460 m), scree, a wandering
    snowline that steep faces shed; the temperate branch must stay
    CONTINUOUS in height (the old `h > 520 + dry*160` test jumped from
    grass to 97% snow in dry country).
  · Ring Rush plans its gate heights with look-ahead (rings.ts) — a hill
    the course cannot climb in one leg starts the climb earlier.
- VISIBILITY: `GROUND_VIEW` (lod.ts) is how far you see at ground level —
  7 / 11.5 / 16.5 km — and no longer the chunk radius; it must stay inside
  the far shell's own limit (tests/22). Above ~1,200 m `visibility()` adds
  height × 17; caps are 74 / 142 / 200 km (`SHELL_PRESETS.fogCap`, bounded
  by the horizon shell's radius, whose vertex count must stay ≤ 65,535).
- WEATHER (`src/world/weather.ts` pure + `clouds.ts`, tests/24): a preset
  is a cloud DECK (base, top, coverage), a visibility beneath it, rain, a
  wind range and turbulence; fixed at construction like the time of day
  (`?wx=clear|fair|broken|overcast|rain|fog`, changing it reloads). The
  deck is a real layer and everything keys off where the EYE is:
  `beneath()` (1 under the base … 0 above the top) picks whose light, sky
  palette and visibility apply (`sky.setAir`), `densityAt()` closes the
  view to `cloudVis` inside cloud. Rules:
  · main keeps the CLEAR-air visibility damped (`hazeFar`) and applies the
    weather on top of it undamped — entering cloud must not take seconds.
  · `sky.setAir` moves the fog colour every frame; the three places that
    hold a copy must follow or the HAZE rules break: `scene.fog.color`
    (THREE.Fog copies the Color it is given), `water.setFogColor`, and the
    deck's own uniform (it shares `sky.fogColor` by reference).
  · The layer is a VOLUME, not two sheets (the first version was two
    analytic planes; the playtester: "a sheet of paper … very flat once
    you're above them"). `weather.deckSurfaces` gives top and base at any
    point — relief, embedded towers ABOVE `top`, a ragged base that never
    comes below `base` (ILS minima), lens bodies in a broken layer — and
    cloud thickens over `soft` metres inside them. clouds.ts marches the
    SAME formula from the SAME four byte fields (one RGBA texture) per
    pixel on a full-screen triangle; `deckDensity` is what the sim flies
    through. Change the shape in BOTH places or what you see stops being
    what you fly into (tests/24 pins the TS side only).
  · The march, and what each part is for: steps sized by clearance to the
    surfaces (one lookup bounds the layer; the detail lookup only near
    it); the entry point solved by false position (bisecting a 500 m far
    step left 60 m terraces — contour lines on every distant cloud);
    jitter on the FIRST step only (a per-step factor compounds with range:
    far cloud turned to grain); geometry relaxing onto the mean surfaces
    with range (`uFlat`) while lighting keeps full relief; extinction =
    the sim's in-cloud visibility near the eye (or the chase-view aircraft
    vanishes behind a wall), tightening with range. It writes depth
    (analytic, both depth-buffer paths): transparent things beyond it are
    hidden. Costs ~10–20% of frame rate on the dev Intel GPU; step budget
    24 on touch/low, 40 otherwise.
  · Per-weather character lives in the preset's deck (relief / towers /
    ragged / soft / lumpy): rain is smooth swells with towers (WMO:
    "diffuse and fairly smooth … cumulus may rise above its upper
    surface", scud beneath), overcast is lumpier, fog nearly flat.
  · Rain streaks are world-space drops wrapped into a camera-following box;
    the wrap offset is computed on the CPU in doubles (a float `mod` of a
    100 km coordinate has no precision left).
- ENGINE FAILURES (X; tests/23): `inp.enginesOut` kills engines one at a
  time (No.1 = left first). `spec.engines` / `spec.asymYaw` describe twins;
  a dead engine windmills (extra drag), one of two swings the nose toward
  the dead side by thrust × asymYaw. `bestGlideSpeed(spec, y)` is TRUE
  airspeed (what the tape shows) and so rises with altitude — the first
  version ignored density and was 36% slow at 6 km. Sign conventions that
  cost an hour: +rollAngle is LEFT bank (hold wings level with
  `roll = +rollAngle·k`), +angVel.y is yaw LEFT, +inp.yaw is right rudder.
  With EVERY engine out the autopilot's basic modes fly best-glide speed
  through the vertical-speed loop (`ap.gliding`, annunciated AP · GLIDE) —
  left holding altitude the speed protection parked each airframe just
  above the stall and the Falcon in it; speed-on-pitch straight onto the
  elevator rings at the phugoid, so don't "simplify" it to that.
- `st.gForce` is aerodynamic force along body-up over weight: 1.0 in level
  flight (pinned in tests/05). It carried a `+ (1 − V/500)` bias for a long
  time — the G-meter read 1.7–1.9 straight and level — which only surfaced
  when job passengers (`Comfort`) complained about a smooth ILS.
- THE TOWER (`src/nav/radio.ts` pure, tests/25): landing clearance once
  established on final to a towered field (international or `major`) —
  "continue approach" while `traffic.runwayOccupied(app)`, "go around" if
  still occupied at 1.5 km — and traffic advisories once per aircraft.
  `traffic.blips()` feeds both it and the map (`minimap.setTraffic`:
  airborne = filled cyan arrowhead + relative height in hundreds of feet,
  on the runway = hollow, ships = grey ticks).
- JOBS (`src/nav/jobs.ts` pure, tests/26; mode `job` = "Charter"): the
  board at `spawnField` (`jobsFrom`: destinations the aircraft's
  `jobClass` can use — airliners internationals only, jets regional and up
  — within ~17 min of block time, deterministic per field/aircraft/serial).
  Taking one puts the destination in the flight plan and on the map;
  `stepJob` runs the clock and the ride (`Comfort`: g outside 0.5–1.7,
  bank past 40°, a hard arrival); stopped on the destination (`atField`)
  pays `scoreJob` = fee × punctuality × landing grade × ride, and the
  destination becomes `spawnField` with a fresh board. A fixed-wing
  arrival that was not a graded runway landing AT the destination gets no
  landing credit (0.6); helicopters are not graded (neutral).
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
- THE HORIZON (lod.ts "shells", tests/22): beyond the chunk disc the world
  is two nested coarse lattices — the far shell S (450/600 m cells, 27–40 km
  radius) and the horizon shell H (1800 m cells, 90–216 km; `SHELL_PRESETS`).
  S hands over to H exactly as chunks hand over to S: every S vertex carries
  H's look (`buildFarPayload` with `parentCell`) and blends to it by distance
  inside `shellBand`, so re-centring S is a swap between identical surfaces
  and H's hole can be cut anywhere S is collapsed. Rules:
  · H's rim is the ONLY un-morphed edge left, so full haze must close inside
    it: `fogCap ≤ H radius − H_DRIFT − STREAM_LEAD` (asserted), and main
    clamps the haze to `terrain.viewLimit()` while H is missing or late.
  · S re-centres every ~2–3 km (it loses `S_DRIFT` of reach to drift, so
    frequent beats large); that is only affordable because the builder
    copies every lattice point the previous build had (`prev`: 13 ms vs
    180 ms). Every shell vertex must stay a PURE FUNCTION of its world
    lattice point (padded lattice → true central differences at the rim) or
    reuse stops being exact and the horizon swims.
  · The blend edge (`sEdge`) is slew-limited and H's hole follows the EDGE
    (`horizonHole`), never the reverse. Inward slew must exceed the fastest
    aircraft (coverage shrinks at flight speed while a rebuild is late).
  · A collapsed S sits EXACTLY on H (`SHELL_LIFT = 0`). 1.5 m of lift
    re-drew every low coast as the overlap moved; coplanar z-fight between
    two identical surfaces is invisible.
  · H is plain terrain (no lower envelope — at 1800 m it would shave the
    mountains off the horizon) and is hidden while fully hazed
    (`hazeFar`) or while S does not yet cover the chunk disc.
  WHY IT EXISTS: the world used to end ~35 km out. At 39,000 ft that put
  the "horizon" 17–22° below eye level (real: 3.5°) — most of the screen
  was haze-coloured sky — and its rim popped into view.
- HAZE (sky.ts, lod.visibility): three things had to be true before distant
  terrain would melt into the sky instead of popping in as an outline.
  (1) Fog is TRUE distance, per fragment (ShaderChunk patch at the top of
  sky.ts). three.js fogs by view depth, ~25% short at the screen corners:
  the rim stayed half-visible at the sides. Take the length per FRAGMENT —
  per vertex it is wrong across long triangles (runways under your wheels).
  (2) THREE.Fog gets `sky.sceneFogColor`, not `fogColor`. The dome and
  water shaders write linear values straight to the screen while three's
  materials sRGB-encode, so the same Color came out (198,211,224) on hazed
  terrain and (144,166,190) on the sky behind it: far land was a pale
  cut-out against the horizon however thick the haze. (3) The sun's glow
  on the dome stops at the horizon — below it the dome must be exactly the
  fog colour or the rim shows as an arc under a low sun. Water uses the
  same smoothstep falloff as the scene fog (it was linear).
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
  (tint by level, darkened by collapse — bands show as rings; far shell
  violet), `?lodlog=1` (console.warn each non-seamless swap),
  `?shellonly=1`. The FIRST far shell builds only when the chunk queue is
  idle (never delay spawn terrain) and the horizon shell waits for it —
  keep it that way. `sh=S/H±` in the title counts shell builds (+ = the
  horizon shell is being drawn), `fog=` is the haze reach in km.
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
  wind (pinned in tests/14). Same idea in pitch: on the wheels the alpha
  spring only acts in air arriving from AHEAD (`pitchVane` × forward-flow
  bite) — with the wind abeam or astern the AoA reads up to ±180° and the
  spring sat every aircraft back on its tail at spawn (10–19° nose-up; free
  flight rolls a random wind, so about half of all starts). Drag and side
  force use `skid` (the slip angle measured against whichever end faces
  the wind): 0.5·slip² was Cd ≈ 4.9 in a tailwind and blew a parked trainer
  down the runway. Below 2 m/s the tyres PROJECT the velocity onto the nose
  axis instead of rotating it there (rotation turns a beam-wind push into a
  forward creep). The parked-stance PITCH spring fades with
  weight-on-wheels (1 − L/W): without that, transport wing loadings (A320)
  can never rotate — the G-limit cap shrinks pitch authority with speed
  while the spring never weakened, pinning the nose at ~2° forever.
  Heavies take off with CONF-2 flap and a firm pull (see tests/16).
- WATER / THE SHORELINE (water.ts header): the shoreline is NEVER left to
  the depth buffer, on any device. Every terrain shader discards fragments
  below the waterline (TerrainManager `clipY`) — exact per fragment at any
  range — and the opaque water sheet fills what is left. Anything new that
  renders terrain needs the same discard. Two more rules, both learned the
  hard way when the horizon work put 100+ km of coast on screen:
  · The sheet's world position AND depth are computed per pixel in its
    fragment shader (view ray ∩ plane, uniforms set in `onBeforeRender`),
    never interpolated: across two 420 km triangles the rasteriser is
    metres out and the error moves with the camera — shorelines flickered
    and the seabed shell z-fought through in strips ("gridlines on the
    water").
  · Even with exact depths a depth test is only good to a few ppm of range
    (±3–4 cm of height from 20,000 ft, worse higher) — hundreds of coast
    pixels flipping per frame. Hence the discard; with log depth the sheet
    is still depth-tested (hulls sink into it) but pushed BACK 2e-4 of
    range so land above the waterline always wins.
  · The cut is ANTI-ALIASED (`shoreCut` / `shoreCoverage` in terrain.ts):
    alpha = share of the pixel above the waterline + alpha-to-coverage. A
    bare discard left the coast the one stair-stepped, crawling edge in the
    scene (hard full-contrast pixel flips fell 4–6× with it). The blend
    state keeps that alpha OUT of the canvas (dst alpha preserved) — the
    canvas alpha channel is live and the page showed through.
  Touch + low skips the logarithmic depth buffer (`coarseDepth`); there the
  sheet is drawn FIRST and untested, and the AGL-stepped near plane
  (main.ts frame()) serves everything else. Never bias the sheet TOWARD
  the eye (polygon offset): its slope term is kilometres per pixel at
  altitude and drowned every coast under ~50–100 m.
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
  ARMED FROM CRUISE (tests/20 section 6 — the first tests only ever started
  on final, and a playtester's Vector "overshot the runway"): the mode must
  end in a landing in the zone or a GO-AROUND with a stated reason
  (`ap.goAround`, toasted by main), never anything else. What that took:
  managed speed from the moment of arming (LOC phase slows to 1.45 × clean
  approach speed; the mode may put the speedbrake out and stows only what
  it put out; section 6 caps en-route terrain with `terrainCap` — the
  world has real mountains outside the approach surfaces and the mode has
  no terrain avoidance, that is the pilot's job); the centreline aim point at least ~0.9 turn radii ahead (at
  400 kt the old fixed 3.2 km lead flew 1–4 km through the beam); the
  glideslope taken only once ESTABLISHED (inside the beam AND tracking
  along it — position alone captured while crossing at 90° and descended
  into the hills); and the gates: > 6.5° to the station = too high, at
  ~300 ft gear/height/centreline, at ~100 ft speed, past mid-runway in the
  flare = long. Gear and flaps stay with the pilot by design. Armed above
  the path it used to "land" 5–6 km past the far end.
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
  Two of the cruisers are overflights at 9–12 km with contrails
  (`trailGeo`: vertex-alpha ribbons; the same builder makes ship wakes).
  RUNWAY MOVEMENTS (`updateOps`/`stepOps`, internationals + regionals):
  kinematic arrivals down the 3° path and departures, on the INTO-WIND end
  (`traffic.setWind`, fed by main.rollWind with the flightModel vector).
  Invariants, all in test 17: internationals use only the EASTERN runway
  (`approachesOf` entries 2–3 — the player spawns on the western one); one
  aircraft MOVING on the runway at a time; an arrival that finds it busy at
  900 m — NPC or the player on/over it — goes around, a departure holds;
  nobody passes through terrain (finals and climb-outs stay inside the
  approach surfaces' protection). A departure only taxis on into a gap
  that will still be there when it rolls (~60 s later).
  SHIPS: two each of freighter / ferry / boat on water deeper than 14 m
  within 13 km, steering off shoaling water ahead; hulls are modelled from
  the WATERLINE up (the phone path draws water first, untested).
  traffic.update gets dt 0 while paused (it used to fly on behind the
  pause menu). `npc=` in the autofly title: movements/landings+departures/
  ships.
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
- Streaming is EUCLIDEAN (disc, not Chebyshev square): scan, holes and
  removal all use hypot from the continuous streaming centre; both shells'
  OUTER edges are trimmed to discs and the below-horizon sky dome
  (groundGlow = 1, no sun glow) must stay at the fog colour or the rim
  ghosts through as a colour step at altitude. Keep any new ring logic
  circular.
- shell cell sizes MUST have a small LCM with CHUNK_SIZE (900) — the
  recentre snap grid is that LCM — and the horizon cell must be a multiple
  of the far cell (lattices nest). 450→900, 600→1800, 1800→1800 are fine;
  380/460/680 gave 17–30 km snap grids and the horizon lurched forward in
  giant jumps ("deficit builds then the edge pops in one go" at cruise).
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
  `&mode=approach` (autofly then flies the ILS to an autoland), `&alt=M`
  (jump to a cruise altitude after the fast-forward — horizon work without
  a five-minute climb), `&hdg=deg`, `&touch=1` (the phone render path);
  `&wx=rain` (weather), `&ap=1` (hold the `alt=` altitude — without it the
  autofly climbs out of whatever layer you wanted to look at);
  telemetry is in the tab title (`lod=`, `sh=`, `fog=`, `fps=`, `appr=`,
  `ldg=`, `warn=`). Dark screenshots legitimately compress below 100 kB —
  don't use a large min-size gate to detect boot-screen captures on night
  scenes.
- SWEEPS worth re-running after terrain or traffic changes (they found
  nothing last time, which is the point): every runway of every field in
  all three themes dry, level, glide path and NPC climb-out clear; every
  towered field × 25 simulated minutes of movements with nothing
  underground or off the runway; every (field, aircraft) job board
  non-empty. tests/17, 20 and 26 only cover the home field.
- UI FLOWS without clicking through menus: `__sim` only exists with
  `autofly=1`; from there `__sim.save.mode = 'job'; __sim.openJobs()`,
  `document.querySelector('.job-card').click()`, `__sim.finishJob()` walk
  the whole Charter loop for screenshots.
- PIXEL-DIFF PROOFS: with autofly the sim is on `window.__sim`. To prove a
  streaming change is seamless in the real renderer, `__sim.pause()`, hide
  every DOM node except `__sim.renderer.domElement`, screenshot, perturb,
  screenshot, and diff (PIL `ImageChops.difference`). For shells:
  `__sim.terrain.debugShiftShell(slot, dx, dz)` rebuilds S (0) or H (1)
  with its centre offset, as if the last re-centre had happened there. Any
  offset inside the drift allowance must change ≤ a handful of pixels of
  790,000; always include one deliberately out-of-range shift (9 km on S →
  ~30,000 px) to prove the diff can see. This is what caught the 1.5 m
  shell lift redrawing coastlines — a thing no unit test was looking for.
  A paused frame at altitude is otherwise static (two captures 1 s apart
  diff to 0).
- FLICKER PROOFS (z-fight, shimmer): same paused set-up, then step the
  camera by a fraction of a pixel (`__sim.flightCam.camera.rotateY(4e-5)`,
  ~0.025 px) six times, capturing each. A real edge sweeping past changes a
  pixel ONE way; a pixel whose luminance goes there AND back is flicker.
  Count those. Freeze the wave clock first (`__sim.water.update = () => {}`)
  or the swell drowns the measurement. At 6,100 m the depth-tested
  shoreline scored ~440 flicker pixels of 790,000 (and ~4,000 changed per
  step with the interpolated sheet); the analytic shoreline scores
  ~100–200, all sub-pixel features (ridgelines, ponds, runway edges).
