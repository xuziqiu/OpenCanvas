import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/lucide-react')) return 'ui-icons';
          if (id.includes('node_modules/katex') || id.includes('node_modules/@tiptap/extension-mathematics')) return 'editor-math';
          if (id.includes('node_modules/@tiptap/extension-table')) return 'editor-table';
          if (id.includes('node_modules/@tiptap/markdown')) return 'editor-markdown';
          if (id.includes('node_modules/@tiptap/pm')) return 'editor-prosemirror';
          if (id.includes('node_modules/prosemirror-')) return 'editor-prosemirror';
          if (id.includes('node_modules/@tiptap/extension-') || id.includes('node_modules/@tiptap/starter-kit')) return 'editor-extensions';
          if (id.includes('node_modules/@tiptap')) return 'editor-core';
          if (id.includes('node_modules/react-markdown') || id.includes('node_modules/remark-') || id.includes('node_modules/mdast-') || id.includes('node_modules/micromark-') || id.includes('node_modules/unified/')) return 'markdown-renderer';
        },
      },
    },
  },
});
