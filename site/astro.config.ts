import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  site: 'https://yeschef.codes',
  output: 'static',
  build: { format: 'file' },
  trailingSlash: 'never',
  compressHTML: false,
  vite: {
    plugins: [{
      name: 'demo-node-builtins',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer?.includes('/demo/lib/')) return null;
        const shim = source === 'node:crypto' ? 'node-crypto'
          : source === 'node:fs' || source === 'node:path' ? 'node-shims' : null;
        return shim ? fileURLToPath(new URL(`./src/demo/${shim}.ts`, import.meta.url)) : null;
      },
    }],
  },
});
