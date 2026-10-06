import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../src-tauri/', import.meta.url));
// One compiled binary covers financial cancellation and versioned header corrections.
for (const filter of ['cancellation', 'header_correction']) {
  const result = spawnSync('cargo', ['test', '--lib', filter], { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
