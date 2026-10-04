/**
 * Offline check for the pointer the captures draw.
 *
 * Two things have to line up for a pointer to appear in a screenshot or the live
 * view, and only one of them is offline-testable:
 *
 *   - the frame must be captured with the cursor painted. On a headless output
 *     wlroots keeps the cursor as a hardware cursor that the backend never
 *     composites, so grim needs `-c`/PAINT_CURSORS. Measured live, not here.
 *   - the session must have a pointer device at all, since sway only loads a
 *     cursor image when the seat gains pointer capability — hence the pointer is
 *     connected at session creation, not on first input.
 *
 * What this script does pin down, with a fake toolchain and a fake sway, is the
 * theme the image comes from:
 *
 *   - a configured theme lands in the generated sway.conf as
 *     `seat * xcursor_theme <name> <size>`, with the size clamped to a sane range
 *   - a configured theme this machine does not have is reported as a warn, and
 *     the wording says sway falls back to its own cursor rather than claiming no
 *     pointer (wlroots always has a built-in fallback)
 *   - auto-detection either finds a theme that really ships cursors/left_ptr (and
 *     then the config names it) or reports that same fallback warn — never a
 *     claim without the corresponding config line, and never a failure
 *   - `wayland_check` carries that verdict as a `cursor` line
 *   - the model-facing text says the pointer is in the image and where the theme
 *     verdict comes from
 *
 * Run: node .probe/check-cursor.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { dshToolsPath } from './dsh-tools.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'plugin', 'host.js')
const TMP = mkdtempSync(join(HERE, '.tmp-cursor-'))

const { validateJsonSchemaValue } = await import(dshToolsPath())
const { apply } = await import(PLUGIN)

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

/* Fake sway: sway's IPC socket has to appear for the plugin to call it ready,
   and the process has to stay alive so the session is not declared dead. It runs
   on the current node binary by absolute path, because this probe empties PATH
   so that only the fake toolchain can satisfy a lookup. */
const binDir = join(TMP, 'bin')
mkdirSync(binDir, { recursive: true })
writeFileSync(join(binDir, 'sway'),
  `#!${process.execPath}\n`
  + `import { writeFileSync } from 'node:fs'\n`
  + `if (process.argv.includes('--version')) { console.log('sway version fake'); process.exit(0) }\n`
  + `writeFileSync(process.env.XDG_RUNTIME_DIR + '/sway-ipc.1.1.sock', '')\n`
  + `setTimeout(() => {}, 60000)\n`,
  { mode: 0o755 })
for (const name of ['swaymsg', 'grim', 'wtype']) writeFileSync(join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

/** Mount the plugin against the fake toolchain; returns its tools by name. */
const mount = (config) => {
  const tools = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    webServer: { tapIndex: () => () => {}, register: () => () => {} },
    effect: (callback) => { callback?.(); return () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  delete globalThis[Symbol.for('dsh-wayland.host.applied')]
  apply(ctx, config)
  return new Map(tools.map((tool) => [tool.name, tool]))
}

const render = (tool, args, value) => {
  validateJsonSchemaValue(tool.output.schema, value, 'value')
  return tool.output.render(args, value).map((block) => block.text).join('\n')
}

const sessionRoot = join(TMP, 'root')
/* The only source of binaries for the whole run. */
process.env.PATH = ''

/* ------------------------------------------- an explicitly configured theme */
{
  const tools = mount({ binDir, sessionRoot, cursorTheme: 'probe-cursors', cursorSize: 999 })
  const created = await tools.get('wayland_session_create').execute({ name: 'cursor-config' })
  const conf = readFileSync(join(sessionRoot, created.id, 'sway.conf'), 'utf8')
  check(conf.includes('seat * xcursor_theme probe-cursors 512'),
    `a configured theme must be written with a clamped size, saw:\n${conf}`)

  const report = await tools.get('wayland_check').execute({})
  const line = report.checks.find((entry) => entry.name === 'cursor')
  check(Boolean(line), 'wayland_check must carry a cursor line')
  /* A configured theme this machine does not have must be reported, not assumed:
     sway would silently fall back to its own small cursor. The wording must say
     so — "no pointer" would be wrong, wlroots always has a built-in fallback. */
  check(line?.status === 'warn', `a theme that is not installed must warn, saw ${JSON.stringify(line)}`)
  check(String(line?.detail).includes('probe-cursors') && String(line?.detail).includes('not installed'),
    `the cursor line must name the missing theme, saw ${JSON.stringify(line?.detail)}`)
  check(/fallback/.test(String(line?.detail)) && !/no pointer/.test(String(line?.detail)),
    `the fallback must be stated, not "no pointer", saw ${JSON.stringify(line?.detail)}`)
  check(/^- cursor \[warn\]/m.test(render(tools.get('wayland_check'), {}, report)),
    'the rendered report must show the cursor verdict')

  const closed = await tools.get('wayland_session_close').execute({ session: created.id })
  check(closed.closed === true, 'the fake session must close again')
}

/* ------------------------------------------------------ auto-detection */
{
  const tools = mount({ binDir, sessionRoot })
  const created = await tools.get('wayland_session_create').execute({ name: 'cursor-auto' })
  const conf = readFileSync(join(sessionRoot, created.id, 'sway.conf'), 'utf8')
  const report = await tools.get('wayland_check').execute({})
  const line = report.checks.find((entry) => entry.name === 'cursor')
  const seat = /^seat \* xcursor_theme (\S+) (\d+)$/m.exec(conf)
  check(line?.status === 'ok' || line?.status === 'warn',
    `auto-detection must end in ok or warn, saw ${JSON.stringify(line)}`)
  if (line?.status === 'ok') {
    check(Boolean(seat), `a found theme must reach sway.conf, saw:\n${conf}`)
    check(String(line.detail).includes(seat?.[1] ?? '\u0000'),
      `the report and the config must name the same theme, saw ${JSON.stringify(line.detail)} vs ${JSON.stringify(seat?.[1])}`)
    check(Number(seat?.[2]) >= 8 && Number(seat?.[2]) <= 512, `cursor size out of range: ${seat?.[2]}`)
  } else {
    check(!seat, `no theme found, so the config must not name one, saw:\n${conf}`)
    check(/cursorTheme/.test(String(line?.detail)), 'the warn line must say how to fix it')
    check(/fallback/.test(String(line?.detail)),
      `the warn line must name the fallback the session will use, saw ${JSON.stringify(line?.detail)}`)
  }
  /* A host without a cursor theme is still a healthy host: the verdict is warn,
     never fail — overall `ok` cannot be asserted here because a fake compositor
     cannot satisfy the per-session health line. */
  await tools.get('wayland_session_close').execute({ session: created.id })
}

/* --------------------------------------------------- model-facing text */
{
  const tools = mount({ binDir, sessionRoot })
  const screenshot = String(tools.get('wayland_screenshot').description)
  /* The sprite is in every capture now — the eager pointer device plus the
     PAINT_CURSORS flag — so the model has to expect it, wherever the theme
     comes from. */
  check(/pointer is drawn at its current position/.test(screenshot),
    'the screenshot description must say the pointer is in the image')
  check(/wayland_check/.test(screenshot), 'the screenshot description must say where the theme verdict comes from')
  const doctor = String(tools.get('wayland_check').description)
  check(/cursor theme/.test(doctor), 'wayland_check must list the cursor theme among what it checks')
}

rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`cursor check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('cursor check ok: theme resolved once, written into sway.conf, reported by wayland_check, and told to the model')
