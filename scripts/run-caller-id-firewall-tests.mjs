import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const testScript = resolve(scriptDirectory, 'test-caller-id-firewall.ps1')
const candidates =
  process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh']

let lastMissingShell = null
for (const executable of candidates) {
  const args = ['-NoProfile', '-NonInteractive']
  if (process.platform === 'win32') args.push('-ExecutionPolicy', 'Bypass')
  args.push('-File', testScript)

  const result = spawnSync(executable, args, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') {
    lastMissingShell = result.error
    continue
  }
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}

throw new Error(
  `PowerShell is required for Caller ID firewall behavior tests: ${lastMissingShell?.message ?? 'no shell found'}`,
)
