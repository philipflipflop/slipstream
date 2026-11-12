/**
 * Gamepad → flight controls. Pure mapping (no DOM), so the dead zones,
 * response curve and button edges are unit-tested; InputManager polls the
 * browser's Gamepad API each frame and feeds the raw arrays through here.
 *
 * Standard-layout pads (Xbox / PlayStation / Switch Pro):
 *   left stick      roll / pitch (pull back = nose up)
 *   right stick X   rudder
 *   RT / LT         throttle up / down (analog rate — it stays where you leave it)
 *   A               wheel brakes / cannon (hold)
 *   B               speed brake          X   camera
 *   Y               landing gear         LB / RB   flaps up / down a notch
 *   D-pad up        autopilot            D-pad down   APPR (ILS autoland)
 *   D-pad left      HUD mode             D-pad right  nav chart
 *   Start           pause                Back / View  minimap
 *
 * Anything else (flight sticks, HOTAS) reports mapping "" and varies by
 * model, so only the universal part is assumed: axes 0/1 are the stick,
 * button 0 is the trigger.
 */

export type PadAction =
  | 'airbrake' | 'camera' | 'gear' | 'flapsUp' | 'flapsDown'
  | 'autopilot' | 'approach' | 'hud' | 'nav' | 'pause' | 'map';

export interface PadButton { pressed: boolean; value: number }

export interface PadFrame {
  roll: number;      // -1..1, + = right
  pitch: number;     // -1..1, + = pull
  yaw: number;       // -1..1, + = right rudder
  /** throttle slew, -1..1 (multiply by a rate and dt) */
  throttleRate: number;
  brakes: boolean;
  /** the stick is deflected: counts as manual input (kicks the autopilot off) */
  stick: boolean;
  /** buttons that went down THIS frame, as actions */
  actions: PadAction[];
}

const DEAD = 0.12;
const EXPO = 0.4;

/**
 * Dead zone + response curve: nothing inside the dead zone, then a blend of
 * linear and cubic rescaled so full deflection is still exactly 1 — fine
 * control around centre without giving up authority at the stops.
 */
export function shapeAxis(v: number, dead = DEAD, expo = EXPO): number {
  if (!Number.isFinite(v)) return 0;
  const a = Math.abs(v);
  if (a <= dead) return 0;
  const t = Math.min((a - dead) / (1 - dead), 1);
  return Math.sign(v) * ((1 - expo) * t + expo * t * t * t);
}

const STANDARD_ACTIONS: Array<[number, PadAction]> = [
  [1, 'airbrake'], [2, 'camera'], [3, 'gear'], [4, 'flapsUp'], [5, 'flapsDown'],
  [12, 'autopilot'], [13, 'approach'], [14, 'hud'], [15, 'nav'], [9, 'pause'], [8, 'map'],
];

/**
 * One frame of pad state. `prev` holds last frame's button states and is
 * updated in place (edge detection) — pass the same array every frame.
 */
export function readPad(
  axes: readonly number[],
  buttons: readonly PadButton[],
  standard: boolean,
  prev: boolean[],
): PadFrame {
  const ax = (i: number): number => shapeAxis(axes[i] ?? 0);
  const down = (i: number): boolean => !!buttons[i]?.pressed;
  const val = (i: number): number => {
    const b = buttons[i];
    return b ? (b.value > 0 ? b.value : b.pressed ? 1 : 0) : 0;
  };
  const roll = ax(0);
  const pitch = ax(1); // stick back reads +1 on every pad: pull = nose up
  const out: PadFrame = {
    roll, pitch,
    yaw: standard ? ax(2) : 0,
    throttleRate: standard ? val(7) - val(6) : 0,
    brakes: down(0),
    stick: roll !== 0 || pitch !== 0,
    actions: [],
  };
  if (standard) {
    for (const [i, action] of STANDARD_ACTIONS) {
      if (down(i) && !prev[i]) out.actions.push(action);
    }
  }
  for (let i = 0; i < buttons.length; i++) prev[i] = down(i);
  prev.length = buttons.length;
  return out;
}
