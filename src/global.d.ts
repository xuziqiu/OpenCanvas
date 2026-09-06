import type { OpenCanvasVaultApi } from './types';

declare module '*.md?raw' {
  const content: string;
  export default content;
}

declare global {
  interface Window {
    openCanvasVault?: OpenCanvasVaultApi;
    __openCanvasFlush?: () => Promise<void>;
  }
}

export {};
