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
  rendering, collision, scatter, minimap, and airfield placement (3 fixed +
  procedural strips on a 12 km cell grid). Change terrain in one place only.
- `src/world/terrainBuilder.ts` — pure payload builder (no three.js/DOM), runs in
  `terrain.worker.ts` with a synchronous fallback. Chunk LODs nest (56/28/14) and
  every payload carries `baseY` geomorph starts; the far horizon shell shares
  `shellVertexHeight` so fresh chunks rise exactly off the rendered shell.
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
- Mobile rendering: touch devices skip the logarithmic depth buffer, so they rely
  on the AGL-scaled near plane (main.ts frame()) + the water sheet's polygon
  offset/raise (`Water` `coarseDepth` flag) to avoid shoreline z-fighting.
- `src/aircraft/flightModel.ts` — `stepFlight` branches to `stepHeli` when
  `spec.engine === 'heli'` (Bell 505): throttle = collective, cyclic is
  attitude-command (`inp.pitch·0.45` / `−inp.roll·0.6` are the target Euler
  angles — the autopilot's heli branch writes attitude targets straight
  through the stick), pedals are yaw rate. Realism terms (all in stepHeli,
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
  wheels (sink > 5 m/s, roll, slope, run-on > 16 m/s).
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
- PAPI (airport.ts): four boxes per field, per-frame red/white from the
  aircraft's actual angle to each box vs [3.5, 3.2, 2.8, 2.5]°; world
  positions captured after the field pivot via getWorldPosition.
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
