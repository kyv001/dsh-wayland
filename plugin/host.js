/**
 * dsh-wayland — Host half.
 *
 * Runs headless Wayland (sway) sessions, one per "virtual desktop", and exposes
 * them to (a) the model as tools and (b) the right-sidebar UI as a small HTTP +
 * MJPEG surface. Everything is dependency-free: node builtins plus the external
 * wlroots toolchain located through `config.binDir`.
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * pointer.js is imported with its modification time in the specifier. A plugin
 * module is cached for the life of the Host process, so a development row
 * (`file:///…/host.js?v=N`) reloads host.js but would keep serving the *old*
 * pointer.js from that cache — a stale-module trap whose only symptom is an odd
 * error later on. Stamping the URL means a changed pointer.js is picked up
 * whenever host.js is reloaded; in an installed bundle the stamp is stable, so
 * the module is still loaded exactly once.
 */
const pointerUrl = new URL('./pointer.js', import.meta.url)
let pointerStamp = ''
try {
  pointerStamp = `?mtime=${Math.round(statSync(fileURLToPath(pointerUrl)).mtimeMs)}`
} catch {
  /* fall through to the plain specifier */
}
const { openVirtualPointer, probeVirtualPointer } = await import(`${pointerUrl.href}${pointerStamp}`)

export const name = 'dsh-wayland'
export const inject = ['tools', 'webServer']

const BASE = '/dsh-wayland'
const LOG = '[dsh-wayland]'

const DEFAULTS = {
  /** Directory holding sway/grim/wtype/wlrctl. Empty = look on PATH. */
  binDir: '',
  /** Root for per-session runtime directories. Empty = $XDG_RUNTIME_DIR/dsh-wayland. */
  sessionRoot: '',
  /** Default headless output size. */
  width: 1280,
  height: 800,
  /** MJPEG defaults (the legacy /stream endpoint). */
  streamFps: 10,
  streamScale: 0.6,
  streamQuality: 70,
  /** Live-view defaults for the sidebar panel; served to it through /boot so
   *  the rate and quality are tunable here instead of in the client bundle. */
  liveFps: 20,
  liveQuality: 82,
  liveMediaType: 'image/jpeg',
  /** Screenshot capture for the model-facing tool: deployment settings, not
   *  tool parameters — a model should not be choosing an image codec. */
  screenshotMediaType: 'image/png',
  screenshotQuality: 85,
  /** Keyboard injection timing: how long the virtual keyboard waits for the
   *  client's focus handshake before the first key, and the gap between keys.
   *  Deployment settings, not tool parameters — a caller asks for a `wait`
   *  directive when it genuinely needs to pause. */
  inputLeadMs: 60,
  inputKeyDelayMs: 20,
  /** Sessions allowed at once. */
  maxSessions: 6,
  /** Command used by the sidebar's "new session" default app. */
  defaultApp: 'foot',
}

/**
 * The external toolchain. The plugin itself is dependency-free JavaScript, so
 * every binary it runs comes from `config.binDir` or from PATH. Each entry says
 * what the binary is for, because that purpose is what a missing dependency
 * report has to tell a model (and a person) to be actionable.
 */
const BINARIES = [
  { name: 'sway', required: true, purpose: 'the headless compositor that hosts every session' },
  { name: 'swaymsg', required: true, purpose: 'sway IPC: window tree, focus, output background' },
  { name: 'grim', required: true, purpose: 'screenshots and the live panel frames' },
  { name: 'wtype', required: true, purpose: 'keyboard injection' },
  /* Pointer input normally runs on the session's own persistent virtual pointer,
     which needs no binary at all (see pointer.js). wlrctl is only the fallback
     for a compositor that does not offer zwlr_virtual_pointer_manager_v1. */
  { name: 'wlrctl', required: false, purpose: 'pointer fallback when the compositor has no virtual-pointer protocol' },
  { name: 'wl-copy', required: false, purpose: 'pasting non-ASCII text' },
  { name: 'foot', required: false, purpose: "the panel's default terminal" },
  { name: 'wayvnc', required: false, purpose: 'planned smooth streaming' },
  { name: 'wf-recorder', required: false, purpose: 'planned recording' },
  { name: 'xterm', required: false, purpose: 'legacy X11 terminal' },
]

/**
 * How to get the toolchain, as `[platform, command]` pairs. These are ordinary
 * distribution packages that install into the FHS layout, which is all this
 * plugin ever assumes: a binary named `sway` reachable through PATH, or through
 * `config.binDir` when someone wants to pin an exact build.
 */
const INSTALL_HINTS = [
  ['Debian/Ubuntu', 'sudo apt install sway grim wtype wlrctl foot wl-clipboard'],
  ['Fedora', 'sudo dnf install sway grim wtype wlrctl foot wl-clipboard'],
  ['Arch', 'sudo pacman -S sway grim wtype wlrctl foot wl-clipboard'],
  ['Other distributions', 'install sway, grim, wtype and foot, then make sure they are on PATH (wlrctl only as a pointer fallback)'],
]

/* ------------------------------------------------------------------ utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/**
 * Locate one binary: `binDir` first, then PATH in order. Existence is the whole
 * check — deliberately cheap, because it runs again on every retry so that
 * installing a program while DSH is running needs no plugin reload.
 * @param name - executable name, without a directory.
 * @param binDir - configured directory to search first; empty searches PATH only.
 * @param env - environment whose PATH to search (defaults to the process).
 * @returns the resolved absolute path and where it came from, or undefined.
 */
function findBinary(name, binDir, env) {
  if (binDir) {
    const candidate = path.join(binDir, name)
    if (existsSync(candidate)) return { path: candidate, via: 'binDir' }
  }
  const dirs = String((env ?? process.env).PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return { path: candidate, via: 'PATH' }
  }
  return undefined
}

/** Resolved path of one binary, or undefined. */
function which(name, binDir, env) {
  return findBinary(name, binDir, env)?.path
}

/**
 * Read the toolchain without running anything and without throwing.
 * @param binDir - configured directory to search first; empty searches PATH only.
 * @param env - environment whose PATH to search (defaults to the process).
 * @returns required/optional entries with resolution, the missing names, and readiness.
 */
function probeToolchain(binDir, env) {
  const entries = BINARIES.map((binary) => {
    const found = findBinary(binary.name, binDir, env)
    return {
      name: binary.name,
      purpose: binary.purpose,
      required: binary.required,
      ...(found ? { path: found.path, via: found.via } : {}),
    }
  })
  const required = entries.filter((entry) => entry.required)
  const optional = entries.filter((entry) => !entry.required)
  const missingRequired = required.filter((entry) => entry.path === undefined).map((entry) => entry.name)
  const missingOptional = optional.filter((entry) => entry.path === undefined).map((entry) => entry.name)
  return {
    ready: missingRequired.length === 0,
    mode: binDir ? 'binDir' : 'PATH',
    binDir: binDir || '',
    required,
    optional,
    missingRequired,
    missingOptional,
    /* Carried in the payload so the model's report and the panel render the same
       lines from one place instead of each hardcoding its own advice. */
    installHints: INSTALL_HINTS.map(([platform, command]) => ({ platform, command })),
  }
}

/**
 * Render a dependency report: what is missing, what each binary is for, and the
 * concrete ways to fix it. This is the text both the model and the panel read,
 * so it names the missing binaries before anything else.
 * @param toolchain - state from {@link probeToolchain}.
 * @param action - the operation that could not proceed, as a sentence start.
 * @returns a multi-line, actionable report; empty when nothing required is missing.
 */
function dependencyReport(toolchain, action) {
  if (toolchain.ready) return ''
  const lines = [
    `${action}: missing required ${toolchain.missingRequired.length === 1 ? 'binary' : 'binaries'} ${toolchain.missingRequired.join(', ')}.`,
  ]
  for (const entry of toolchain.required) {
    if (entry.path === undefined) lines.push(`- ${entry.name}: ${entry.purpose}`)
  }
  lines.push(toolchain.binDir
    ? `Install them, or make config.binDir (currently ${toolchain.binDir}) point at a directory that has them; PATH is searched next.`
    : 'Install them, or set config.binDir in the plugin config to a directory that has them.')
  for (const hint of toolchain.installHints ?? []) lines.push(`${hint.platform}: ${hint.command}`)
  return lines.join('\n')
}

/** Spawn a short-lived command and collect its output. */
function runOnce(bin, args, options = {}) {
  const { env, cwd, input, timeoutMs = 20000, maxBytes = 12 * 1024 * 1024, label } = options
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`${label ?? bin} failed to start: ${error.message}`))
      return
    }
    const out = []
    const err = []
    let outBytes = 0
    let errBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`${label ?? bin} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes <= maxBytes) out.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      errBytes += chunk.length
      if (errBytes <= 256 * 1024) err.push(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${label ?? bin} failed: ${error.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' | ')
        reject(Object.assign(new Error(`${label ?? path.basename(bin)} exited ${code}${detail ? `: ${detail}` : ''}`), { code, stdout, stderr }))
        return
      }
      resolve({ stdout, stderr, code })
    })
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/**
 * Run a command that forks a helper and holds a resource (wl-copy serves the
 * selection from a background child, so its inherited pipes never close).
 * Resolve on the parent's exit instead of waiting for the streams.
 */
function runForking(bin, args, { env, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] })
    } catch (error) {
      reject(new Error(`${path.basename(bin)} failed to start: ${error.message}`))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
      reject(new Error(`${path.basename(bin)} did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${path.basename(bin)} failed: ${error.message}`))
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(bin)} exited ${code}`))
    })
  })
}

/* --------------------------------------------------------------- sessions */

function createManager(ctx, cfg) {
  const sessions = new Map()
  let counter = 0

  const binDir = cfg.binDir || ''
  /* Resolution is re-read while anything required is missing (and at most every
     few seconds otherwise), so installing a binary and retrying just works. */
  const TOOLCHAIN_TTL_MS = 5000
  let cached = probeToolchain(binDir)
  let cachedAt = Date.now()

  function toolchainNow() {
    if (!cached.ready || Date.now() - cachedAt > TOOLCHAIN_TTL_MS) {
      cached = probeToolchain(binDir)
      cachedAt = Date.now()
    }
    return cached
  }

  /** Resolution of one binary from any group, or undefined. */
  function resolveBin(name) {
    const toolchain = toolchainNow()
    return [...toolchain.required, ...toolchain.optional].find((entry) => entry.name === name)
  }

  /** Resolved path of one binary, or undefined. */
  function binPath(name) {
    return resolveBin(name)?.path
  }

  /**
   * The dependency report, plus the one place to go deeper. The report itself is
   * the error text of every tool, so this is the only sentence that needs to point
   * at `wayland_check` — no tool description has to explain diagnostics.
   */
  function dependencyError(toolchain, action) {
    const report = dependencyReport(toolchain, action)
    return `${report}\nwayland_check reports the same, plus what actually runs and each session's health.`
  }

  /** Resolved path of a required binary, or an actionable missing-dependency error. */
  function requireBin(name, action) {
    const resolved = binPath(name)
    if (resolved) return resolved
    throw new Error(dependencyError(toolchainNow(), action) || `Missing required binary ${name}`)
  }

  /** Nothing may start until every required binary resolves. */
  function requireToolchain(action) {
    const toolchain = toolchainNow()
    if (!toolchain.ready) throw new Error(dependencyError(toolchain, action))
    return toolchain
  }

  const root = cfg.sessionRoot
    || path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'dsh-wayland')

  function byId(id) {
    if (!id) return undefined
    return sessions.get(id)
  }

  function require(id) {
    const session = byId(id)
    if (!session) {
      const known = [...sessions.keys()]
      /* With no session to name, a missing toolchain is the likelier cause than a
         typo, so report the dependency problem instead of a bare "unknown". */
      if (known.length === 0) requireToolchain('No Wayland session is running and none can be started')
      throw new Error(`unknown wayland session ${JSON.stringify(id ?? null)}${known.length ? `; known: ${known.join(', ')}` : '; no sessions exist yet'}`)
    }
    return session
  }

  function envFor(session, extra = {}) {
    const env = { ...process.env }
    delete env.DISPLAY
    delete env.WAYLAND_DISPLAY
    delete env.SWAYSOCK
    env.PATH = binDir ? `${binDir}${path.delimiter}${process.env.PATH ?? ''}` : (process.env.PATH ?? '')
    env.XDG_RUNTIME_DIR = session.runtimeDir
    env.XDG_SESSION_TYPE = 'wayland'
    env.XDG_SESSION_DESKTOP = 'sway'
    env.XDG_CURRENT_DESKTOP = 'sway'
    env.WLR_BACKENDS = 'headless'
    env.WLR_HEADLESS_OUTPUTS = '1'
    env.WLR_LIBINPUT_NO_DEVICES = '1'
    env.WLR_RENDERER = 'pixman'
    env.LIBGL_ALWAYS_SOFTWARE = '1'
    env.WAYLAND_DISPLAY = session.display
    // sway refuses to create its IPC socket when SWAYSOCK is set but empty, so
    // publish it only once the socket has actually been discovered.
    if (session.sockPath) env.SWAYSOCK = session.sockPath
    else delete env.SWAYSOCK
    // Distribution packages often wrap the compositor in a private session bus
    // (`dbus-run-session` and friends). The programs we launch are our own
    // children, so pin them to the user's shared bus instead: portals, file
    // dialogs and dbus monitoring then behave the way they do on the desktop.
    env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS
      ?? `unix:path=${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`}/bus`
    return { ...env, ...extra }
  }

  /**
   * sway's IPC socket is named after *its own* pid, not necessarily the pid we
   * spawned: a wrapper script may `exec` a helper (a session bus, a launcher)
   * that forks the compositor. The socket is therefore found by listing the
   * session's private runtime directory, which holds exactly one of them.
   */
  async function findSwaySock(runtimeDir) {
    try {
      const entries = await readdir(runtimeDir)
      const socks = entries.filter((name) => /^sway-ipc\.\d+\.\d+\.sock$/.test(name))
      if (socks.length === 0) return undefined
      return path.join(runtimeDir, socks.sort().at(-1))
    } catch {
      return undefined
    }
  }

  function configText(session) {
    return [
      '# generated by dsh-wayland',
      `output ${session.output} mode ${session.width}x${session.height}`,
      'xwayland force',
      'default_border pixel 1',
      'font pango:monospace 10',
      '',
    ].join('\n')
  }

  async function waitForSway(session, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (session.proc.exitCode !== null) {
        throw new Error(`sway exited immediately (code ${session.proc.exitCode}); log: ${await tail(session.logPath)}`)
      }
      const sock = session.sockPath ?? await findSwaySock(session.runtimeDir)
      if (sock) {
        session.sockPath = sock
        try {
          await runOnce(requireBin('swaymsg', 'Cannot query sway'), ['-t', 'get_version'], { env: envFor(session), timeoutMs: 5000, label: 'swaymsg' })
          return
        } catch {
          /* not ready yet */
        }
      }
      await sleep(150)
    }
    throw new Error(`sway did not become ready within ${timeoutMs}ms; log: ${await tail(session.logPath)}`)
  }

  async function tail(file, lines = 6) {
    try {
      const text = await readFile(file, 'utf8')
      return text.trim().split('\n').slice(-lines).join(' / ')
    } catch {
      return '(no log)'
    }
  }

  async function create({ name: label, width, height } = {}) {
    requireToolchain('Cannot start a Wayland session')
    if (sessions.size >= cfg.maxSessions) {
      throw new Error(`at most ${cfg.maxSessions} wayland sessions may run at once; close one first`)
    }
    const w = Number.isInteger(width) && width > 0 ? width : cfg.width
    const h = Number.isInteger(height) && height > 0 ? height : cfg.height
    const id = `w${(++counter).toString(36)}${randomBytes(2).toString('hex')}`
    const dir = path.join(root, id)
    const runtimeDir = path.join(dir, 'run')
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 })
    const session = {
      id,
      name: label || `session ${counter}`,
      dir,
      runtimeDir,
      logPath: path.join(dir, 'sway.log'),
      output: 'HEADLESS-1',
      display: 'wayland-1',
      width: w,
      height: h,
      createdAt: new Date().toISOString(),
      sockPath: null,
      proc: null,
      apps: [],
      pointer: { x: 0, y: 0 },
      /* One persistent virtual pointer per session, opened on first use. */
      vptr: null,
      vptrTried: false,
      vptrError: null,
      seatName: null,
    }
    await writeFile(path.join(dir, 'sway.conf'), configText(session), 'utf8')
    const log = await open(session.logPath, 'a')
    session.proc = spawn(requireBin('sway', 'Cannot start a Wayland session'), ['-c', path.join(dir, 'sway.conf')], {
      env: envFor(session),
      cwd: dir,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    })
    session.proc.on('error', (error) => console.error(`${LOG} sway spawn failed:`, error.message))
    session.proc.on('exit', (code) => {
      if (!sessions.has(id)) return
      console.error(`${LOG} sway for session ${id} exited with ${code}`)
    })
    session.proc.unref()
    try {
      await log.close()
    } catch {}
    sessions.set(id, session)
    try {
      await waitForSway(session)
    } catch (error) {
      sessions.delete(id)
      await kill(session)
      throw error
    }
    await runOnce(requireBin('swaymsg', 'Cannot set the output background'), ['output', session.output, 'bg', '#1b1f27', 'solid_color'], {
      env: envFor(session), timeoutMs: 5000, label: 'swaymsg bg',
    }).catch(() => {})
    console.log(`${LOG} session ${id} ready (${w}x${h}, ${session.runtimeDir})`)
    return session
  }

  async function kill(session) {
    if (!session) return
    /* Retire the session's pointer before the compositor goes away, so no
       virtual device outlives the session that owned it. */
    if (session.vptr) await session.vptr.destroy().catch(() => {})
    try {
      process.kill(-session.proc.pid, 'SIGTERM')
    } catch {
      try { session.proc.kill('SIGTERM') } catch {}
    }
    const deadline = Date.now() + 4000
    while (session.proc.exitCode === null && Date.now() < deadline) await sleep(100)
    if (session.proc.exitCode === null) {
      try { process.kill(-session.proc.pid, 'SIGKILL') } catch {}
    }
    for (const app of session.apps) {
      try { process.kill(-app.pid, 'SIGKILL') } catch {}
    }
    await rm(session.dir, { recursive: true, force: true }).catch(() => {})
  }

  async function close(id) {
    const session = require(id)
    sessions.delete(session.id)
    await kill(session)
    return { id: session.id, closed: true }
  }

  function list() {
    return [...sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      width: s.width,
      height: s.height,
      display: s.display,
      createdAt: s.createdAt,
      alive: s.proc.exitCode === null,
      apps: s.apps.length,
    }))
  }

  async function swaymsg(session, args, options = {}) {
    return runOnce(requireBin('swaymsg', 'Cannot talk to sway'), args, {
      env: envFor(session),
      timeoutMs: options.timeoutMs ?? 8000,
      label: options.label ?? 'swaymsg',
      maxBytes: options.maxBytes,
    })
  }

  async function tree(session) {
    const { stdout } = await swaymsg(session, ['-t', 'get_tree', '--raw'], { label: 'swaymsg get_tree' })
    return JSON.parse(stdout.toString('utf8'))
  }

  function collectWindows(root_) {
    const out = []
    const walk = (node, ox, oy) => {
      const rect = node.rect ?? { x: 0, y: 0, width: 0, height: 0 }
      const x = ox + (rect.x ?? 0)
      const y = oy + (rect.y ?? 0)
      const appId = node.app_id ?? node.window_properties?.class ?? null
      if (appId !== null || node.shell === 'xwayland') {
        out.push({
          id: node.id,
          appId: appId ?? '(unknown)',
          title: node.name ?? '',
          pid: node.pid ?? null,
          focused: Boolean(node.focused),
          visible: node.visible !== false,
          floating: Boolean(node.floating),
          rect: { x, y, width: rect.width, height: rect.height },
        })
      }
      for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) walk(child, x, y)
    }
    walk(root_, 0, 0)
    return out
  }

  async function windows(id) {
    const session = require(id)
    const parsed = await tree(session)
    const found = collectWindows(parsed)
    for (const app of session.apps) {
      for (const win of found) {
        if (win.pid !== null && win.pid === app.pid) win.command = app.command
      }
    }
    return found
  }

  /** Discover the Xwayland display sway handed to this session, if any. */
  async function xwaylandDisplay(session) {
    const pgid = String(session.proc.pid)
    try {
      const pids = await readdir('/proc')
      for (const entry of pids) {
        if (!/^\d+$/.test(entry)) continue
        let cmdline
        try {
          cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8')
        } catch {
          continue
        }
        if (!cmdline.includes('Xwayland')) continue
        let fields
        try {
          const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
          /* after "comm)" come state, ppid, pgrp, session, ... */
          fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        } catch {
          continue
        }
        if (fields[2] !== pgid) continue
        const match = cmdline.match(/:(?<n>\d+)/)
        if (match) return `:${match.groups.n}`
      }
    } catch {}
    return undefined
  }

  async function launch(id, { command, args = [], env = {}, cwd, wait = true, waitMs = 8000 } = {}) {
    const session = require(id)
    if (!command || typeof command !== 'string') throw new Error('launch requires a command')
    const bin = which(command, binDir) ?? command
    const display = await xwaylandDisplay(session)
    const extra = { ...env }
    if (display) extra.DISPLAY = display
    const out = await open(path.join(session.dir, 'apps.log'), 'a')
    const child = spawn(bin, args.map(String), {
      env: envFor(session, extra),
      cwd: cwd || process.env.HOME || session.dir,
      detached: true,
      stdio: ['ignore', out.fd, out.fd],
    })
    /* A missing executable is the common failure here, and it must name the
       program and where it looked instead of surfacing as a bare ENOENT. */
    const spawnError = new Promise((resolve) => child.once('error', resolve))
    child.on('error', (error) => console.error(`${LOG} launch ${command} failed:`, error.message))
    if (child.pid === undefined) {
      const error = await spawnError
      try { await out.close() } catch {}
      const code = error?.code
      throw new Error(
        `cannot run ${JSON.stringify(command)}: ${code === 'ENOENT' ? 'no such executable' : error?.message ?? 'spawn failed'}. `
        + `Looked in ${binDir ? `${binDir} and ` : ''}PATH; pass an absolute path, install it, or add its directory to config.binDir.`,
      )
    }
    child.on('exit', (code) => {
      const index = session.apps.findIndex((a) => a.pid === child.pid)
      if (index >= 0) session.apps[index].exitCode = code
    })
    child.unref()
    try { await out.close() } catch {}
    const record = { pid: child.pid, command: [command, ...args].join(' '), startedAt: new Date().toISOString() }
    session.apps.push(record)
    let window = null
    /* Which of three things happened while waiting. "No window" alone cannot tell
       a program that died from one that is merely slow, and the caller has to act
       differently on each. */
    let outcome = wait ? 'timeout' : 'skipped'
    if (wait) {
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        await sleep(250)
        const found = await windows(session.id).catch(() => [])
        window = found.find((w) => w.pid === child.pid && w.visible) ?? null
        if (window) {
          outcome = 'window'
          break
        }
        if (child.exitCode !== null) {
          outcome = 'exited'
          break
        }
      }
    }
    return {
      pid: child.pid,
      command: record.command,
      outcome,
      log: path.join(session.dir, 'apps.log'),
      ...(window ? { window } : {}),
      ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}),
    }
  }

  /* ------------------------------------------------------------ pictures */

  async function capture(session, { window: win, scale, quality, mediaType = 'image/jpeg' } = {}) {
    /* grim treats -o (whole output) and -g (region) as mutually exclusive. */
    const args = []
    if (win && win.rect) {
      const r = win.rect
      args.push('-g', `${r.x},${r.y} ${r.width}x${r.height}`)
    } else {
      args.push('-o', session.output)
    }
    if (mediaType === 'image/jpeg') {
      args.push('-t', 'jpeg', '-q', String(clampInt(quality, 1, 100, cfg.screenshotQuality)))
    } else {
      args.push('-t', 'png')
    }
    if (scale && scale !== 1) args.push('-s', String(scale))
    args.push('-')
    const { stdout } = await runOnce(requireBin('grim', 'Cannot take a screenshot'), args, {
      env: envFor(session),
      timeoutMs: 20000,
      label: 'grim',
      maxBytes: 32 * 1024 * 1024,
    })
    if (stdout.length === 0) throw new Error('grim produced no image data')
    return stdout
  }

  /* -------------------------------------------------------------- input */

  function clampInt(value, min, max, fallback) {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, Math.round(n)))
  }

  function keysymFor(key) {
    const map = {
      return: 'Return', enter: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab',
      space: 'space', backspace: 'BackSpace', delete: 'Delete', del: 'Delete',
      up: 'Up', down: 'Down', left: 'Left', right: 'Right',
      home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
      insert: 'Insert', f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
      f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
    }
    const lower = String(key).toLowerCase()
    return map[lower] ?? key
  }

  const MODIFIERS = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', super: 'logo', meta: 'logo', logo: 'logo', win: 'logo', altgr: 'altgr' }

  async function pressKey(session, { key: k, modifiers = [], repeat = 1 }) {
    /* -s waits after the virtual keyboard exists but before the first event, so
       the first keystroke is not lost to the client's focus handshake. */
    const args = ['-s', String(clampInt(cfg.inputLeadMs, 0, 5000, 60))]
    const mods = []
    for (const raw of modifiers) {
      const mod = MODIFIERS[String(raw).toLowerCase()]
      if (mod) {
        mods.push(mod)
        args.push('-M', mod)
      }
    }
    for (let i = 0; i < Math.max(1, Math.min(20, repeat)); i++) args.push('-k', keysymFor(k))
    for (const mod of mods.reverse()) args.push('-m', mod)
    await runOnce(requireBin('wtype', 'Cannot type into the session'), args, { env: envFor(session), timeoutMs: 10000, label: 'wtype key' })
  }

  async function typeText(session, value) {
    const str = String(value ?? '')
    if (str.length === 0) return
    const lead = clampInt(cfg.inputLeadMs, 0, 5000, 60)
    const delay = clampInt(cfg.inputKeyDelayMs, 0, 1000, 20)
    if (/^[\x20-\x7e\n\t]*$/.test(str)) {
      await runOnce(requireBin('wtype', 'Cannot type into the session'), ['-s', String(lead), '-d', String(delay), '--', str], {
        env: envFor(session), timeoutMs: 30000, label: 'wtype text',
      })
      return
    }
    const wlCopy = binPath('wl-copy')
    if (!wlCopy) {
      throw new Error('non-ASCII text needs wl-copy in the toolchain binDir (clipboard paste fallback)')
    }
    await runForking(wlCopy, ['--', str], { env: envFor(session) })
    /* let the clipboard child publish the selection before pasting it */
    await sleep(120)
    await pressKey(session, { key: 'v', modifiers: ['ctrl'] })
  }

  /**
   * The session's persistent virtual pointer, opened on first pointer action.
   *
   * One device per session (not one per action) is what makes buttons arrive at
   * all, and `motion_absolute` is what makes coordinates exact: see pointer.js
   * for the measurements. Returns null when the compositor cannot provide it, in
   * which case the caller falls back to swaymsg/wlrctl.
   */
  async function virtualPointer(session) {
    if (session.vptr) return session.vptr
    if (session.vptrTried) return null
    session.vptrTried = true
    try {
      session.vptr = await openVirtualPointer({
        socketPath: path.join(session.runtimeDir, session.display),
        width: session.width,
        height: session.height,
      })
      return session.vptr
    } catch (error) {
      session.vptrError = error.message
      console.error(`${LOG} session ${session.id}: no persistent virtual pointer (${error.message}); pointer falls back to wlrctl, which may drop clicks`)
      return null
    }
  }

  /** First seat of the session, cached; used by the fallback cursor warp. */
  async function seatName(session) {
    if (session.seatName) return session.seatName
    try {
      const { stdout } = await swaymsg(session, ['-t', 'get_seats', '--raw'], { label: 'swaymsg get_seats' })
      session.seatName = JSON.parse(stdout.toString('utf8'))?.[0]?.name ?? 'seat0'
    } catch {
      session.seatName = 'seat0'
    }
    return session.seatName
  }

  /**
   * Fallback positioning for compositors without the virtual-pointer protocol:
   * `seat <seat> cursor set` warps the cursor absolutely, so the relative-delta
   * model (and its unknown starting position) is only the last resort.
   */
  async function warpCursor(session, x, y) {
    try {
      await swaymsg(session, ['seat', await seatName(session), 'cursor', 'set', String(Math.round(x)), String(Math.round(y))], { label: 'swaymsg cursor set' })
      return true
    } catch {
      return false
    }
  }

  async function pointerMove(session, x, y) {
    const vptr = await virtualPointer(session)
    if (vptr) {
      session.pointer = await vptr.move(x, y)
      return
    }
    if (await warpCursor(session, x, y)) {
      session.pointer = { x: Math.round(x), y: Math.round(y) }
      return
    }
    const dx = Math.round(x) - session.pointer.x
    const dy = Math.round(y) - session.pointer.y
    if (dx === 0 && dy === 0) return
    await runOnce(requireBin('wlrctl', 'Cannot move the pointer'), ['pointer', 'move', String(dx), String(dy)], {
      env: envFor(session), timeoutMs: 10000, label: 'wlrctl pointer move',
    })
    session.pointer = { x: Math.round(x), y: Math.round(y) }
  }

  async function pointerClick(session, button) {
    const vptr = await virtualPointer(session)
    if (vptr) return vptr.click(button)
    await runOnce(requireBin('wlrctl', 'Cannot click'), ['pointer', 'click', String(button ?? 'left')], {
      env: envFor(session), timeoutMs: 10000, label: 'wlrctl pointer click',
    })
    return { button: button ?? 'left' }
  }

  /**
   * Hold a button down across calls. The session's pointer device stays alive,
   * so the compositor keeps the button state — that is what makes long-press and
   * drag expressible. `wlrctl` cannot do this (it clicks and exits), so on the
   * fallback path holding is a clear error rather than a silent click.
   */
  async function pointerPress(session, button) {
    const vptr = await virtualPointer(session)
    if (vptr) return vptr.press(button)
    throw new Error('holding a mouse button needs the compositor\'s virtual-pointer protocol; wlrctl can only click')
  }

  async function pointerRelease(session, button) {
    const vptr = await virtualPointer(session)
    if (vptr) return vptr.release(button)
    throw new Error('releasing a held mouse button needs the compositor\'s virtual-pointer protocol; wlrctl can only click')
  }

  async function pointerScroll(session, dx, dy) {
    const vptr = await virtualPointer(session)
    if (vptr) return vptr.scroll(dx, dy)
    await runOnce(requireBin('wlrctl', 'Cannot scroll'), ['pointer', 'scroll', String(dy ?? 0), String(dx ?? 0)], {
      env: envFor(session), timeoutMs: 10000, label: 'wlrctl pointer scroll',
    })
    return { dx: dx ?? 0, dy: dy ?? 0 }
  }

  /* -------------------------------------------------------- input surface */

  /**
   * The input surface is a small algebra: six primitives that map onto what the
   * session can actually do (move, press, release, scroll, wait, raise), plus
   * four sugars whose meaning is defined as an exact composition of those
   * primitives (click, drag, type, key).
   *
   * One table drives both the model-facing JSON schema and the validation, so
   * the documented shape and the enforced shape cannot drift apart — and because
   * validation is a separate pass, a rejected payload sends nothing at all.
   */
  const BUTTON_NAMES = ['left', 'middle', 'right']

  /** Field shapes shared by the schema and the validator: one concept each. */
  const field = {
    point: (description, required) => ({
      description, required,
      json: { type: 'array', items: { type: 'number' }, description },
      normalize(value, name) {
        if (value === undefined) return undefined
        if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isFinite(n))) {
          throw new Error(`"${name}" must be [x, y] in session pixels`)
        }
        return [Math.round(value[0]), Math.round(value[1])]
      },
    }),
    button: (description, required, fallback) => ({
      description, required,
      json: { type: 'string', enum: BUTTON_NAMES, description },
      normalize(value, name) {
        if (value === undefined) return fallback
        if (!BUTTON_NAMES.includes(value)) throw new Error(`"${name}" must be one of ${BUTTON_NAMES.join(', ')}`)
        return value
      },
    }),
    count: (description, required, fallback) => ({
      description, required,
      json: { type: 'integer', description },
      normalize(value, name) {
        if (value === undefined) return fallback
        if (!Number.isInteger(value) || value < 1 || value > 20) throw new Error(`"${name}" must be an integer from 1 to 20`)
        return value
      },
    }),
    millis: (description) => ({
      description, required: true,
      json: { type: 'integer', description },
      normalize(value, name) {
        if (!Number.isInteger(value) || value < 0 || value > 60000) throw new Error(`"${name}" must be an integer from 0 to 60000 (milliseconds)`)
        return value
      },
    }),
    text: (description) => ({
      description, required: true,
      json: { type: 'string', description },
      normalize(value, name) {
        if (typeof value !== 'string' || value.length === 0) throw new Error(`"${name}" must be a non-empty string`)
        return value
      },
    }),
    chord: (description) => ({
      description, required: true,
      json: { type: 'string', description },
      normalize(value, name) {
        return chordOf(value, name)
      },
    }),
    window: (description) => ({
      description, required: true,
      json: { type: 'integer', description },
      normalize(value, name) {
        if (!Number.isInteger(value)) throw new Error(`"${name}" must be a window id from wayland_windows`)
        return value
      },
    }),
  }

  /** `ctrl+shift+t` → `{ key: 't', modifiers: ['ctrl', 'shift'] }`, validated. */
  function chordOf(value, name) {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`"${name}" must be a non-empty key chord`)
    const parts = value.split('+').map((part) => part.trim()).filter((part) => part.length > 0)
    if (parts.length === 0) throw new Error(`"${name}" must be a non-empty key chord`)
    const chordKey = parts.pop()
    const modifiers = []
    for (const raw of parts) {
      const mod = MODIFIERS[raw.toLowerCase()]
      if (!mod) throw new Error(`"${name}": ${JSON.stringify(raw)} is not a modifier (ctrl, shift, alt, super)`)
      if (!modifiers.includes(mod)) modifiers.push(mod)
    }
    return { key: chordKey, modifiers }
  }

  async function raiseWindow(session, id) {
    await swaymsg(session, [`[con_id=${id}]`, 'focus'], { label: 'swaymsg focus' })
  }

  /** A window id that does not exist is a payload error, not a mid-run surprise. */
  async function requireWindow(session, id) {
    const found = await windows(session.id)
    if (!found.some((w) => w.id === id)) {
      throw new Error(`no window #${id} in this session; wayland_windows lists the live ones`)
    }
    return id
  }

  /**
   * One entry per directive: its fields (the only keys it accepts), what it
   * means, and how it runs. `run` returns the entry reported in the result.
   */
  const DIRECTIVES = {
    move: {
      fields: { to: field.point('Where to move to, as [x, y] in session pixels', true) },
      async run(session, d) { await pointerMove(session, d.to[0], d.to[1]); return { move: d.to } },
    },
    press: {
      fields: { button: field.button('Which button to hold down', true) },
      async run(session, d) { await pointerPress(session, d.button); return { press: d.button } },
    },
    release: {
      fields: { button: field.button('Which button to release', true) },
      async run(session, d) { await pointerRelease(session, d.button); return { release: d.button } },
    },
    scroll: {
      fields: { by: field.point('Wheel steps as [dx, dy]; positive y scrolls down', true) },
      async run(session, d) { await pointerScroll(session, d.by[0], d.by[1]); return { scroll: d.by } },
    },
    wait: {
      fields: { ms: field.millis('How long to wait, in milliseconds (0-60000)') },
      async run(session, d) { await sleep(d.ms); return { wait: d.ms } },
    },
    raise: {
      fields: { window: field.window('Window id from wayland_windows') },
      async run(session, d) { await raiseWindow(session, d.window); return { raise: d.window } },
    },
    click: {
      fields: {
        at: field.point('Where to click, as [x, y]; omit to click where the cursor already is', false),
        button: field.button('Which button (default left)', false, 'left'),
        times: field.count('How many clicks in a row, 1-20 (default 1)', false, 1),
      },
      async run(session, d) {
        if (d.at) await pointerMove(session, d.at[0], d.at[1])
        for (let i = 0; i < d.times; i++) {
          /* keep repeats inside the double-click window so times > 1 is a
             multi-click, not two unrelated clicks */
          if (i > 0) await sleep(40)
          await pointerClick(session, d.button)
        }
        return { click: { at: [session.pointer.x, session.pointer.y], button: d.button, times: d.times } }
      },
    },
    drag: {
      fields: {
        from: field.point('Where to start, as [x, y]; omit to start where the cursor is', false),
        to: field.point('Where to drop, as [x, y]', true),
        button: field.button('Which button to drag with (default left)', false, 'left'),
      },
      async run(session, d) {
        if (d.from) await pointerMove(session, d.from[0], d.from[1])
        const from = [session.pointer.x, session.pointer.y]
        await pointerPress(session, d.button)
        try {
          await pointerMove(session, d.to[0], d.to[1])
        } finally {
          /* never leave a button held, even when the move failed */
          await pointerRelease(session, d.button).catch(() => {})
        }
        return { drag: { from, to: d.to, button: d.button } }
      },
    },
    type: {
      fields: { text: field.text('Characters to type; ASCII is typed key by key, anything else is pasted with Ctrl+V') },
      async run(session, d) { await typeText(session, d.text); return { type: d.text } },
    },
    key: {
      fields: {
        keys: field.chord('A chord such as "Return", "ctrl+shift+t" or "a"'),
        times: field.count('How many times to press it, 1-20 (default 1)', false, 1),
      },
      async run(session, d) {
        await pressKey(session, { key: d.keys.key, modifiers: d.keys.modifiers, repeat: d.times })
        return { key: { keys: d.keys.key, modifiers: d.keys.modifiers, times: d.times } }
      },
    },
  }

  /** The action schema, built from the same table the validator uses. */
  function actionSchema() {
    return {
      oneOf: Object.entries(DIRECTIVES).map(([directive, spec]) => ({
        type: 'object',
        additionalProperties: false,
        properties: {
          do: { type: 'string', enum: [directive] },
          ...Object.fromEntries(Object.entries(spec.fields).map(([name, definition]) => [name, definition.json])),
        },
        required: ['do', ...Object.entries(spec.fields).filter(([, definition]) => definition.required).map(([name]) => name)],
      })),
    }
  }

  /** Check one action against the table; throws with its index and the field. */
  function validateAction(action, index) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new Error(`action ${index}: expected an object with a "do" field`)
    }
    const directive = action.do
    if (typeof directive !== 'string') {
      const hint = Object.prototype.hasOwnProperty.call(action, 'type')
        ? ' (the old {"type": ...} shape is gone: name the directive in "do")'
        : ''
      throw new Error(`action ${index}: missing "do"${hint}`)
    }
    const spec = DIRECTIVES[directive]
    if (!spec) {
      throw new Error(`action ${index}: unknown directive ${JSON.stringify(directive)}; known: ${Object.keys(DIRECTIVES).join(', ')}`)
    }
    const extra = Object.keys(action).filter((key) => key !== 'do' && !(key in spec.fields))
    if (extra.length > 0) {
      const takes = Object.keys(spec.fields)
      throw new Error(`action ${index} (${directive}): unexpected ${extra.map((key) => JSON.stringify(key)).join(', ')}; it takes ${takes.length ? takes.join(', ') : '(no other fields)'}`)
    }
    const normalized = { do: directive }
    for (const [name, definition] of Object.entries(spec.fields)) {
      if (action[name] === undefined && definition.required) {
        throw new Error(`action ${index} (${directive}): "${name}" is required`)
      }
      try {
        normalized[name] = definition.normalize(action[name], name)
      } catch (error) {
        /* the field says what is wrong; the wrapper says where it is */
        throw new Error(`action ${index} (${directive}): ${error?.message ?? error}`)
      }
    }
    return normalized
  }

  async function input(id, actions, options = {}) {
    const list_ = Array.isArray(actions) ? actions : [actions]
    if (list_.length === 0) throw new Error('wayland_input needs at least one action')
    /* Validate everything — including that named windows exist — before sending
       the first event, so a rejected call leaves the session untouched. */
    const plan = list_.map((action, index) => validateAction(action, index))
    let target = null
    if (options.window !== undefined) {
      if (!Number.isInteger(options.window)) throw new Error('"window" must be a window id from wayland_windows')
      target = options.window
    }
    const session = require(id)
    if (target !== null) await requireWindow(session, target)
    for (const step of plan) if (step.do === 'raise') await requireWindow(session, step.window)

    const applied = []
    if (target !== null) {
      await raiseWindow(session, target)
      applied.push({ raise: target })
    }
    for (let index = 0; index < plan.length; index++) {
      const step = plan[index]
      try {
        applied.push(await DIRECTIVES[step.do].run(session, step))
      } catch (error) {
        const done = applied.length === 0 ? 'no action was applied' : `${applied.length} earlier action(s) were applied`
        throw new Error(`wayland_input: action ${index} (${step.do}) failed: ${error?.message ?? error} (${done})`)
      }
    }
    return { session: session.id, applied, pointer: { ...session.pointer } }
  }

  /* ------------------------------------------------------------- output */

  async function screenshot(id, options = {}) {
    const session = require(id)
    let win = null
    if (Number.isFinite(options.window)) {
      win = (await windows(id)).find((w) => w.id === options.window) ?? null
      if (!win) throw new Error(`no window with id ${options.window} in session ${id}`)
    }
    const mediaType = options.mediaType === 'image/png' ? 'image/png' : 'image/jpeg'
    const data = await capture(session, {
      window: win,
      scale: options.scale,
      quality: options.quality,
      mediaType,
    })
    const result = {
      session: session.id,
      mediaType,
      bytes: data.length,
      width: win ? win.rect.width : session.width,
      height: win ? win.rect.height : session.height,
    }
    if (win) result.window = { id: win.id, appId: win.appId, title: win.title, rect: win.rect }
    const attachments = ctx.get('attachments')
    if (attachments?.saveImage) {
      try {
        const suffix = mediaType === 'image/png' ? 'png' : 'jpg'
        const ref = await attachments.saveImage({ data, mediaType, name: `wayland-${session.id}.${suffix}` })
        result.attachment = ref
      } catch (error) {
        console.error(`${LOG} attachment save failed:`, error?.message ?? error)
      }
    }
    if (!result.attachment) {
      const file = path.join(session.dir, `shot-${Date.now()}.${mediaType === 'image/png' ? 'png' : 'jpg'}`)
      await writeFile(file, data)
      result.path = file
    }
    return result
  }

  /* ------------------------------------------------------------ self-check */

  /**
   * Cheap "it starts and speaks" probes. `existsSync` cannot tell a working binary
   * from one whose shared libraries are missing — a documented limitation — and
   * these run with no session and no side effects. `wtype` has no version flag, so
   * it is asked for its usage text.
   */
  const RUN_PROBES = {
    sway: ['--version'],
    swaymsg: ['--version'],
    grim: ['-h'],
    wlrctl: ['--version'],
    wtype: [],
  }
  const LOADER_FAILURE = /error while loading|shared librar|cannot execute|command not found|No such file/i

  /** Run one binary probe; never throws. Usage text on a non-zero exit still means "it runs". */
  async function probeBinary(entry) {
    const args = RUN_PROBES[entry.name]
    if (!entry.path || !args) return { name: entry.name, status: 'skip', detail: 'present (no side-effect-free probe)' }
    try {
      const { stdout, stderr } = await runOnce(entry.path, args, { timeoutMs: 4000, label: `${entry.name} probe` })
      const line = (stdout.toString('utf8') || stderr).trim().split('\n')[0] ?? ''
      return { name: entry.name, status: 'ok', detail: (line || 'ran').slice(0, 60) }
    } catch (error) {
      const line = `${error?.stdout?.toString('utf8') ?? ''}${error?.stderr ?? ''}`.trim().split('\n')[0] ?? ''
      const spoke = line.length > 0 && !LOADER_FAILURE.test(line)
      return { name: entry.name, status: spoke ? 'ok' : 'fail', detail: (line || error?.message || 'failed').slice(0, 80) }
    }
  }

  /** Can this plugin write where it must? Create the directory, write, remove. */
  async function probeSessionRoot() {
    const file = path.join(root, `.check-${process.pid}`)
    try {
      await mkdir(root, { recursive: true })
      await writeFile(file, 'ok', 'utf8')
      await rm(file, { force: true })
      return { name: 'sessionRoot', status: 'ok', detail: `${root} (writable)` }
    } catch (error) {
      return { name: 'sessionRoot', status: 'fail', detail: `${root}: ${error?.message ?? error}` }
    }
  }

  /** One session's quick health: compositor, IPC, Xwayland, pointer protocol. */
  async function checkSession(session) {
    const checks = []
    const alive = session.proc.exitCode === null
    checks.push({
      name: 'compositor',
      status: alive ? 'ok' : 'fail',
      detail: alive ? `pid ${session.proc.pid} alive` : `exited with ${session.proc.exitCode}`,
    })
    if (alive) {
      try {
        const { stdout } = await swaymsg(session, ['-t', 'get_version', '--raw'], { timeoutMs: 4000, label: 'swaymsg get_version' })
        const version = JSON.parse(stdout.toString('utf8'))?.human_readable ?? 'responded'
        checks.push({ name: 'ipc', status: 'ok', detail: `sway ${version}` })
      } catch (error) {
        checks.push({ name: 'ipc', status: 'fail', detail: String(error?.message ?? error).slice(0, 120) })
      }
      const display = await xwaylandDisplay(session).catch(() => null)
      checks.push({
        name: 'xwayland',
        status: display ? 'ok' : 'warn',
        detail: display ?? 'no DISPLAY: X11 apps (Tk, many games) will not start',
      })
      const pointer = await probeVirtualPointer({
        socketPath: path.join(session.runtimeDir, session.display),
        timeoutMs: 1500,
      }).catch((error) => ({ available: false, reason: error?.message ?? String(error) }))
      checks.push({
        name: 'pointer',
        status: pointer.available ? 'ok' : 'warn',
        detail: pointer.available
          ? `zwlr_virtual_pointer_manager_v1 v${pointer.interfaceVersion}`
          : `${pointer.reason}; falls back to swaymsg/wlrctl, where clicks can be dropped`,
      })
    }
    return { id: session.id, name: session.name, ok: checks.every((entry) => entry.status !== 'fail'), checks }
  }

  /**
   * The whole quick health picture: toolchain, binaries that actually run, a
   * writable session root, and one line per live session. Never throws and never
   * changes anything — a broken host is data, not an exception.
   */
  async function check() {
    const toolchain = toolchainNow()
    const checks = []
    const resolvedRequired = toolchain.required.filter((entry) => entry.path)
    checks.push({
      name: 'toolchain',
      status: toolchain.ready ? (toolchain.missingOptional.length > 0 ? 'warn' : 'ok') : 'fail',
      detail: `${resolvedRequired.length}/${toolchain.required.length} required resolved via ${toolchain.mode}`
        + (toolchain.missingRequired.length > 0 ? `; missing ${toolchain.missingRequired.join(', ')}` : '')
        + (toolchain.missingOptional.length > 0 ? `; optional missing ${toolchain.missingOptional.join(', ')}` : ''),
    })

    const probed = (await Promise.all([...toolchain.required, ...toolchain.optional].map(probeBinary)))
      .filter((entry) => entry.status !== 'skip')
    const broken = probed.filter((entry) => entry.status === 'fail')
    checks.push({
      name: 'binaries run',
      status: probed.length === 0 ? 'warn' : (broken.length === 0 ? 'ok' : 'fail'),
      detail: probed.length === 0 ? 'nothing resolved, so nothing could be run' : probed.map((entry) => `${entry.name}: ${entry.detail}`).join('; '),
    })

    checks.push(await probeSessionRoot())
    checks.push({
      name: 'sessions',
      status: sessions.size >= cfg.maxSessions ? 'warn' : 'ok',
      detail: `${sessions.size} of ${cfg.maxSessions} in use`,
    })

    const live = []
    for (const session of sessions.values()) live.push(await checkSession(session))

    return {
      ok: checks.every((entry) => entry.status !== 'fail') && live.every((entry) => entry.ok),
      checks,
      toolchain,
      sessions: live,
    }
  }

  return {
    root, toolchain: toolchainNow, binPath, requireToolchain,
    create, close, list, windows, launch, input, screenshot, capture, require, byId, check,
    actionSchema,
    envFor, swaymsg, size: () => sessions.size,
    shutdownAll: async () => {
      const all = [...sessions.values()]
      sessions.clear()
      await Promise.all(all.map((s) => kill(s)))
    },
  }
}

/* ------------------------------------------------------------------ tools */

function toolText(title, lines = []) {
  return [{ type: 'text', text: [title, ...lines].filter(Boolean).join('\n') }]
}

/**
 * Model-facing toolchain summary: whether sessions can start, how the binaries
 * resolve, and — when something is missing — what it was for and how to fix it.
 * Compact when everything required is present.
 * @param toolchain - state from {@link probeToolchain}.
 * @returns lines for {@link toolText}.
 */
function toolchainLines(toolchain) {
  const missingOptional = toolchain.optional.filter((entry) => entry.path === undefined)
  const optionalLine = missingOptional.length === 0
    ? []
    : [`Optional, not found: ${missingOptional.map((entry) => `${entry.name} (${entry.purpose})`).join(', ')}.`]
  if (toolchain.ready) {
    const resolved = toolchain.required.map((entry) => `${entry.name} via ${entry.via}`).join(', ')
    return [`Toolchain ready (${toolchain.binDir ? `binDir ${toolchain.binDir}` : 'PATH'}; ${resolved}).`, ...optionalLine]
  }
  return [dependencyReport(toolchain, 'Wayland sessions cannot start'), ...optionalLine]
}

/**
 * The registry accepts plain JSON Schema (`required: [...]`) while these
 * definitions are written in the compact spec form (`required: true` on a
 * property). Convert one into the other.
 */
function specToJsonSchema(node) {
  if (Array.isArray(node)) return node.map(specToJsonSchema)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') {
      /* `required: true` on a property is the compact form and is collected by
         the `properties` branch; an array is already JSON Schema (used inside
         oneOf variants) and is kept as it is. */
      if (Array.isArray(value)) out.required = value
      continue
    }
    if (key === 'properties') {
      const properties = {}
      const required = Array.isArray(node.required) ? [...node.required] : []
      for (const [name, child] of Object.entries(value)) {
        properties[name] = specToJsonSchema(child)
        if (child && typeof child === 'object' && child.required === true && !required.includes(name)) required.push(name)
      }
      out.properties = properties
      if (required.length > 0) out.required = required
      continue
    }
    if (key === 'items') {
      out.items = specToJsonSchema(value)
      continue
    }
    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf') {
      out[key] = value.map(specToJsonSchema)
      continue
    }
    out[key] = value
  }
  return out
}

function registerTools(ctx, manager, cfg) {
  const json = (schema) => specToJsonSchema({ type: 'object', additionalProperties: false, ...schema })
  /* Tool results legitimately carry extra detail (attachment refs, cursor
     state): an output schema documents fields without sealing the object. */
  const stripStrict = (node) => {
    if (Array.isArray(node)) return node.map(stripStrict)
    if (node === null || typeof node !== 'object') return node
    const result = {}
    for (const [key, value] of Object.entries(node)) {
      if (key === 'additionalProperties' && value === false) continue
      result[key] = stripStrict(value)
    }
    return result
  }
  const out = (schema) => stripStrict(specToJsonSchema({ type: 'object', ...schema }))
  const sessionParam = { type: 'string', description: 'Session id from wayland_session_list (or the id returned by wayland_session_create).' }

  ctx.tools.register({
    name: 'wayland_session_create',
    description: 'Start a private headless Wayland desktop (sway) that the user can watch live in the DSH right sidebar, and return the session id the other wayland_* tools take. Use it when a task needs a window. A session starts empty (wayland_launch starts programs), lives as long as DSH does, and only a few may exist at once.',
    parameters: json({
      properties: {
        name: { type: 'string', description: 'Label shown in the session list and in the sidebar panel.' },
        width: { type: 'integer', description: `Screen width in pixels (default ${cfg.width}). Positive integer.` },
        height: { type: 'integer', description: `Screen height in pixels (default ${cfg.height}). Larger screens cost more CPU per live-view frame.` },
      },
    }),
    output: {
      schema: out({
        properties: {
          id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          display: { type: 'string', required: true },
        },
      }),
      render: (args, value) => toolText(`Started Wayland session ${value.id} (${value.width}x${value.height})`, [`name: ${value.name}`, `display: ${value.display}`]),
    },
    presentCall: (args) => ({ card: 'generic', title: `Start Wayland session${args.name ? `: ${args.name}` : ''}`, kind: 'execute', rawInput: args }),
    async execute(args) {
      const session = await manager.create(args ?? {})
      return {
        id: session.id, name: session.name, width: session.width, height: session.height, display: session.display,
      }
    },
  })

  /** One health line: a name, a verdict, and a sentence that says what to do. */
  const checkItem = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      status: { type: 'string', required: true, enum: ['ok', 'warn', 'fail'] },
      detail: { type: 'string', required: true },
    },
  }

  ctx.tools.register({
    name: 'wayland_session_list',
    description: 'List the virtual desktops that exist right now — id, name, size, how many programs each has started, and whether its compositor is still alive. Call it first when earlier work may have left a desktop running instead of creating another one.',
    parameters: json({ properties: {} }),
    output: {
      schema: out({
        properties: {
          sessions: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                display: { type: 'string' },
                alive: { type: 'boolean', required: true },
                createdAt: { type: 'string', required: true },
                apps: { type: 'integer', required: true },
              },
            },
          },
        },
      }),
      render: (args, value) => toolText(
        value.sessions.length === 0 ? 'No Wayland sessions are running.' : `${value.sessions.length} Wayland session(s)`,
        value.sessions.map((s) => `- ${s.id} "${s.name}" ${s.width}x${s.height} apps=${s.apps}${s.alive ? '' : ' (dead)'}`),
      ),
    },
    presentCall: () => ({ card: 'generic', title: 'List Wayland sessions', kind: 'other' }),
    async execute() {
      return { sessions: manager.list() }
    },
  })

  /* The one tool that answers "can this work here at all?" — toolchain, binaries
     that actually run, the session root, and a health line per live session. It
     owns every diagnostic fact, so no other tool's description has to carry one;
     a failing tool simply prints this report's text as its error. */
  ctx.tools.register({
    name: 'wayland_check',
    description: 'Check this plugin\'s health: the toolchain, whether those binaries actually run, whether the session root is writable, and a health line per live session. Run it once before you start using the wayland_* tools, and again when one reports missing dependencies or a session misbehaves. Always succeeds and changes nothing.',
    parameters: json({ properties: {} }),
    output: {
      schema: out({
        properties: {
          ok: { type: 'boolean', required: true, description: 'False when any check failed.' },
          checks: { type: 'array', required: true, items: checkItem },
          toolchain: {
            type: 'object',
            required: true,
            properties: {
              ready: { type: 'boolean', required: true, description: 'True when every required binary resolved.' },
              mode: { type: 'string', required: true, description: 'Where binaries are looked up first: binDir or PATH.' },
              binDir: { type: 'string', required: true, description: 'Configured directory, empty when only PATH is searched.' },
              missingRequired: { type: 'array', required: true, items: { type: 'string' } },
              missingOptional: { type: 'array', required: true, items: { type: 'string' } },
              required: { type: 'array', required: true, items: { type: 'object', properties: { name: { type: 'string', required: true }, purpose: { type: 'string', required: true }, path: { type: 'string' }, via: { type: 'string', enum: ['binDir', 'PATH'] } } } },
              optional: { type: 'array', required: true, items: { type: 'object', properties: { name: { type: 'string', required: true }, purpose: { type: 'string', required: true }, path: { type: 'string' }, via: { type: 'string', enum: ['binDir', 'PATH'] } } } },
              installHints: { type: 'array', required: true, description: 'Package-manager lines for this toolchain, per distribution.', items: { type: 'object', properties: { platform: { type: 'string', required: true }, command: { type: 'string', required: true } } } },
            },
          },
          sessions: {
            type: 'array',
            required: true,
            description: 'One entry per live session; empty when there are none.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                checks: { type: 'array', required: true, items: checkItem },
              },
            },
          },
        },
      }),
      render: (args, value) => toolText(
        `Wayland check: ${value.ok ? 'OK' : 'PROBLEMS'}${value.sessions.length > 0 ? ` (${value.sessions.length} session(s))` : ''}`,
        [
          ...value.checks.map((entry) => `- ${entry.name} [${entry.status}]: ${entry.detail}`),
          ...toolchainLines(value.toolchain),
          ...value.sessions.flatMap((session) => [
            `session ${session.id} "${session.name}" [${session.ok ? 'ok' : 'PROBLEMS'}]`,
            ...session.checks.map((entry) => `  - ${entry.name} [${entry.status}]: ${entry.detail}`),
          ]),
        ],
      ),
    },
    presentCall: () => ({ card: 'generic', title: 'Check the Wayland plugin', kind: 'read' }),
    async execute() {
      return manager.check()
    },
  })

  ctx.tools.register({
    name: 'wayland_session_close',
    description: 'Shut a virtual desktop down: every program started in it is terminated, its windows disappear, and its run directory is removed. Close desktops you have finished with rather than leaving them running. The id must name a live session — closing one twice, or an unknown id, is an error.',
    parameters: json({ properties: { session: { ...sessionParam, required: true } }, required: ['session'] }),
    output: {
      schema: out({ properties: { id: { type: 'string', required: true }, closed: { type: 'boolean', required: true } } }),
      render: (args, value) => toolText(`Closed Wayland session ${value.id}`),
    },
    presentCall: (args) => ({ card: 'generic', title: `Close Wayland session ${args.session}`, kind: 'delete', rawInput: args }),
    async execute(args) {
      return manager.close(args.session)
    },
  })

  ctx.tools.register({
    name: 'wayland_launch',
    description: 'Run a program on a virtual desktop and return its pid plus what became of its window (`window`, `exited`, `timeout`, or `skipped` when wait was false). The program inherits that desktop\'s screen, clipboard and input, so it appears only there; its output goes to the session log, not this result. For shell syntax, use the bash tool — or a terminal inside the session: `command: "foot", args: ["-e", "bash", "-c", "…"]`, whose output stays on that screen (read it with wayland_screenshot) rather than in the session log. A GUI toolkit needs a second or two to draw, so give it a moment before screenshotting.',
    parameters: json({
      properties: {
        session: { ...sessionParam, required: true },
        command: { type: 'string', required: true, description: 'Executable to run: a name on PATH or an absolute path, e.g. "foot", "konsole", "firefox". Run directly, without a shell, so pipes, redirection, globbing and `&&` do not work.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments; each entry becomes one argv entry, exactly as given.' },
        env: { type: 'object', description: 'Extra environment variables as an object of names to values, merged over the session\'s own environment (values are stringified). DISPLAY comes from the session and cannot be overridden here.' },
        cwd: { type: 'string', description: 'Working directory (default: the DSH process\'s home directory).' },
        wait: { type: 'boolean', description: 'Wait for a window before returning, up to waitMs (default true). Set false for programs that open no window.' },
        waitMs: { type: 'integer', description: 'How long to wait for that window, in milliseconds (default 8000; the call blocks meanwhile). Ignored when wait is false.' },
      },
      required: ['session', 'command'],
    }),
    output: {
      schema: out({
        properties: {
          pid: { type: 'integer', required: true },
          command: { type: 'string', required: true },
          outcome: { type: 'string', required: true, enum: ['window', 'exited', 'timeout', 'skipped'], description: 'window: a window for that pid mapped within waitMs. exited: the program ended first; exitCode says how. timeout: still running with no window yet, so check wayland_windows later. skipped: wait was false, so nothing was awaited.' },
          exitCode: { type: 'integer', description: 'Exit status, present once the program has ended.' },
          log: { type: 'string', required: true, description: 'Session log every launched program appends its output to.' },
          window: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer', required: true },
              appId: { type: 'string', required: true },
              title: { type: 'string', required: true },
            },
          },
        },
      }),
      render: (args, value) => toolText(
        `Launched ${value.command} in ${args.session} (pid ${value.pid})`,
        value.outcome === 'window'
          ? [`window ${value.window.id} "${value.window.title}" (${value.window.appId})`]
          : value.outcome === 'exited'
            ? [`the program exited${value.exitCode === undefined ? '' : ` with code ${value.exitCode}`} before a window appeared`, `its output is in ${value.log}`]
            : value.outcome === 'timeout'
              ? ['no window yet and the program is still running; wayland_windows will list it once it maps']
              : ['wait was false, so no window was awaited'],
      ),
    },
    presentCall: (args) => ({ card: 'terminal', title: `Launch ${args.command}`, description: `in ${args.session}`, kind: 'execute', rawInput: args }),
    async execute(args) {
      const launched = await manager.launch(args.session, args)
      return {
        pid: launched.pid,
        command: launched.command,
        outcome: launched.outcome,
        log: launched.log,
        ...(launched.exitCode === undefined ? {} : { exitCode: launched.exitCode }),
        ...(launched.window ? { window: { id: launched.window.id, appId: launched.window.appId, title: launched.window.title } } : {}),
      }
    },
  })

  ctx.tools.register({
    name: 'wayland_windows',
    description: 'List the windows currently mapped on a virtual desktop: window id, app id (or X11 class), title, pid, which one has keyboard focus, and each absolute rect in session pixels. These ids are what wayland_screenshot takes as window and wayland_input takes in a focus action. An empty list means nothing is mapped yet — a program still starting, or one that failed to open a window; pid is left out when the compositor does not know it.',
    parameters: json({ properties: { session: { ...sessionParam, required: true } }, required: ['session'] }),
    output: {
      schema: out({
        properties: {
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                appId: { type: 'string', required: true },
                title: { type: 'string', required: true },
                pid: { type: 'integer' },
                focused: { type: 'boolean', required: true },
                rect: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    x: { type: 'integer', required: true },
                    y: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                },
              },
            },
          },
        },
      }),
      render: (args, value) => (value.windows.length === 0
        ? toolText(`No windows in ${args.session}.`, ['Launch one with wayland_launch.'])
        : toolText(`${value.windows.length} window(s) in ${args.session}`, value.windows.map((w) => `- #${w.id} ${w.appId} "${w.title}" pid=${w.pid ?? '?'} ${w.rect.width}x${w.rect.height}+${w.rect.x}+${w.rect.y}${w.focused ? ' [focused]' : ''}`))),
    },
    presentCall: (args) => ({ card: 'generic', title: 'List windows', kind: 'read', rawInput: args }),
    async execute(args) {
      const found = await manager.windows(args.session)
      return {
        windows: found.map((w) => ({
          id: w.id, appId: w.appId, title: w.title, pid: w.pid ?? undefined, focused: w.focused, rect: w.rect,
        })),
      }
    },
  })

  ctx.tools.register({
    name: 'wayland_screenshot',
    description: 'Capture what a virtual desktop looks like and return it as an image you can see, grabbed during this call. Use it to read GUI state and check that earlier input took effect. At the default scale the image is session pixels, so what you see is where pointer actions land. Errors if window is not currently mapped.',
    parameters: json({
      properties: {
        session: { ...sessionParam, required: true },
        window: { type: 'integer', description: 'Window id from wayland_windows; omit to capture the whole screen.' },
        scale: { type: 'number', description: 'Size multiplier: 1 captures native pixels, 0.5 halves both dimensions. Coordinates in the returned image are session pixels divided by scale, so multiply by 1/scale to get the x/y wayland_input wants.' },
      },
      required: ['session'],
    }),
    output: {
      schema: out({
        properties: {
          session: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true, description: 'Width of the captured area in session pixels (the image itself is scale × smaller).' },
          height: { type: 'integer', required: true, description: 'Height of the captured area in session pixels (the image itself is scale × smaller).' },
          path: { type: 'string' },
          window: { type: 'object', description: 'The captured window, when a window was requested.' },
          attachment: { type: 'object', description: 'Durable image reference, rendered with this result.' },
        },
      }),
      render: (args, value) => {
        const blocks = toolText(
          `Screenshot of ${value.session} (${value.width}x${value.height}, ${Math.round(value.bytes / 1024)} KiB${value.path ? `, ${value.path}` : ''})`,
          args.window ? [`window #${args.window}`] : [],
        )
        const attachment = (value && value.attachment) || null
        if (attachment) blocks.push({ type: 'image', attachment })
        return blocks
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `Screenshot ${args.session}${args.window ? ` #${args.window}` : ''}`, kind: 'read', rawInput: args }),
    async execute(args) {
      /* Format and quality are deployment settings, never call parameters: take
         them from config and forward only the fields a model may choose, so a
         stray mediaType/quality in args cannot leak into the capture. */
      const shot = await manager.screenshot(args.session, {
        window: args.window,
        scale: args.scale,
        mediaType: cfg.screenshotMediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        quality: cfg.screenshotQuality,
      })
      const { attachment, ...rest } = shot
      void attachment
      return { ...rest, ...(attachment ? { attachment } : {}) }
    },
    projectContent(exec, result) {
      const value = result?.value
      if (!value || !value.attachment) return undefined
      return [
        { type: 'text', text: `Screenshot of ${value.session} (${value.width}x${value.height})` },
        { type: 'image', attachment: value.attachment },
      ]
    },
  })

  ctx.tools.register({
    name: 'wayland_input',
    description: 'Send input to a virtual desktop as an ordered list of directives; each entry is exactly one of ten — move, press, release, scroll, wait, raise, click, drag, type, key. Key and text events go to the focused window, so pass window to raise and focus one first; pointer events go to whatever is under the cursor. The whole list is validated before anything is sent: a rejected call names the action and field to fix and leaves the session untouched, and a directive that fails mid-run reports how many earlier ones were applied. Directives run strictly in order, and pointer ones return once the compositor has applied them, so a screenshot straight after reflects them. press/release hold a mouse button across calls (long press, drag); a key is always pressed and released within its own directive.',
    parameters: json({
      properties: {
        session: { ...sessionParam, required: true },
        window: { type: 'integer', description: 'Window to raise and focus before the directives, so keyboard input lands in it. Window id from wayland_windows; omit to type into whatever already has focus. Pointer directives ignore it.' },
        actions: {
          type: 'array',
          required: true,
          description: 'Ordered directives; each one finishes before the next starts.',
          items: { ...manager.actionSchema() },
        },
      },
      required: ['session', 'actions'],
    }),
    output: {
      schema: out({
        properties: {
          session: { type: 'string', required: true },
          applied: { type: 'array', required: true, items: { type: 'object' } },
          pointer: { type: 'object', required: true, description: 'Cursor position in session pixels after the directives.' },
        },
      }),
      render: (args, value) => toolText(
        `Injected ${value.applied.length} directive(s) into ${value.session}`,
        value.applied.map((entry) => `- ${JSON.stringify(entry)}`),
      ),
    },
    presentCall: (args) => ({ card: 'generic', title: `Input into ${args.session}`, kind: 'execute', rawInput: args }),
    async execute(args) {
      return manager.input(args.session, args.actions, { window: args.window })
    },
  })
}

/* --------------------------------------------------------------- http api */

function apply(ctx, config) {
  /* The Host process caches plugin modules for its lifetime, so the same code
     can be mounted twice — for example a workspace development row beside the
     installed bundle. One instance wins and the other stands down, rather than
     registering duplicate tool names and route paths. */
  const guard = Symbol.for('dsh-wayland.host.applied')
  if (globalThis[guard] === true) {
    console.error(`${LOG} another instance already owns this process; standing down`)
    return
  }
  globalThis[guard] = true

  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const manager = createManager(ctx, cfg)
  const liveProfile = {
    fps: Math.max(1, Math.min(30, Math.round(Number(cfg.liveFps) || 20))),
    quality: Math.max(1, Math.min(100, Math.round(Number(cfg.liveQuality) || 82))),
    mediaType: cfg.liveMediaType === 'image/png' ? 'image/png' : 'image/jpeg',
  }
  let token = randomBytes(24).toString('hex')

  const startup = manager.toolchain()
  if (!startup.ready) {
    /* Never fatal: the plugin loads, the panel explains, and the tools report it.
       Installing the binaries later works without a reload, because resolution
       is re-read on every retry. */
    console.error(`${LOG} ${dependencyReport(startup, 'Wayland sessions are unavailable').split('\n').join(`\n${LOG} `)}`)
  } else {
    console.log(`${LOG} toolchain: ${startup.required.map((entry) => `${entry.name} via ${entry.via}`).join(', ')} (session root ${manager.root})`)
  }
  if (startup.ready && startup.missingOptional.length > 0) {
    console.log(`${LOG} optional, not found: ${startup.missingOptional.join(', ')} — some features stay unavailable`)
  }

  registerTools(ctx, manager, cfg)

  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_WAYLAND__',
      value: { token, base: BASE, live: liveProfile, sessions: manager.list(), toolchain: manager.toolchain() },
    })
  }), 'dsh-wayland:index-injection')

  // The token is persisted in the (user-only) session root: it doubles as the
  // local diagnostic handle for curl, and it survives a plugin reload so an
  // already-open page keeps working instead of suddenly answering 403.
  const tokenFile = path.join(manager.root, 'token')
  let reusedToken = false
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (/^[0-9a-f]{32,}$/.test(existing)) {
      reusedToken = true
      token = existing
    }
  } catch {
    /* no token file yet */
  }
  if (!reusedToken) {
    try {
      mkdirSync(manager.root, { recursive: true, mode: 0o700 })
      writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    } catch (error) {
      console.error(`${LOG} could not persist the token:`, error?.message ?? error)
    }
  }
  console.log(`${LOG} api token ${reusedToken ? 'reused from' : 'written to'} ${tokenFile}`)

  const authorized = (req, url) => {
    const header = req.headers['x-dsh-wayland-token']
    const provided = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token')
    return safeEqual(String(provided ?? ''), token)
  }

  const readBody = (req, limit = 512 * 1024) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

  const sendJson = (res, status, value) => {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'ping':
        return { ok: true, toolchain: manager.toolchain() }
      case 'sessions.list':
        return { sessions: manager.list() }
      case 'sessions.create': {
        const session = await manager.create(params ?? {})
        return { session: manager.list().find((s) => s.id === session.id) }
      }
      case 'sessions.close':
        return manager.close(params?.session)
      case 'apps.launch':
        return manager.launch(params?.session, params ?? {})
      case 'apps.default': {
        const found = manager.binPath(cfg.defaultApp) ?? cfg.defaultApp
        return { command: found }
      }
      case 'windows.list':
        return { windows: await manager.windows(params?.session) }
      case 'input':
        return manager.input(params?.session, params?.actions, { window: params?.window })
      case 'screenshot': {
        const shot = await manager.screenshot(params?.session, params ?? {})
        const { attachment, ...rest } = shot
        void attachment
        return rest
      }
      default:
        throw new Error(`unknown method ${JSON.stringify(method)}`)
    }
  }

  async function handleStream(req, res, url) {
    const session = manager.byId(url.searchParams.get('session')) ?? [...manager.list()].at(0)
    if (!session) {
      sendJson(res, 404, { error: 'no wayland session' })
      return
    }
    const scale = Number(url.searchParams.get('scale') ?? cfg.streamScale) || 1
    const quality = Number(url.searchParams.get('quality') ?? cfg.streamQuality) || cfg.streamQuality
    const fps = Math.max(1, Math.min(30, Number(url.searchParams.get('fps') ?? cfg.streamFps) || cfg.streamFps))
    const interval = Math.round(1000 / fps)
    const live = manager.require(session.id)
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Connection: 'close',
    })
    let stopped = false
    const stop = () => { stopped = true }
    req.on('close', stop)
    res.on('close', stop)
    res.on('error', stop)
    let failures = 0
    while (!stopped) {
      const started = Date.now()
      try {
        const frame = await manager.capture(live, { scale, quality })
        if (stopped) break
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`)
        res.write(frame)
        res.write('\r\n')
        failures = 0
      } catch (error) {
        failures += 1
        if (failures > 5) {
          console.error(`${LOG} stream for ${session.id} aborted:`, error?.message ?? error)
          break
        }
        await sleep(400)
      }
      const elapsed = Date.now() - started
      if (elapsed < interval) await sleep(interval - elapsed)
    }
    try { res.end() } catch {}
  }

  async function handleHttp(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { error: 'bad url' })
      return
    }
    if (!url.pathname.startsWith(BASE)) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const sub = url.pathname.slice(BASE.length)
    if (sub === '/boot' && req.method === 'GET') {
      // Deliberately unauthenticated: a cross-origin page can send this request
      // but cannot read the response, and the token still gates every operation.
      sendJson(res, 200, {
        ok: true,
        value: { token, base: BASE, live: liveProfile, sessions: manager.list(), toolchain: manager.toolchain() },
      })
      return
    }
    if (!authorized(req, url)) {
      sendJson(res, 403, { error: 'missing or invalid token' })
      return
    }
    try {
      if (sub === '/stream' && req.method === 'GET') {
        await handleStream(req, res, url)
        return
      }
      if (sub === '/frame' && req.method === 'GET') {
        const session = manager.require(url.searchParams.get('session'))
        /* PNG is lossless and, for flat UI content, smaller than JPEG; keep the
           scaled JPEG path for photographic or CPU-tight use. */
        const mediaType = url.searchParams.get('mediaType') === 'png' ? 'image/png' : 'image/jpeg'
        const scale = url.searchParams.has('scale')
          ? Number(url.searchParams.get('scale'))
          : (mediaType === 'image/png' ? 1 : cfg.streamScale)
        const frame = await manager.capture(session, {
          scale: scale || 1,
          quality: Number(url.searchParams.get('quality') ?? cfg.streamQuality),
          mediaType,
        })
        res.writeHead(200, {
          'Content-Type': mediaType,
          'Cache-Control': 'no-store',
          'Content-Length': frame.length,
          'X-Frame-At': String(Date.now()),
        })
        res.end(frame)
        return
      }
      if (sub === '/api' && req.method === 'POST') {
        const raw = await readBody(req)
        const payload = raw ? JSON.parse(raw) : {}
        const value = await dispatch(payload.method, payload.params)
        sendJson(res, 200, { ok: true, value })
        return
      }
      if (sub === '/api' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, value: { sessions: manager.list(), toolchain: manager.toolchain() } })
        return
      }
      sendJson(res, 404, { error: `unknown endpoint ${sub}` })
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: BASE, handler: handleHttp }), 'dsh-wayland:http')
  ctx.effect(() => () => manager.shutdownAll(), 'dsh-wayland:sessions')
  ctx.effect(() => () => {
    /* Let a later mount take over after this instance is disposed. */
    if (globalThis[guard] === true) delete globalThis[guard]
  }, 'dsh-wayland:guard')
}

export { apply, DEFAULTS }
