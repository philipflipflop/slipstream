/**
 * Terrain worker: receives chunk build jobs, runs the heavy noise/geometry
 * math off the main thread, and posts transferable payloads back.
 */
import { WorldGen, WorldTheme } from './heightfield';
import { buildChunkPayload, payloadTransfers, buildFarPayload, farTransfers } from './terrainBuilder';

interface InitMsg { type: 'init'; seed: number; theme: WorldTheme }
interface BuildMsg {
  type: 'build'; cx: number; cz: number; res: number; scatter: 0 | 1 | 2;
  prev: number; shellCell: number;
}
interface FarMsg { type: 'far'; ox: number; oz: number; cells: number; cellSize: number }
type Msg = InitMsg | BuildMsg | FarMsg;

let gen: WorldGen | null = null;

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = new WorldGen(msg.seed, msg.theme);
    return;
  }
  if (!gen) return;
  if (msg.type === 'far') {
    const p = buildFarPayload(gen, msg.ox, msg.oz, msg.cells, msg.cellSize);
    (self as unknown as Worker).postMessage(p, farTransfers(p));
    return;
  }
  const payload = buildChunkPayload(gen, msg.cx, msg.cz, msg.res, msg.scatter, msg.prev, msg.shellCell);
  (self as unknown as Worker).postMessage(payload, payloadTransfers(payload));
};
