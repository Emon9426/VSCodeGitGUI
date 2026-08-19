/** 与扩展宿主的 postMessage RPC。 */
import type { ExtResponse, WVRequest } from '../common/protocol';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscodeApi = acquireVsCodeApi();

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let seq = 1;

export function rpc(cmd: string, args?: Record<string, unknown>): Promise<any> {
  const id = seq++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`request timeout: ${cmd}`));
      }
    }, 120_000);
  });
  vscodeApi.postMessage({ id, cmd, args } as WVRequest);
  return p;
}

export function handleResponse(m: ExtResponse): void {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.data);
  else p.reject(new Error(m.error ?? `request failed: ${m.id}`));
}

export function postRaw(msg: unknown): void {
  vscodeApi.postMessage(msg);
}
