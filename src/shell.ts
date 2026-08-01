import { spawnSync, SpawnSyncReturns } from 'node:child_process'
import { platform } from 'node:os'

/**
 * Execute a command safely using spawnSync with an argument array.
 * This prevents shell injection by never interpolating user input into
 * a shell command string.
 *
 * @param command - The executable path/name (e.g. 'gcloud')
 * @param args - Array of arguments (e.g. ['config', 'set', 'project', projectId])
 * @param options - spawnSync options
 * @returns SpawnSyncReturns with stdout, stderr, and status
 */
export function spawn(
  command: string,
  args: string[],
  options?: Parameters<typeof spawnSync>[2],
): SpawnSyncReturns<string | Buffer> {
  return spawnSync(command, args, options)
}

/**
 * Execute a command and return trimmed stdout as a string.
 * Throws if the command exits with a non-zero status.
 *
 * @param command - The executable path/name
 * @param args - Array of arguments
 * @param options - spawnSync options
 * @returns Trimmed stdout string
 */
export function exec(
  command: string,
  args: string[],
  options?: Parameters<typeof spawnSync>[2],
): string {
  const result =
    platform() === 'win32'
      ? spawnSync('cmd.exe', ['/c', command, ...args], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
          ...options,
        })
      : spawnSync(command, args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          ...options,
        })

  if (result.status !== 0) {
    const stderr = (result.stderr as string)?.trim()
    throw new Error(stderr || `Command failed with status ${result.status}`)
  }

  return (result.stdout as string).trim()
}
