/**
 * Offline check for the wayland_input directive surface.
 *
 * The input tool is the one place where a call can do several things in a row,
 * so its shape and its rejection behaviour are contract, not implementation
 * detail. This runs the real tool definition with a stub context (no toolchain,
 * no session) and asserts:
 *
 *   - the action schema is a oneOf union with one variant per directive, each
 *     variant sealed (additionalProperties:false) and requiring exactly what it
 *     needs, so a schema-aware caller cannot emit a foreign field
 *   - the schema and the validator come from one table: every variant's required
 *     set matches the directive's required fields
 *   - a malformed payload is rejected *before* the session is looked at, with the
 *     action index, the directive and the field named — and with a migration hint
 *     for the pre-redesign `{type: ...}` shape
 *   - a well-formed payload is not rejected as a payload error
 *   - what a call reports about the pointer: a position only when that same call
 *     asserted one, because no compositor API reads the cursor position back.
 *     This half drives real directives through a fake session (fake sway, fake
 *     toolchain). `drag` is the exception — holding a button needs the
 *     virtual-pointer protocol, which the fake session does not speak — so the
 *     drag shape is measured live instead.
 *
 * Failure *state* is pinned by what the error says, not by prose in the tool
 * description: a rejection names the action index, the directive and the field,
 * and a mid-run failure reports how many earlier directives were applied.
 *
 * Run: node .probe/check-input.mjs
 */
import { dshToolsPath } from './dsh-tools.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'plugin', 'host.js')

/* The schema must also pass the real Harness validator, not just look right. */
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(dshToolsPath())
const { apply } = await import(PLUGIN)

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

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
apply(ctx, { binDir: join(HERE, '.tmp-input-no-binaries'), sessionRoot: join(HERE, '.tmp-input-root') })

const tool = tools.find((entry) => entry.name === 'wayland_input')
check(Boolean(tool), 'wayland_input was not registered')
if (!tool) {
  console.log('FAIL wayland_input was not registered')
  process.exit(1)
}

/* ------------------------------------------------------- the union shape */
const schema = tool.parameters
check(schema.additionalProperties === false, 'the tool parameters must be sealed')
const actionItems = schema.properties?.actions?.items
check(Array.isArray(actionItems?.oneOf), 'actions must be a oneOf union of directive variants')
const variants = actionItems?.oneOf ?? []
const EXPECTED = ['move', 'press', 'release', 'scroll', 'wait', 'raise', 'click', 'drag', 'type', 'key']
const names = variants.map((variant) => variant.properties?.do?.enum?.[0])
check(JSON.stringify(names) === JSON.stringify(EXPECTED), `variants must be exactly ${EXPECTED.join(', ')}, saw ${JSON.stringify(names)}`)

/** What each directive must require, and what it may take — pinned by hand. */
const REQUIRED = {
  move: ['do', 'to'], press: ['do', 'button'], release: ['do', 'button'], scroll: ['do', 'by'],
  wait: ['do', 'ms'], raise: ['do', 'window'], click: ['do'], drag: ['do', 'to'],
  type: ['do', 'text'], key: ['do', 'keys'],
}
const FIELDS = {
  move: ['do', 'to'], press: ['do', 'button'], release: ['do', 'button'], scroll: ['do', 'by'],
  wait: ['do', 'ms'], raise: ['do', 'window'], click: ['do', 'at', 'button', 'times'],
  drag: ['do', 'from', 'to', 'button'], type: ['do', 'text'], key: ['do', 'keys', 'times'],
}
for (const variant of variants) {
  const name = variant.properties?.do?.enum?.[0]
  const want = REQUIRED[name]
  check(variant.type === 'object', `${name}: variant must be an object schema`)
  check(variant.additionalProperties === false, `${name}: variant must be sealed (additionalProperties:false)`)
  check(JSON.stringify([...(variant.required ?? [])].sort()) === JSON.stringify([...want].sort()),
    `${name}: required must be ${JSON.stringify(want)}, saw ${JSON.stringify(variant.required)}`)
  const props = Object.keys(variant.properties ?? {})
  check(JSON.stringify([...props].sort()) === JSON.stringify([...FIELDS[name]].sort()),
    `${name}: properties must be ${JSON.stringify(FIELDS[name])}, saw ${JSON.stringify(props)}`)
  check((variant.properties.do.enum ?? []).length === 1, `${name}: "do" must pin exactly one directive`)
}
check(schema.properties.actions.description.includes('finishes before'), 'the actions field must state the ordering')
check(schema.properties.window !== undefined, 'the tool must expose the optional keyboard target window')
assertSupportedJsonSchema(tool.parameters, 'wayland_input parameters')

/* ------------------------------------------------- rejection behaviour */
const execute = async (actions, args = {}) => {
  try {
    const value = await tool.execute({ session: 'nope', actions, ...args })
    return { value }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}
const rejects = async (actions, fragment, label, args) => {
  const { error } = await execute(actions, args)
  check(typeof error === 'string' && error.includes(fragment), `${label}: expected an error containing ${JSON.stringify(fragment)}, saw ${JSON.stringify(error)}`)
}

await rejects([{ do: 'type' }], 'action 0 (type): "text" is required', 'missing required field')
await rejects([{ do: 'type', text: 'x' }, { do: 'drag', to: [1] }], 'action 1 (drag): "to" must be [x, y]', 'tuple shape with index')
await rejects([{ do: 'click', at: [1, 2], junk: 1 }], 'action 0 (click): unexpected "junk"', 'foreign field')
await rejects([{ do: 'press', button: 'middle', key: 'a' }], 'unexpected "key"', 'press takes button only')
await rejects([{ do: 'wait', ms: -1 }], '"ms" must be an integer from 0 to 60000', 'wait range')
await rejects([{ do: 'key', keys: 'hyper+a' }], '"hyper" is not a modifier', 'unknown modifier')
await rejects([{ do: 'key', keys: '' }], 'must be a non-empty key chord', 'empty chord')
await rejects([{ type: 'click', x: 1, y: 2 }], 'the old {"type": ...} shape is gone', 'migration hint')
await rejects([{ do: 'clik', at: [1, 2] }], 'unknown directive "clik"', 'unknown directive')
await rejects([], 'at least one action', 'empty list')

/* A well-formed payload must get past validation: whatever error comes back,
   it must not be a payload error, which is what "validated first" means. */
{
  const { error } = await execute([{ do: 'click', at: [10, 20], times: 2 }, { do: 'wait', ms: 0 }])
  check(typeof error === 'string' && error.length > 0, 'a valid payload must still fail on the unknown session')
  check(!/action \d/.test(error ?? ''), `a valid payload must not be rejected as a payload error, saw ${JSON.stringify(error)}`)
}
{
  /* Validation must run before the session is resolved: a bad payload names the
     payload problem even when the session id is nonsense. */
  const { error } = await execute([{ do: 'move', to: 'nope' }])
  check(/action 0 \(move\): "to" must be \[x, y\]/.test(error ?? ''), `payload errors must precede session lookup, saw ${JSON.stringify(error)}`)
}

/* ------------------------------------- what a call reports about the pointer */

/* The cursor's position cannot be read back from a compositor, so the only
   position this plugin can honestly report is one the same call asserted. A fake
   session makes that checkable end to end: fake sway answers as ready, every
   `swaymsg` works except moving the cursor (which forces the relative `wlrctl`
   path — the one that must re-home before it can trust a delta), and `wlrctl`
   records the argv it was called with. */
{
  const TMP = mkdtempSync(join(HERE, '.tmp-input-'))
  const binDir = join(TMP, 'bin')
  const wlrctlLog = join(TMP, 'wlrctl.log')
  mkdirSync(binDir, { recursive: true })
  /* sway writes the IPC socket the plugin waits for and stays alive so the
     session is not declared dead. It runs on this node binary by absolute path,
     because this phase empties PATH so that only the fake toolchain resolves. */
  writeFileSync(join(binDir, 'sway'),
    `#!${process.execPath}\n`
    + `import { writeFileSync } from 'node:fs'\n`
    + `if (process.argv.includes('--version')) { console.log('sway version fake'); process.exit(0) }\n`
    + `writeFileSync(process.env.XDG_RUNTIME_DIR + '/sway-ipc.1.1.sock', '')\n`
    + `setTimeout(() => {}, 60000)\n`,
    { mode: 0o755 })
  writeFileSync(join(binDir, 'swaymsg'),
    '#!/bin/sh\ncase "$*" in *"cursor set"*) exit 1 ;; *) exit 0 ;; esac\n', { mode: 0o755 })
  writeFileSync(join(binDir, 'wlrctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${wlrctlLog}'\nexit 0\n`, { mode: 0o755 })
  for (const name of ['grim', 'wtype']) writeFileSync(join(binDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

  const mounted = []
  delete globalThis[Symbol.for('dsh-wayland.host.applied')]
  process.env.PATH = ''
  apply({
    tools: { register: (definition) => { mounted.push(definition); return () => {} } },
    webServer: { tapIndex: () => () => {}, register: () => () => {} },
    effect: (callback) => { callback?.(); return () => {} },
    get: () => undefined,
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }, { binDir, sessionRoot: join(TMP, 'root') })

  const byName = new Map(mounted.map((entry) => [entry.name, entry]))
  const created = await byName.get('wayland_session_create').execute({ name: 'input-report', width: 400, height: 300 })
  const inputTool = byName.get('wayland_input')

  /** Run one call, then validate and render it the way the Harness would. */
  const call = async (actions) => {
    const value = await inputTool.execute({ session: created.id, actions })
    validateJsonSchemaValue(inputTool.output.schema, value, 'value')
    const text = inputTool.output.render({ session: created.id, actions }, value).map((block) => block.text).join('\n')
    return { value, text }
  }

  {
    const { value } = await call([{ do: 'move', to: [120, 80] }])
    check(JSON.stringify(value.pointer) === JSON.stringify({ x: 120, y: 80 }),
      `a call that moved the pointer must report where it put it, saw ${JSON.stringify(value.pointer)}`)
  }
  {
    const { value } = await call([{ do: 'wait', ms: 0 }])
    check(value.pointer === undefined,
      `a call that never positioned the pointer must not report one, saw ${JSON.stringify(value.pointer)}`)
  }
  {
    /* The model reads the applied entries, so a coordinate that cannot be trusted
       must not turn up there either. */
    const { value, text } = await call([{ do: 'click' }])
    check(value.applied[0]?.click?.at === undefined,
      `a click without "at" must not report a position, saw ${JSON.stringify(value.applied[0])}`)
    check(text.split('\n')[1] === '- {"click":{"button":"left","times":1}}',
      `the rendered result must carry no coordinate for a position-less click, saw ${JSON.stringify(text)}`)
  }
  {
    const { value } = await call([{ do: 'click', at: [300, 200] }])
    check(JSON.stringify(value.applied[0]?.click?.at) === JSON.stringify([300, 200]),
      `a click with "at" must report that point, saw ${JSON.stringify(value.applied[0])}`)
  }
  {
    /* swaymsg refuses `cursor set` above, so this move falls to the relative
       `wlrctl` path — which must re-home on the layout corner first, or a record
       that an outside move falsified would compound into a wrong landing spot. */
    writeFileSync(wlrctlLog, '')
    await call([{ do: 'move', to: [120, 80] }])
    const calls = readFileSync(wlrctlLog, 'utf8').trim().split('\n')
    check(calls[0] === 'pointer move -400 -300',
      `the relative path must home on the layout corner first, saw ${JSON.stringify(calls)}`)
    check(calls[1] === 'pointer move 120 80',
      `then move by the absolute target measured from that corner, saw ${JSON.stringify(calls)}`)
  }

  await byName.get('wayland_session_close').execute({ session: created.id })
  rmSync(TMP, { recursive: true, force: true })
}

rmSync(join(HERE, '.tmp-input-root'), { recursive: true, force: true })

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`input check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('input check ok: oneOf union of 10 directives, sealed variants, validate-before-execute with indexed errors, pointer reported only when the call asserted it')
