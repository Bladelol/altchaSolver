export type ToWorker =
  | { type: 'init'; module: WebAssembly.Module }
  | { type: 'job'; id: number; salt: Uint8Array; target: Uint8Array }
  | { type: 'chunk'; id: number; start: number; count: number };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'done'; id: number; found: number };
