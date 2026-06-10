/**
 * Terrain worker: receives chunk build jobs, runs the heavy noise/geometry
 * math off the main thread, and posts transferable payloads back.
 */
import { WorldGen } from './heightfield';
import { buildChunkPayload, payloadTransfers } from './terrainBuilder';

interface InitMsg { type: 'init'; seed: number }
interface BuildMsg { type: 'build'; cx: number; cz: number; res: number; scatter: 0 | 1 | 2 }
type Msg = InitMsg | BuildMsg;

let gen: WorldGen | null = null;

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = new WorldGen(msg.seed);
    return;
  }
  if (!gen) return;
  const payload = buildChunkPayload(gen, msg.cx, msg.cz, msg.res, msg.scatter);
  (self as unknown as Worker).postMessage(payload, payloadTransfers(payload));
};
