/**
 * DOM chrome: hangar menu (with live 3D aircraft preview rendered by the
 * game behind it), pause / crash / victory panels, controls + settings,
 * toasts. Pure DOM — the canvas underneath stays in charge of pixels.
 */
import { CATALOG } from '../aircraft/catalog';
import { WORLDS, WorldTheme } from '../world/heightfield';
import type { SaveData, Quality } from '../save';
import { formatTime } from '../core/math';

export interface DebriefStats {
  flightTime: number;
  distanceKm: number;
  maxAltFt: number;
  maxSpdKt: number;
}

type ScreenName = 'menu' | 'pause' | 'crash' | 'victory' | null;

export class Screens {
  // callbacks wired by main.ts
  onFly: () => void = () => {};
  onResume: () => void = () => {};
  onRestart: () => void = () => {};
  onHangar: () => void = () => {};
  onAircraft: (id: string) => void = () => {};
  onMode: (mode: 'free' | 'race') => void = () => {};
  onWorld: (world: WorldTheme) => void = () => {};
  onSettings: () => void = () => {};
  onAnyClick: () => void = () => {};
  /** kind: 'hdg' | 'alt' | 'spd'; dir: -1 | 1 */
  onApAdjust: (kind: 'hdg' | 'alt' | 'spd', dir: number) => void = () => {};

  private save: SaveData;
  private menuEl!: HTMLDivElement;
  private pauseEl!: HTMLDivElement;
  private crashEl!: HTMLDivElement;
  private victoryEl!: HTMLDivElement;
  private helpEl!: HTMLDivElement;
  private settingsEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private pauseBtn!: HTMLButtonElement;
  private rotateHint!: HTMLDivElement;
  private apPanel!: HTMLDivElement;
  private apVals!: { hdg: HTMLElement; alt: HTMLElement; spd: HTMLElement };
  private toastTimer = 0;
  private isTouch: boolean;

  current: ScreenName = null;

  constructor(save: SaveData, isTouch: boolean) {
    this.save = save;
    this.isTouch = isTouch;
    this.buildMenu();
    this.buildPause();
    this.buildCrash();
    this.buildVictory();
    this.buildHelp();
    this.buildSettings();
    this.buildMisc();
    document.body.addEventListener('pointerdown', () => this.onAnyClick(), { capture: true });
  }

  /* ---------------- helpers ---------------- */

  private el(html: string): HTMLDivElement {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild as HTMLDivElement;
  }

  show(name: ScreenName): void {
    this.current = name;
    this.menuEl.classList.toggle('on', name === 'menu');
    this.pauseEl.classList.toggle('on', name === 'pause');
    this.crashEl.classList.toggle('on', name === 'crash');
    this.victoryEl.classList.toggle('on', name === 'victory');
    this.pauseBtn.classList.toggle('show', name === null && this.isTouch);
    if (name !== null) {
      this.helpEl.classList.remove('on');
      this.settingsEl.classList.remove('on');
      this.apPanel.classList.remove('show'); // flight HUD re-shows it if engaged
    }
  }

  toast(msg: string, ms = 1800): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  setPortraitWarning(flying: boolean): void {
    const portrait = window.innerHeight > window.innerWidth * 1.2;
    document.body.classList.toggle('portrait-flying', this.isTouch && flying && portrait);
  }

  /* ---------------- menu ---------------- */

  private buildMenu(): void {
    const m = this.el(`
      <div class="screen" id="menu" style="background:
        linear-gradient(180deg, rgba(7,13,24,.88) 0%, rgba(7,13,24,.25) 22%, rgba(7,13,24,0) 45%,
        rgba(7,13,24,0) 62%, rgba(7,13,24,.82) 100%);">
        <div class="screen-inner">
          <div class="menu-head">
            <div class="kicker rule-r">open skies · est. 2026</div>
            <h1 class="title-xl">SLIPSTREAM</h1>
            <div class="tagline">an endless-world flight simulator</div>
          </div>
          <div class="menu-body">
            <div class="hangar-view">
              <div class="deck"></div>
              <button class="carousel-nav prev" aria-label="previous aircraft">‹</button>
              <button class="carousel-nav next" aria-label="next aircraft">›</button>
              <div class="hangar-dots"></div>
            </div>
            <div class="spec-card">
              <div class="reg"></div>
              <h2 class="ac-name"></h2>
              <div class="role"></div>
              <p class="blurb"></p>
              <div class="stats"></div>
              <div class="mode-row">
                <button class="mode-chip" data-mode="free">
                  <div class="mc-name">Free Flight</div>
                  <div class="mc-desc">Explore an endless world</div>
                </button>
                <button class="mode-chip" data-mode="race">
                  <div class="mc-name">Ring Rush</div>
                  <div class="mc-desc">14 gates against the clock</div>
                </button>
              </div>
              <div class="world-row"></div>
              <div class="best-time"></div>
            </div>
          </div>
          <div class="menu-foot">
            <div class="left">
              <button class="btn primary fly">Take Off ✈</button>
            </div>
            <div class="right">
              <button class="btn ghost controls-btn">Controls</button>
              <button class="btn ghost settings-btn">Settings</button>
            </div>
          </div>
        </div>
      </div>`);
    document.body.appendChild(m);
    this.menuEl = m;

    const dots = m.querySelector('.hangar-dots')!;
    CATALOG.forEach(() => dots.appendChild(document.createElement('i')));

    m.querySelector('.prev')!.addEventListener('click', () => this.stepAircraft(-1));
    m.querySelector('.next')!.addEventListener('click', () => this.stepAircraft(1));
    m.querySelector('.fly')!.addEventListener('click', () => this.onFly());
    m.querySelector('.controls-btn')!.addEventListener('click', () => this.helpEl.classList.add('on'));
    m.querySelector('.settings-btn')!.addEventListener('click', () => this.settingsEl.classList.add('on'));
    m.querySelectorAll<HTMLButtonElement>('.mode-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.save.mode = chip.dataset.mode as 'free' | 'race';
        this.onMode(this.save.mode);
        this.refreshMenu();
      });
    });

    // world (map) selector
    const wRow = m.querySelector('.world-row')!;
    wRow.innerHTML = WORLDS.map(
      (w) => `
      <button class="world-chip" data-world="${w.id}">
        <div class="wc-name">${w.name}</div>
        <div class="wc-desc">${w.desc}</div>
      </button>`,
    ).join('');
    wRow.querySelectorAll<HTMLButtonElement>('.world-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.world as WorldTheme;
        if (id !== this.save.world) this.onWorld(id);
      });
    });

    window.addEventListener('keydown', (e) => {
      if (this.current !== 'menu') return;
      if (e.code === 'ArrowLeft') this.stepAircraft(-1);
      else if (e.code === 'ArrowRight') this.stepAircraft(1);
      else if (e.code === 'Enter') this.onFly();
    });

    this.refreshMenu();
  }

  private stepAircraft(dir: number): void {
    const idx = CATALOG.findIndex((s) => s.id === this.save.aircraft);
    const next = (idx + dir + CATALOG.length) % CATALOG.length;
    this.save.aircraft = CATALOG[next].id;
    this.onAircraft(this.save.aircraft);
    this.refreshMenu();
  }

  refreshMenu(): void {
    const spec = CATALOG.find((s) => s.id === this.save.aircraft) ?? CATALOG[0];
    const m = this.menuEl;
    m.querySelector('.reg')!.textContent = `■ ${spec.reg}`;
    m.querySelector('.ac-name')!.textContent = spec.name;
    m.querySelector('.role')!.textContent = spec.role;
    m.querySelector('.blurb')!.textContent = spec.blurb;

    const stats = m.querySelector('.stats')!;
    const rows: Array<[string, number, string]> = [
      ['Speed', spec.stats.speed, `${spec.topSpeedKt} kt`],
      ['Agility', spec.stats.agility, ''],
      ['Handling', spec.stats.handling, ''],
      ['Climb', spec.stats.climb, ''],
    ];
    stats.innerHTML = rows
      .map(
        ([lbl, v, val]) => `
        <div class="stat-row">
          <span class="lbl">${lbl}</span>
          <span class="bar"><i style="transform: scaleX(${v})"></i></span>
          <span class="val">${val}</span>
        </div>`,
      )
      .join('');

    m.querySelectorAll<HTMLButtonElement>('.mode-chip').forEach((chip) => {
      chip.classList.toggle('on', chip.dataset.mode === this.save.mode);
    });
    m.querySelectorAll<HTMLButtonElement>('.world-chip').forEach((chip) => {
      chip.classList.toggle('on', chip.dataset.world === this.save.world);
    });

    const best = this.save.bestTimes[spec.id];
    m.querySelector('.best-time')!.innerHTML =
      this.save.mode === 'race'
        ? best
          ? `RING RUSH BEST — <b>${formatTime(best)}</b>`
          : 'RING RUSH — no time set in this aircraft'
        : '';

    m.querySelectorAll('.hangar-dots i').forEach((dot, i) => {
      dot.classList.toggle('on', CATALOG[i].id === spec.id);
    });
  }

  /* ---------------- pause ---------------- */

  private buildPause(): void {
    const p = this.el(`
      <div class="screen">
        <div class="veil"></div>
        <div class="panel">
          <div class="kicker">paused</div>
          <h2>HOLDING PATTERN</h2>
          <div class="row">
            <button class="btn primary resume">Resume</button>
            <button class="btn restart">Restart Flight</button>
          </div>
          <div class="row">
            <button class="btn ghost controls-btn">Controls</button>
            <button class="btn ghost settings-btn">Settings</button>
            <button class="btn ghost hangar">Hangar</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(p);
    this.pauseEl = p;
    p.querySelector('.resume')!.addEventListener('click', () => this.onResume());
    p.querySelector('.restart')!.addEventListener('click', () => this.onRestart());
    p.querySelector('.hangar')!.addEventListener('click', () => this.onHangar());
    p.querySelector('.controls-btn')!.addEventListener('click', () => this.helpEl.classList.add('on'));
    p.querySelector('.settings-btn')!.addEventListener('click', () => this.settingsEl.classList.add('on'));
  }

  /* ---------------- crash / victory ---------------- */

  private debriefHtml(stats: DebriefStats, extra = ''): string {
    return `
      <div class="debrief">
        ${extra}
        <div class="cell"><div class="k">Flight time</div><div class="v">${formatTime(stats.flightTime)}</div></div>
        <div class="cell"><div class="k">Distance</div><div class="v">${stats.distanceKm.toFixed(1)} km</div></div>
        <div class="cell"><div class="k">Max altitude</div><div class="v">${Math.round(stats.maxAltFt)} ft</div></div>
        <div class="cell"><div class="k">Max speed</div><div class="v">${Math.round(stats.maxSpdKt)} kt</div></div>
      </div>`;
  }

  private buildCrash(): void {
    const c = this.el(`
      <div class="screen">
        <div class="veil"></div>
        <div class="panel crash">
          <div class="kicker">flight terminated</div>
          <h2 class="reason">AIRFRAME LOST</h2>
          <div class="stats-slot"></div>
          <div class="row">
            <button class="btn primary restart">Fly Again</button>
            <button class="btn ghost hangar">Hangar</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(c);
    this.crashEl = c;
    c.querySelector('.restart')!.addEventListener('click', () => this.onRestart());
    c.querySelector('.hangar')!.addEventListener('click', () => this.onHangar());
  }

  showCrash(reason: string, stats: DebriefStats): void {
    this.crashEl.querySelector('.reason')!.textContent = reason;
    this.crashEl.querySelector('.stats-slot')!.innerHTML = this.debriefHtml(stats);
    this.show('crash');
  }

  private buildVictory(): void {
    const v = this.el(`
      <div class="screen">
        <div class="veil"></div>
        <div class="panel victory">
          <div class="kicker">course complete</div>
          <h2>ALL GATES CLEARED</h2>
          <div class="stats-slot"></div>
          <div class="row">
            <button class="btn primary restart">Run It Again</button>
            <button class="btn ghost hangar">Hangar</button>
          </div>
        </div>
      </div>`);
    document.body.appendChild(v);
    this.victoryEl = v;
    v.querySelector('.restart')!.addEventListener('click', () => this.onRestart());
    v.querySelector('.hangar')!.addEventListener('click', () => this.onHangar());
  }

  showVictory(time: number, best: number, isRecord: boolean, stats: DebriefStats): void {
    const extra = `
      <div class="cell"><div class="k">Time</div><div class="v green">${formatTime(time)}</div></div>
      <div class="cell"><div class="k">${isRecord ? 'New record!' : 'Best'}</div><div class="v">${formatTime(best)}</div></div>`;
    this.victoryEl.querySelector('.stats-slot')!.innerHTML = this.debriefHtml(stats, extra);
    this.show('victory');
  }

  /* ---------------- help ---------------- */

  private buildHelp(): void {
    const touchRows = `
      <div class="krow"><span>Pitch & roll</span><kbd>left stick</kbd></div>
      <div class="krow"><span>Throttle</span><kbd>right lever</kbd></div>
      <div class="krow"><span>Rudder</span><kbd>RUD pedals</kbd></div>
      <div class="krow"><span>Brakes / fire cannon (airborne)</span><kbd>BRAKE (hold)</kbd></div>
      <div class="krow"><span>Gear / flaps / camera / AP</span><kbd>top buttons</kbd></div>
      <div class="krow"><span>Flight computer (chart)</span><kbd>NAV</kbd></div>
      <div class="krow"><span>Pause</span><kbd>⏸ top right</kbd></div>`;
    const keyRows = `
      <div class="krow"><span>Pitch</span><kbd>W / S</kbd></div>
      <div class="krow"><span>Roll</span><kbd>A / D</kbd></div>
      <div class="krow"><span>Rudder</span><kbd>Q / E</kbd></div>
      <div class="krow"><span>Throttle</span><kbd>Shift / Ctrl</kbd></div>
      <div class="krow"><span>Throttle presets</span><kbd>1 – 9, 0</kbd></div>
      <div class="krow"><span>Flaps</span><kbd>F / V</kbd></div>
      <div class="krow"><span>Landing gear</span><kbd>G</kbd></div>
      <div class="krow"><span>Wheel brakes / fire cannon (airborne)</span><kbd>Space</kbd></div>
      <div class="krow"><span>Speed brake</span><kbd>B</kbd></div>
      <div class="krow"><span>Autopilot hold</span><kbd>T</kbd></div>
      <div class="krow"><span>AP heading bug</span><kbd>[ / ]</kbd></div>
      <div class="krow"><span>AP altitude bug</span><kbd>PgUp / PgDn</kbd></div>
      <div class="krow"><span>AP speed bug</span><kbd>Home / End</kbd></div>
      <div class="krow"><span>Nav chart / flight computer</span><kbd>N</kbd></div>
      <div class="krow"><span>Chart zoom</span><kbd>, / .</kbd></div>
      <div class="krow"><span>Camera</span><kbd>C</kbd></div>
      <div class="krow"><span>Look around / zoom</span><kbd>Mouse drag / wheel</kbd></div>
      <div class="krow"><span>HUD full / min / off</span><kbd>H</kbd></div>
      <div class="krow"><span>Minimap</span><kbd>M</kbd></div>
      <div class="krow"><span>Restart flight</span><kbd>R</kbd></div>
      <div class="krow"><span>Pause</span><kbd>Esc / P</kbd></div>`;
    const h = this.el(`
      <div class="screen" style="z-index:70">
        <div class="veil"></div>
        <div class="panel">
          <div class="kicker">flight manual</div>
          <h2>CONTROLS</h2>
          <div class="keys">${this.isTouch ? touchRows + keyRows : keyRows}</div>
          <p style="color:var(--fog);font-size:12.5px;line-height:1.5">
            Flying 101: full throttle, let speed build past the white arc, then ease back.
            Keep the nose where the speed stays healthy — if <b style="color:var(--danger)">STALL</b> flashes,
            push forward and add power. Land into the runway slow, flaps down, gentle sink.
            Press <kbd>N</kbd> for the flight computer: click the chart to plan a route
            (clicks near a runway snap to it), then ENGAGE NAV and the autopilot flies it.
            In the Vector, hold <kbd>Space</kbd> airborne to fire — ten target balloons
            float east of Meridian Field.
          </p>
          <div class="row"><button class="btn primary close">Got It</button></div>
        </div>
      </div>`);
    document.body.appendChild(h);
    this.helpEl = h;
    h.querySelector('.close')!.addEventListener('click', () => h.classList.remove('on'));
  }

  /* ---------------- settings ---------------- */

  private buildSettings(): void {
    const s = this.el(`
      <div class="screen" style="z-index:70">
        <div class="veil"></div>
        <div class="panel">
          <div class="kicker">configuration</div>
          <h2>SETTINGS</h2>
          <div class="set-grid">
            <div class="set-row"><span class="s-lbl">Graphics</span>
              <div class="seg" data-key="quality">
                <button data-v="low">Low</button><button data-v="medium">Med</button><button data-v="high">High</button>
              </div>
            </div>
            <div class="set-row"><span class="s-lbl">Invert pitch</span>
              <div class="seg" data-key="invertY">
                <button data-v="false">Off</button><button data-v="true">On</button>
              </div>
            </div>
            <div class="set-row"><span class="s-lbl">Sensitivity</span>
              <div class="seg" data-key="sensitivity">
                <button data-v="0.65">Low</button><button data-v="1">Std</button><button data-v="1.4">High</button>
              </div>
            </div>
            <div class="set-row"><span class="s-lbl">Sound</span>
              <div class="seg" data-key="muted">
                <button data-v="false">On</button><button data-v="true">Off</button>
              </div>
            </div>
          </div>
          <div class="row"><button class="btn primary close">Done</button></div>
        </div>
      </div>`);
    document.body.appendChild(s);
    this.settingsEl = s;
    s.querySelector('.close')!.addEventListener('click', () => s.classList.remove('on'));

    s.querySelectorAll<HTMLDivElement>('.seg').forEach((seg) => {
      seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.addEventListener('click', () => {
          const key = seg.dataset.key!;
          const v = b.dataset.v!;
          if (key === 'quality') this.save.quality = v as Quality;
          else if (key === 'invertY') this.save.invertY = v === 'true';
          else if (key === 'sensitivity') this.save.sensitivity = Number(v);
          else if (key === 'muted') this.save.muted = v === 'true';
          this.syncSettings();
          this.onSettings();
        });
      });
    });
    this.syncSettings();
  }

  syncSettings(): void {
    const vals: Record<string, string> = {
      quality: this.save.quality,
      invertY: String(this.save.invertY),
      sensitivity: String(this.save.sensitivity),
      muted: String(this.save.muted),
    };
    this.settingsEl.querySelectorAll<HTMLDivElement>('.seg').forEach((seg) => {
      const cur = vals[seg.dataset.key!];
      seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.classList.toggle('on', b.dataset.v === cur);
      });
    });
  }

  /* ---------------- misc ---------------- */

  /** Show/refresh the autopilot target panel (values pre-formatted). */
  setApPanel(visible: boolean, hdg?: string, alt?: string, spd?: string): void {
    this.apPanel.classList.toggle('show', visible);
    if (visible) {
      if (hdg !== undefined) this.apVals.hdg.textContent = hdg;
      if (alt !== undefined) this.apVals.alt.textContent = alt;
      if (spd !== undefined) this.apVals.spd.textContent = spd;
    }
  }

  private buildApPanel(): void {
    this.apPanel = this.el(`
      <div id="appanel">
        <div class="ap-title">AUTOPILOT</div>
        <div class="ap-row" data-k="hdg">
          <span class="ap-lbl">HDG</span><button data-d="-1">−</button>
          <span class="ap-val" data-v="hdg">000°</span><button data-d="1">+</button>
        </div>
        <div class="ap-row" data-k="alt">
          <span class="ap-lbl">ALT</span><button data-d="-1">−</button>
          <span class="ap-val" data-v="alt">0 FT</span><button data-d="1">+</button>
        </div>
        <div class="ap-row" data-k="spd">
          <span class="ap-lbl">SPD</span><button data-d="-1">−</button>
          <span class="ap-val" data-v="spd">0 KT</span><button data-d="1">+</button>
        </div>
      </div>`);
    document.body.appendChild(this.apPanel);
    this.apVals = {
      hdg: this.apPanel.querySelector('[data-v="hdg"]')!,
      alt: this.apPanel.querySelector('[data-v="alt"]')!,
      spd: this.apPanel.querySelector('[data-v="spd"]')!,
    };

    // press = one tick; hold = auto-repeat, like a real AP bug knob
    this.apPanel.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const kind = (b.parentElement as HTMLElement).dataset.k as 'hdg' | 'alt' | 'spd';
      const dir = Number(b.dataset.d);
      let timer = 0;
      let repeater = 0;
      const fire = (): void => this.onApAdjust(kind, dir);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fire();
        timer = window.setTimeout(() => {
          repeater = window.setInterval(fire, 110);
        }, 380);
      });
      const stop = (): void => {
        window.clearTimeout(timer);
        window.clearInterval(repeater);
      };
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('pointerleave', stop);
    });
  }

  private buildMisc(): void {
    this.buildApPanel();
    this.toastEl = this.el(`<div id="toast"></div>`);
    document.body.appendChild(this.toastEl);

    this.pauseBtn = document.createElement('button');
    this.pauseBtn.id = 'pausebtn';
    this.pauseBtn.textContent = '⏸';
    this.pauseBtn.addEventListener('click', () => this.onResume()); // toggles pause via main
    document.body.appendChild(this.pauseBtn);

    this.rotateHint = this.el(`
      <div id="rotate-hint">
        <div class="phone">📱</div>
        <div>Rotate to landscape<br/>for the full cockpit</div>
      </div>`);
    document.body.appendChild(this.rotateHint);
  }
}
