/**
 * Locate the DSH installation this session runs on, so the offline checks can
 * validate against the *real* tool runtime instead of a hand copy.
 *
 * The installation's own layout is the only assumption — both the desktop
 * bundle and a source checkout carry the runtime at
 * `<app>/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`. Where that
 * `<app>` lives is discovered, never hardcoded, so relocating or upgrading DSH
 * does not break these scripts.
 */
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

const TAIL = join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

/** @param appDir - the application directory DSH runs from (`.../resources/app`). */
const entryIn = (appDir) => join(appDir, 'dsh', TAIL)
/** @param installDir - the directory holding the DSH executable. */
const entryUnder = (installDir) => join(installDir, 'resources', 'app', 'dsh', TAIL)

/**
 * Read a process's command line as one string. Child processes of the Electron
 * runtime flatten their arguments into argv without NUL separators, so the raw
 * memory is read rather than split on NUL.
 * @param pid - process id.
 * @returns the command line, or undefined when it cannot be read.
 */
const cmdlineOf = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return undefined /* another user's process, or it exited while we looked */
  }
}

/**
 * Walk up from this process to the DSH executable that (transitively) started it.
 * @returns the executable's directory, or undefined when no ancestor looks like DSH.
 */
function dshInstallDir() {
  let pid = String(process.pid)
  for (let hops = 0; hops < 16 && pid !== '0' && pid !== '1'; hops += 1) {
    try {
      const exe = readlinkSync(`/proc/${pid}/exe`)
      /* The desktop bundle runs the app from the same directory it keeps
         `resources/app` in; a plain `dsh` checkout has no such neighbour and is
         handled by the DSH_TOOLS override instead. */
      if (existsSync(entryUnder(dirname(exe)))) return dirname(exe)
    } catch {
      /* gone, or not ours to inspect */
    }
    const status = (() => {
      try {
        return readFileSync(`/proc/${pid}/status`, 'utf8')
      } catch {
        return undefined
      }
    })()
    const parent = status === undefined ? undefined : /^PPid:\s*(\d+)$/m.exec(status)?.[1]
    if (parent === undefined) break
    pid = parent
  }
  return undefined
}

/**
 * Resolve the tool runtime's entry module.
 * @returns absolute path to `@deepseek-ai/dsh-tools`'s entry module.
 * @throws when no candidate exists, naming the override to set.
 */
export function dshToolsPath() {
  if (process.env.DSH_TOOLS) return process.env.DSH_TOOLS

  /* Every DSH child process is told where the application directory is. */
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    const match = /--app-path=([^\0\s]+)/.exec(cmdlineOf(pid) ?? '')
    if (match === null) continue
    const candidate = entryIn(match[1])
    if (existsSync(candidate)) return candidate
  }

  /* Falling back on ancestry covers a DSH that was started without that flag. */
  const installDir = dshInstallDir()
  if (installDir !== undefined) {
    const candidate = entryUnder(installDir)
    if (existsSync(candidate)) return candidate
  }

  throw new Error('cannot locate the DSH tool runtime: run these checks while DSH is running, or set DSH_TOOLS to a readable @deepseek-ai/dsh-tools/lib/index.js')
}
