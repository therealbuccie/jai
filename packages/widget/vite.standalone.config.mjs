import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const stylesheet = fileURLToPath(new URL('./src/styles.css', import.meta.url));
export default defineConfig({
  // Only explicit public constants are included; do not load dashboard env files.
  envFile: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    __JAI_WIDGET_CSS__: JSON.stringify(readFileSync(stylesheet, 'utf8')),
  },
  plugins: [{
    name: 'standalone-inline-widget-css',
    enforce: 'pre',
    load(id) {
      // The unchanged component imports CSS; the standalone entry installs it
      // inside its shadow root instead of emitting a second installation asset.
      if (id.replaceAll('\\', '/') === stylesheet.replaceAll('\\', '/')) return '';
    },
  }],
  build: {
    outDir: 'dist/standalone',
    lib: {
      entry: fileURLToPath(new URL('./src/standalone.ts', import.meta.url)),
      name: 'JaiWidgetInstaller',
      formats: ['iife'],
      fileName: () => 'jai-widget.js',
    },
  },
});
