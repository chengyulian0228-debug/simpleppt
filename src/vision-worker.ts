import { pipeline, env, RawImage, type ZeroShotImageClassificationPipeline } from '@huggingface/transformers';
import { visualLabels, type VisualKind } from './vision-policy';

env.allowLocalModels = false;
env.backends.onnx.wasm!.numThreads = 1;
// Runtime files are served with the website, not from a third-party script CDN.
env.backends.onnx.wasm!.wasmPaths = new URL('../vision-runtime/', self.location.href).href;
let classifier: ZeroShotImageClassificationPipeline | undefined;
const revision = '6b7c523703ae26e39be4b03774966f8571c7f523';
const kinds = Object.keys(visualLabels) as VisualKind[];
const labels = kinds.map(kind => visualLabels[kind]);
const loadClassifier = pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<ZeroShotImageClassificationPipeline>;
self.onmessage = async event => {
  const { pixels, width, height, host, runtime } = event.data;
  try {
    if (!classifier) {
      env.remoteHost = host;
      env.backends.onnx.wasm!.wasmPaths = runtime;
      const options = {
        dtype: 'q8', revision, device: 'wasm',
        progress_callback: (info: Record<string, unknown>) => {
          if ('status' in info && info.status === 'progress' && 'loaded' in info) {
            self.postMessage({ type: 'progress', file: info.file, loaded: info.loaded, total: info.total });
          }
        },
      };
      try {
        classifier = await loadClassifier('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', options);
      } catch (firstError) {
        // Only retry model initialization. Never disguise a failed inference as a basic-rule result.
        env.remoteHost = host === 'https://hf-mirror.com/' ? 'https://huggingface.co/' : 'https://hf-mirror.com/';
        self.postMessage({ type: 'status', message: '首选模型源连接失败，正在尝试备用下载源…' });
        console.warn('simpleppt model source unavailable:', firstError instanceof Error ? firstError.message : String(firstError));
        classifier = await loadClassifier('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', options);
      }
    }
    const image = new RawImage(new Uint8ClampedArray(pixels), width, height, 3);
    const result = await classifier(image, labels, { hypothesis_template: '{}' });
    self.postMessage({ type: 'result', scores: (result as { label: string; score: number }[]).map(item => ({ kind: kinds[labels.indexOf(item.label)], score: item.score })) });
  } catch (error) {
    console.error('simpleppt local image classification failed:', error instanceof Error ? error.message : String(error));
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
