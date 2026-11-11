import { buildSync } from 'esbuild';
import { resolve } from 'node:path';

export function inlineScript(file: string): string {
  const result = buildSync({
    entryPoints: [resolve(file)], bundle: true, write: false,
    format: 'iife', target: 'es2022', minify: true,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`No inline script was built for ${file}`);
  return output.text.replaceAll('</script', '<\\/script');
}
