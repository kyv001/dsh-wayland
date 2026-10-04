/**
 * Offline check for wayland_launch's result contract.
 *
 * "No window appeared" used to cover three different situations — the program
 * died, the program is still drawing, or nobody waited — so a caller could not
 * tell what to do next. The tool now reports an explicit `outcome`, and this
 * pins the wording of each one without needing a compositor:
 *
 *   - the schema declares `outcome` as required with exactly four values
 *   - the shell story is told exactly once: the description names the route (the
 *     bash tool, or a terminal inside the session) and warns that a terminal keeps
 *     its output on screen, so the `command` parameter must not restate the rule
 *   - `env` states its shape, the merge, and the DISPLAY rule
 *   - every outcome renders a different, actionable line, and `exited` names the
 *     exit code and the log the output went to
 *
 * Run: node .probe/check-launch.mjs
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { apply } = await import(join(HERE, '..', 'plugin', 'host.js'))

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

const tools = []
delete globalThis[Symbol.for('dsh-wayland.host.applied')]
apply({
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  webServer: { tapIndex: () => () => {}, register: () => () => {} },
  effect: (callback) => { callback?.(); return () => {} },
  get: () => undefined,
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
}, { binDir: join(HERE, '.tmp-launch-no-binaries'), sessionRoot: join(HERE, '.tmp-launch-root') })

const tool = tools.find((entry) => entry.name === 'wayland_launch')
check(Boolean(tool), 'wayland_launch was not registered')
if (!tool) {
  console.log('FAIL wayland_launch was not registered')
  process.exit(1)
}

/* --------------------------------------------------------------- schema */
const outcome = tool.output?.schema?.properties?.outcome
check(Array.isArray(outcome?.enum), 'the result must declare an outcome')
check(JSON.stringify(outcome?.enum) === JSON.stringify(['window', 'exited', 'timeout', 'skipped']),
  `outcome must enumerate the four cases, saw ${JSON.stringify(outcome?.enum)}`)
for (const name of ['pid', 'command', 'outcome', 'log']) {
  check(tool.output?.schema?.required?.includes(name), `${name} must be required in the result`)
}
check(tool.output?.schema?.properties?.exitCode !== undefined, 'exitCode must be part of the result')

const params = tool.parameters?.properties ?? {}
check(/terminal/i.test(tool.description) && /bash/.test(tool.description),
  'the description must state the shell route (the bash tool or a terminal in the session)')
check(/stays on that screen|not in the session log/.test(tool.description),
  'the shell route must warn that a terminal keeps its output on screen')
check(!/without a shell|globbing|redirection|&&/.test(params.command?.description ?? ''),
  'the command parameter must not restate the shell rule: the route sentence already says it')
check(!/e\.g\./i.test(params.command?.description ?? ''),
  'the command parameter must not list example programs')
check(/merged over/i.test(params.env?.description ?? '') && /DISPLAY/.test(params.env?.description ?? ''),
  'the env parameter must state the merge and the DISPLAY rule')
check(/stringified|string/i.test(params.env?.description ?? ''),
  'the env parameter must state that values are stringified')

/* --------------------------------------------------------------- render */
const base = { pid: 4242, command: 'demo', log: '/run/user/1000/dsh-wayland/w1/apps.log' }
const text = (value) => tool.output.render({ session: 'w1' }, { ...base, ...value })
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n')

const rendered = {
  window: text({ outcome: 'window', window: { id: 7, appId: 'Tk', title: 'Demo' } }),
  exited: text({ outcome: 'exited', exitCode: 3 }),
  timeout: text({ outcome: 'timeout' }),
  skipped: text({ outcome: 'skipped' }),
}
check(/window 7 "Demo" \(Tk\)/.test(rendered.window), `window outcome must name the window, saw ${JSON.stringify(rendered.window)}`)
check(/exited with code 3/.test(rendered.exited), `exited outcome must name the exit code, saw ${JSON.stringify(rendered.exited)}`)
check(rendered.exited.includes(base.log), 'exited outcome must point at the log the output went to')
check(/still running/.test(rendered.timeout), `timeout outcome must say the program is still running, saw ${JSON.stringify(rendered.timeout)}`)
check(/wayland_windows/.test(rendered.timeout), 'timeout must say how to look for the window later')
check(/wait was false/.test(rendered.skipped), `skipped outcome must explain itself, saw ${JSON.stringify(rendered.skipped)}`)

const lines = Object.values(rendered)
check(new Set(lines).size === lines.length, 'the four outcomes must not render the same text')

rmSync(join(HERE, '.tmp-launch-root'), { recursive: true, force: true })

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`launch check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('launch check ok: four distinct outcomes, indexed result, and the shell route told exactly once')
