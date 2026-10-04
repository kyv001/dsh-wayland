/**
 * Render this plugin's model-facing tool definitions to Markdown, so a human can
 * read exactly what a fresh model is shown (names, descriptions, parameters).
 */
import { writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../plugin/host.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const tools = []
apply({
  tools: { register: (definition) => { tools.push(definition); return () => {} } },
  webServer: { tapIndex: () => () => {}, register: () => () => {} },
  effect: (callback) => { callback?.(); return () => {} },
  get: () => undefined,
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
}, { binDir: '', sessionRoot: join(HERE, '.tmp-render') })

const lines = []
lines.push('# Model-facing tool definitions')
lines.push('')
lines.push('This is the exact text the model reads for this plugin\'s tools (rendered from')
lines.push('the live definitions, not hand-copied). Descriptions carry the purpose, when to')
lines.push('use the tool, and what it returns; defaults, units and id provenance live on the')
lines.push('parameters they belong to.')
lines.push('')
lines.push(`${tools.length} tools, ${tools.reduce((sum, t) => sum + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0)} characters of schema in total.`)
lines.push('')

const typeOf = (node) => {
  if (!node) return '?'
  if (node.oneOf) return 'object'
  if (Array.isArray(node.type)) return node.type.join(' | ')
  if (node.enum) return `enum(${node.enum.join(', ')})`
  if (node.type === 'array') return `array of ${typeOf(node.items)}`
  return node.type ?? '?'
}

for (const tool of tools) {
  lines.push(`## \`${tool.name}\``)
  lines.push('')
  lines.push(tool.description)
  lines.push('')
  const properties = tool.parameters?.properties ?? {}
  const required = new Set(tool.parameters?.required ?? [])
  if (Object.keys(properties).length === 0) {
    lines.push('*No parameters.*')
    lines.push('')
    continue
  }
  lines.push('| parameter | type | required | description |')
  lines.push('|---|---|---|---|')
  /** A sealed `oneOf` variant, e.g. one `wayland_input` directive. */
  const variant = (prefix, node) => {
    const name = node.properties?.do?.enum?.[0] ?? '?'
    const nested = new Set(node.required ?? [])
    lines.push('')
    lines.push(`#### \`${prefix}\` — \`do: "${name}"\``)
    lines.push('')
    lines.push('| field | type | required | description |')
    lines.push('|---|---|---|---|')
    for (const [childName, child] of Object.entries(node.properties ?? {})) {
      lines.push(`| \`${childName}\` | ${typeOf(child)} | ${nested.has(childName) ? 'yes' : 'no'} | ${(child.description ?? '').replace(/\|/g, '\\|')} |`)
    }
    lines.push('')
  }
  const row = (name, node, prefix) => {
    const description = node.description ?? ''
    lines.push(`| \`${prefix}${name}\` | ${typeOf(node)} | ${required.has(name) ? 'yes' : 'no'} | ${description.replace(/\|/g, '\\|')} |`)
    if (node.type === 'array' && node.items?.properties) {
      const nestedRequired = new Set(node.items.required ?? [])
      for (const [childName, child] of Object.entries(node.items.properties)) {
        lines.push(`| \`${prefix}${name}[].${childName}\` | ${typeOf(child)} | ${nestedRequired.has(childName) ? 'yes' : 'no'} | ${(child.description ?? '').replace(/\|/g, '\\|')} |`)
      }
    }
    /* A plain object parameter (a capture region) is a table of its own fields,
       so the document shows every property the model is actually given. */
    if (node.type === 'object' && node.properties) {
      const nestedRequired = new Set(node.required ?? [])
      for (const [childName, child] of Object.entries(node.properties)) {
        lines.push(`| \`${prefix}${name}.${childName}\` | ${typeOf(child)} | ${nestedRequired.has(childName) ? 'yes' : 'no'} | ${(child.description ?? '').replace(/\|/g, '\\|')} |`)
      }
    }
    /* A union of sealed variants is rendered as one table per variant, so the
       document shows the same union the model's schema does. */
    if (node.type === 'array' && Array.isArray(node.items?.oneOf)) {
      lines.push('')
      lines.push(`Each \`${prefix}${name}[]\` entry is exactly one of these directives:`)
      for (const one of node.items.oneOf) variant(`${prefix}${name}[]`, one)
    }
  }
  for (const [name, node] of Object.entries(properties)) row(name, node, '')
  lines.push('')
}

rmSync(join(HERE, '.tmp-render'), { recursive: true, force: true })
await writeFile(join(HERE, '..', 'docs', 'tool-definitions.md'), `${lines.join('\n')}\n`)
console.log(`wrote docs/tool-definitions.md (${tools.length} tools)`)
