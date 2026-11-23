import { cp, mkdir } from 'node:fs/promises';
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  await mkdir(`public/pdfjs/${dir}`, { recursive: true });
  await cp(`node_modules/pdfjs-dist/${dir}`, `public/pdfjs/${dir}`, { recursive: true });
}
await mkdir('public/vision-runtime', { recursive: true });
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await cp(`node_modules/onnxruntime-web/dist/${name}`, `public/vision-runtime/${name}`);
}
