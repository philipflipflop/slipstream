# SLIPSTREAM — hands-on testing checklist

What automated testing cannot judge: how it looks on a real screen, how it feels
in the hand, how it sounds, and how it runs on a phone. Everything below was
exercised by script (26 test files, world-wide sweeps, 40+ headless-Chrome
runs) unless it says otherwise; these are the checks that need eyes, ears and
thumbs.

For anything that looks wrong, the useful details are: where on screen, what
altitude, which aircraft / world / time of day / weather / quality setting, and
desktop or phone.

## 1. Look (desktop)

- [ ] **Water edge flicker** — coast below you at 5,000 ft and at 20,000 ft, fly
      straight for a minute. Still "just a little", better, or worse?
- [ ] **Horizon pop** — climb to 30,000 ft+ and cruise fast (Typhoon). Does
      anything appear or sharpen suddenly at the far edge?
- [ ] **Low-level view** — on the runway and at 1,000 ft: you should see about
      16 km (High). Does the far terrain look acceptable, or too bare/blocky
      between ~8 and 16 km?
- [ ] **Terrain** — hills, rivers, farmland, a volcano (one is ~30 km
      north-west of Meridian). Any straight lines, walls, streaks or holes?
      Do distant rivers breaking into dots bother you?
- [ ] **Mesa and Meridian Bay** — one flight in each: buttes/dunes look right;
      city skyline appears sensibly as you approach.
- [ ] **Clouds from every side** (reworked after "sheet of paper": the layer
      is now a lumpy volume with soft edges) — Rain and Overcast: climb
      through (grey below → white-out → in and out of the tops → sunshine)
      and descend again. Does it read as cloud now? Any grain, rings or
      hard edges? Is the HUD readable over the white tops?
- [ ] **Broken** — fly through a gap at 4,500–5,500 ft and past a cloud's
      side. Do the cloud bodies look solid from every angle?
- [ ] **Cloud frame rate** — Rain/Overcast on the phone and on desktop High:
      noticeably slower than Fair?
- [ ] **Rain** — streaks parked, at 100 kt and at 300 kt. Too many, too few,
      too bright?
- [ ] **Fog** — take off into it and land in it. Can you read the green HUD
      against white?
- [ ] **Night + Overcast** — too dark to be usable?
- [ ] **Golden Hour above the overcast** — very orange. Too much?
- [ ] **Hangar menu** — weather row visible without scrolling at your normal
      window size; all four mode buttons fit.

## 2. Feel

- [ ] **Engine failure, single** — Skylark at 3,000 ft, press `X`, hold the
      HUD's glide speed, land it on a field. Fair? Too easy/hard?
- [ ] **Engine failure, twin** — Islander just after take-off, press `X` once.
      Does it need a believable amount of right rudder? Controllable?
- [ ] **A320 on one engine** — fly a circuit and land.
- [ ] **Autopilot glide** — AP on, then fail every engine: it should say
      `AP · GLIDE` and hold the glide speed.
- [ ] **G-meter** — now reads 1.0 in level flight (it used to read 1.7–1.9).
      Does a hard turn read sensibly?
- [ ] **Wind and turbulence by weather** — Rain should feel rougher than
      Fair; Fog nearly still. Is Rain's turbulence too much on final?
- [ ] **Autoland from cruise** — Vector, armed about 15 km out at 2,500 ft.
      Lands, or goes around with a reason you agree with?
- [ ] **Ring Rush** — the course now climbs a bigger hill. Flyable in the
      Skylark? (Old best times no longer compare.)

## 3. Charter jobs (never flown by hand)

- [ ] Fly one whole job in a light aircraft: board → take-off → navigate by
      the map ring and the NAV readout → land → stop. Does it pay when you
      stop? Is the pay breakdown understandable?
- [ ] **Par time** — did you beat it flying normally? Too tight or too slack?
- [ ] **Ride score** — stays 100% in gentle flying, drops for steep banks and
      a hard landing. Feels fair?
- [ ] Land at the **wrong** field and stop — it should tell you.
- [ ] **Next Job** from the destination, then **Hangar**, then back to Charter:
      are you based where you expect? (A page reload returns you to Meridian.)
- [ ] One job in the **helicopter** (lands anywhere on the destination field).
- [ ] One job in the **A320** (internationals only — are ~100 km legs OK?).

## 4. Traffic, map, radio

- [ ] At Meridian, watch the **eastern** runway for five minutes: arrivals and
      departures look plausible? Aircraft appearing/vanishing at the holding
      point acceptable?
- [ ] Taxi onto that runway and sit there: the next arrival should go around
      and the tower should tell you why.
- [ ] **Map** — cyan arrowheads with ±height, grey ship ticks. Readable at the
      docked size? Cluttered?
- [ ] **Tower calls** — "cleared to land" on final at an international. Do
      calls ever cover a message you needed, or come too often?
- [ ] **Contrails and ships** — noticeable? Wakes look right from low level?

## 5. Sound (I cannot hear anything)

- [ ] Engine note drops when an engine fails; windmilling/silent with all out.
- [ ] Radio "blip" before tower calls — pleasant or annoying?
- [ ] No sound continuing behind the job board or the pay screen.

## 6. Phone / tablet (none of this has been on a real device)

- [ ] It loads and holds a playable frame rate in **Fair**, then **Overcast**
      and **Rain** (clouds and rain are new GPU work).
- [ ] Water edge and shoreline on the phone's render path.
- [ ] Hangar: weather chips reachable (the card scrolls); **Charter** job board
      fits and the cards are tappable.
- [ ] In flight: the job strip and tower messages do not sit under the
      top-row buttons or the notch.
- [ ] **ENG** button now shows for every aircraft — works, and not easy to hit
      by accident?
- [ ] iPhone: sound still plays alongside your music and with the mute
      switch on.

## 7. Performance and endurance (your hardware)

- [ ] Frame rate on High at 20,000 ft+ (the horizon mesh is ~45% bigger).
- [ ] A 20–30 minute session without slowdown or stutter.
- [ ] Gamepad still works, including in Charter.

## 8. Old saves

- [ ] Your existing save loads with settings, best times and landings intact
      (checked by script with a synthetic old save, not with yours).
