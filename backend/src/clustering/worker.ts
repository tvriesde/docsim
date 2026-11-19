import { parentPort } from 'node:worker_threads';
import { computeLayout, type LayoutParams } from './layout.js';

interface Request {
  vectors: number[][];
  overrides: Partial<LayoutParams>;
}

parentPort?.on('message', (msg: Request) => {
  try {
    parentPort!.postMessage({ ok: true, result: computeLayout(msg.vectors, msg.overrides) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: (err as Error).message });
  }
});
