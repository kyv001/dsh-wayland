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
 *
 * Run: node .probe/check-input.mjs
 */
import { dshToolsPath } from './dsh-tools.mjs'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'plugin', 'host.js')

/* The schema must also pass the real Harness validator, not just look right. */
const { assertSupportedJsonSchema } = await import(dshToolsPath())
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
check(/validated before/.test(tool.description), 'the description must state that validation happens before anything is sent')
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

rmSync(join(HERE, '.tmp-input-root'), { recursive: true, force: true })

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`input check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('input check ok: oneOf union of 10 directives, sealed variants, validate-before-execute with indexed errors')
