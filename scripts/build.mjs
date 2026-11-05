import { build } from 'esbuild';
await build({ entryPoints: ['src/action.ts', 'src/cli.ts'], outdir: 'dist',
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', outExtension: { '.js': '.cjs' },
  sourcemap: false, legalComments: 'eof', charset: 'utf8' });
