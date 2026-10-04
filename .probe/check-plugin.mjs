/** Offline check: build the plugin's tool definitions against a stub context. */
import { dshToolsPath } from './dsh-tools.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** This script's own directory, so nothing here depends on where the repo lives. */
const HERE = dirname(fileURLToPath(import.meta.url))

const PLUGIN = join(HERE, '..', 'plugin', 'host.js')

const { assertSupportedJsonSchema } = await import(dshToolsPath())
const { apply } = await import(PLUGIN)
const { rmSync } = await import('node:fs')

const captured = []
const disposers = []
const ctx = {
  tools: { register: (definition) => { captured.push(definition); return () => {} } },
  webServer: {
    tapIndex: () => () => {},
    register: () => () => {},
  },
  effect: (callback) => { const disposer = callback?.(); if (typeof disposer === 'function') disposers.push(disposer); return () => {} },
  get: () => undefined,
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
}

/* No toolchain and an isolated session root: schema validation must not need
   any binary on the host, so this check runs anywhere. */
const TMP = join(HERE, '.tmp-check')
apply(ctx, { binDir: '', sessionRoot: TMP })

let failures = 0
for (const definition of captured) {
  for (const [label, schema] of [['parameters', definition.parameters], ['output', definition.output?.schema]]) {
    try {
      assertSupportedJsonSchema(schema)
    } catch (error) {
      failures += 1
      console.log(`FAIL ${definition.name}.${label}: ${error.message}`)
    }
  }
  if (typeof definition.execute !== 'function') { failures += 1; console.log(`FAIL ${definition.name}: no execute`) }
  if (typeof definition.output?.render !== 'function') { failures += 1; console.log(`FAIL ${definition.name}: no output.render`) }
}
rmSync(TMP, { recursive: true, force: true })
console.log(`tools=${captured.length} (${captured.map((d) => d.name).join(', ')}) failures=${failures}`)
