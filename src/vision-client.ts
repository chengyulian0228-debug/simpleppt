import type { VisualEvidence } from './vision-policy';

let worker: Worker | undefined;
// Requests are serial: one document at a time, one image at a time.
export function closeVision() { worker?.terminate(); worker = undefined; }
export async function inspectVisual(pixels: Uint8Array, width: number, height: number, host: string, signal: AbortSignal, progress: (message: string) => void): Promise<VisualEvidence> {
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  worker ||= new Worker(new URL('./vision-worker.ts', import.meta.url), { type: 'module' });
  const active = worker;
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); active.onmessage = active.onerror = null; };
    const fail = (error: Error) => { cleanup(); closeVision(); reject(error); };
    const abort = () => fail(new DOMException('已取消', 'AbortError'));
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('图片模型加载或识别超时。请切换模型下载源后重试，或选择基础清理。')), 120_000); };
    signal.addEventListener('abort', abort, { once: true });
    active.onerror = () => fail(new Error('本地图片模型启动失败。请使用新版浏览器，或切换为基础清理。'));
    active.onmessage = event => {
      const data = event.data;
      if (data.type === 'status') { resetTimeout(); progress(data.message); }
      else if (data.type === 'progress') {
        resetTimeout();
        if (data.total > 1_000_000) progress(`正在下载图片模型 ${Math.round(data.loaded / data.total * 100)}%（首次约 154 MB，后续使用缓存）`);
        else if (data.loaded > 1_000_000) progress(`已下载图片模型 ${(data.loaded / 1_000_000).toFixed(0)} MB（首次约 154 MB）`);
      } else if (data.type === 'result') { cleanup(); resolve({ scores: data.scores }); }
      else if (data.type === 'error') fail(new Error('图片模型加载或识别失败。请切换模型下载源重试；基础清理仍可使用。'));
    };
    resetTimeout();
    const runtime = new URL(`${import.meta.env.BASE_URL}vision-runtime/`, document.baseURI).href;
    active.postMessage({ pixels, width, height, host, runtime });
  });
}
