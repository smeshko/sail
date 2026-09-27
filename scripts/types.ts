// Emits the SDK's declaration files into types/, the `.d.ts` that `sail check` type-checks a repository against.
// They're committed, so `bun run types` regenerates them after a change to src/sdk, and test/scripts/types.test.ts
// fails while they're stale.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const HEADER = '// Generated from src/sdk by `bun run types`. Do not edit.\n';

/** Emits the declarations of `sail` and `sail/intakes` into `outDir`, and returns the file names, sorted. */
export async function emitTypes(outDir: string): Promise<string[]> {
  const configDir = mkdtempSync(join(tmpdir(), 'sail-types-emit-'));
  try {
    const config = join(configDir, 'tsconfig.json');
    // `types: []` proves that the public surface needs no Bun types.
    const compilerOptions = {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      outDir,
      rootDir: join(root, 'src/sdk'),
      types: [],
    };
    const files = [join(root, 'src/sdk/index.ts'), join(root, 'src/sdk/intakes.ts')];
    writeFileSync(
      config,
      JSON.stringify({ extends: join(root, 'tsconfig.json'), compilerOptions, files, include: [] }),
    );

    const tsc = Bun.spawn([process.execPath, join(root, 'node_modules/typescript/bin/tsc'), '-p', config], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      tsc.exited,
      new Response(tsc.stdout).text(),
      new Response(tsc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`tsc exited ${code} emitting the SDK's declarations:\n${stdout}${stderr}`);

    const names = readdirSync(outDir)
      .filter((name) => name.endsWith('.d.ts'))
      .sort();
    for (const name of names) {
      const path = join(outDir, name);
      writeFileSync(path, HEADER + readFileSync(path, 'utf8'));
    }
    return names;
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const outDir = join(root, 'types');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir);
  for (const name of await emitTypes(outDir)) console.log(`types/${name}`);
}
