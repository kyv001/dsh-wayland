/**
 * Offline check: the plugin degrades instead of crashing when the wlroots
 * toolchain is absent.
 *
 * Three toolchains are simulated by pointing `binDir` at prepared directories
 * and emptying PATH for the run:
 *   - nothing installed: activation succeeds, every tool call reports the
 *     missing binaries with their purpose and the fixes;
 *   - partially installed: only what is still missing is reported;
 *   - fully installed: the report flips to ready.
 *
 * The tool results are validated against the schemas the plugin declares, the
 * same way the tool runtime validates them, so a result shape that the model
 * would never see cannot pass here.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** This script's own directory, so nothing here depends on where the repo lives. */
const HERE = dirname(fileURLToPath(import.meta.url))

import { dshToolsPath } from './dsh-tools.mjs'

const PLUGIN = join(HERE, '..', 'plugin', 'host.js')
const TMP = join(HERE, '.tmp-degraded')

const { validateJsonSchemaValue } = await import(dshToolsPath())
const { apply } = await import(PLUGIN)

const REQUIRED = ['sway', 'swaymsg', 'grim', 'wtype']
/* wlrctl is only the fallback for compositors without the virtual-pointer
   protocol: the session's own persistent virtual pointer needs no binary. */
const OPTIONAL = ['wlrctl', 'wl-copy', 'foot', 'wayvnc', 'wf-recorder', 'xterm']

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const stubContext = () => {
  const tools = []
  return {
    tools,
    ctx: {
      tools: { register: (definition) => { tools.push(definition); return () => {} } },
      webServer: { tapIndex: () => () => {}, register: () => () => {} },
      effect: (callback) => { callback?.(); return () => {} },
      get: () => undefined,
      on: () => () => {},
      logger: { info() {}, warn() {}, error() {} },
    },
  }
}

/** Materialize a binDir holding exactly `names`, so resolution is real. */
const binDirWith = (names) => {
  const dir = join(TMP, `bin-${names.length}-${names.join('-') || 'empty'}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return dir
}

/**
 * The plugin stands down when a second instance mounts in the same process, so
 * each simulated toolchain needs the guard cleared the way a fresh process has it.
 */
const resetGuard = () => { delete globalThis[Symbol.for('dsh-wayland.host.applied')] }

const byName = (tools) => new Map(tools.map((tool) => [tool.name, tool]))
const render = (tool, args, value) => {
  validateJsonSchemaValue(tool.output.schema, value, 'value')
  return tool.output.render(args, value).map((block) => block.text).join('\n')
}

rmSync(TMP, { recursive: true, force: true })
/* Nothing on PATH for the whole run: the only source is binDir. */
process.env.PATH = ''

/* ---------------------------------------------------- nothing installed */
{
  const { ctx, tools } = stubContext()
  resetGuard()
  apply(ctx, { binDir: join(TMP, 'does-not-exist'), sessionRoot: join(TMP, 'root-empty') })
  check(tools.length === 7, `expected 7 tools, registered ${tools.length}`)
  const registry = byName(tools)

  const listed = await registry.get('wayland_session_list').execute({})
  check(listed.toolchain.ready === false, 'nothing installed must not report ready')
  check(JSON.stringify(listed.toolchain.missingRequired) === JSON.stringify(REQUIRED),
    `missingRequired was ${JSON.stringify(listed.toolchain.missingRequired)}`)
  check(JSON.stringify(listed.toolchain.missingOptional) === JSON.stringify(OPTIONAL),
    `missingOptional was ${JSON.stringify(listed.toolchain.missingOptional)}`)
  check(listed.sessions.length === 0, 'a fresh plugin must report no sessions')
  check(listed.toolchain.optional.some((entry) => entry.name === 'wlrctl'),
    'pointer fallback wlrctl must be optional, not required: pointer input needs no binary')

  const text = render(registry.get('wayland_session_list'), {}, listed)
  for (const name of REQUIRED) check(text.includes(name), `list report never names ${name}`)
  for (const name of REQUIRED) {
    const entry = listed.toolchain.required.find((item) => item.name === name)
    check(typeof entry.purpose === 'string' && entry.purpose.length > 0, `${name} has no purpose`)
    check(text.includes(entry.purpose), `list report never explains ${name}`)
  }
  check(text.includes('binDir'), 'list report never mentions binDir')
  check(Array.isArray(listed.toolchain.installHints) && listed.toolchain.installHints.length >= 3,
    'the toolchain payload carries no install hints for the panel to render')
  for (const hint of listed.toolchain.installHints) {
    check(typeof hint.platform === 'string' && typeof hint.command === 'string', 'an install hint is malformed')
  }
  for (const hint of listed.toolchain.installHints) check(text.includes(hint.command), `list report omits the hint for ${hint.platform}`)
  check(text.includes('apt install') && text.includes('pacman -S') && text.includes('dnf install'),
    'list report is missing one of the apt/dnf/pacman install lines')
  check(!/nix/i.test(JSON.stringify(listed.toolchain)) && !/nix/i.test(text),
    'the dependency report mentions a distribution-specific mechanism instead of plain PATH/packages')

  const create = await registry.get('wayland_session_create').execute({}).then(() => null, (error) => error)
  check(create instanceof Error, 'wayland_session_create must fail, not hang or crash')
  for (const name of REQUIRED) check(String(create?.message).includes(name), `create error never names ${name}`)
  check(String(create?.message).includes('Install them'), 'create error never says how to fix it')

  /* A tool that needs a session must explain the toolchain, not just "unknown id". */
  const windows = await registry.get('wayland_windows').execute({ session: 'nope' }).then(() => null, (error) => error)
  check(String(windows?.message).includes('missing required'), 'windows error hides the dependency problem')

  console.log('--- model-facing report with nothing installed (this is what the model reads) ---')
  console.log(text)
  console.log('--- the same payload the panel renders (GET /boot -> toolchain) ---')
  console.log(JSON.stringify(listed.toolchain, null, 1))
}

/* --------------------------------------------------- partially installed */
{
  const { ctx, tools } = stubContext()
  resetGuard()
  apply(ctx, { binDir: binDirWith(['sway']), sessionRoot: join(TMP, 'root-partial') })
  const listed = await byName(tools).get('wayland_session_list').execute({})
  check(listed.toolchain.ready === false, 'a partial toolchain must not report ready')
  check(JSON.stringify(listed.toolchain.missingRequired) === JSON.stringify(REQUIRED.filter((name) => name !== 'sway')),
    `partial missingRequired was ${JSON.stringify(listed.toolchain.missingRequired)}`)
  const sway = listed.toolchain.required.find((entry) => entry.name === 'sway')
  check(sway.via === 'binDir' && sway.path.endsWith('/sway'), 'a found binary must report its path and source')

  const create = await byName(tools).get('wayland_session_create').execute({}).then(() => null, (error) => error)
  check(String(create?.message).includes('grim') && !String(create?.message).includes('- sway:'),
    'a partial report must name what is missing and not what was found')
  console.log('--- partial toolchain')
  console.log(String(create?.message))
}

/* ---------------------------------------------------- fully installed */
{
  const { ctx, tools } = stubContext()
  resetGuard()
  apply(ctx, { binDir: binDirWith([...REQUIRED, ...OPTIONAL]), sessionRoot: join(TMP, 'root-full') })
  const listed = await byName(tools).get('wayland_session_list').execute({})
  check(listed.toolchain.ready === true, 'a complete toolchain must report ready')
  check(listed.toolchain.missingRequired.length === 0, 'a complete toolchain must miss nothing required')
  const text = render(byName(tools).get('wayland_session_list'), {}, listed)
  check(text.includes('Toolchain ready'), `ready report was: ${text}`)
  check(text.includes('sway via binDir'), `ready report never shows how sway resolved: ${text}`)
  console.log('--- complete toolchain')
  console.log(text)
}

rmSync(TMP, { recursive: true, force: true })

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`degraded check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('degraded check ok: activation, list, create and the panel contract all survive a missing toolchain')
