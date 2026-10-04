/**
 * Offline check: the plugin's three identities agree and the package is
 * publishable as one npm package.
 *
 * DSH resolves a bundle by package name, serves the browser half through
 * `exports["./client"]`, and requires that half to register the *same* name via
 * `__ModuleLoader__.load({ id })`. Get any of the three wrong and the panel
 * silently fails to mount while the tools still work — so this is checked
 * offline, before a reload.
 */
import { readFileSync, statSync, existsSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** This script's own directory, so nothing here depends on where the repo lives. */
const HERE = dirname(fileURLToPath(import.meta.url))

const ROOT = join(HERE, '..', 'plugin')
const fail = []
const ok = (condition, message) => { if (!condition) fail.push(message) }

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')

/** Strip YAML comments so the example rows in comments cannot satisfy a check. */
const patchBody = patch.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')

const clientId = /__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/.exec(client)?.[1]
const patchName = /^\s*name:\s*'([^']+)'/m.exec(patchBody)?.[1]

/* 1. One identity in three places. */
ok(typeof clientId === 'string', 'client.js: no __ModuleLoader__.load({ id }) found')
ok(typeof patchName === 'string', 'cordis.patch.yml: no insert row name found')
ok(clientId === manifest.name, `client.js registers "${clientId}" but package.json is named "${manifest.name}"`)
ok(patchName === manifest.name, `cordis.patch.yml inserts "${patchName}" but package.json is named "${manifest.name}"`)
ok(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(manifest.name) && manifest.name.length <= 214,
  `package.json name "${manifest.name}" is not a valid npm package name`)

/* 2. Publishable. */
ok(manifest.private !== true, 'package.json still sets private: true')
ok(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version), `version "${manifest.version}" is not publishable semver`)
ok(typeof manifest.license === 'string', 'package.json declares no license')
ok(existsSync(join(ROOT, 'LICENSE')), 'LICENSE file is missing although the package declares a license')

/* 2b. Two copies, one text: the package ships plugin/LICENSE, the repository
   carries the conventional root copy, and they must not drift apart. */
const packageLicense = existsSync(join(ROOT, 'LICENSE')) ? readFileSync(join(ROOT, 'LICENSE'), 'utf8') : ''
const rootLicensePath = join(HERE, '..', 'LICENSE')
const rootLicense = existsSync(rootLicensePath) ? readFileSync(rootLicensePath, 'utf8') : null
ok(rootLicense !== null, 'the repository root has no LICENSE copy')
ok(rootLicense === packageLicense, 'the root LICENSE and plugin/LICENSE differ; keep the two copies identical')
ok(/^Copyright \(c\) \d{4} .+$/m.test(packageLicense), 'LICENSE carries no "Copyright (c) <year> <holder>" line')

/* 3. The declarations DSH reads. */
ok(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at ./cordis.patch.yml')
ok(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"')
ok(manifest.dsh?.client?.immediately === true, 'dsh.client.immediately should be true so the tab type exists at boot')
ok(manifest.exports?.['.'] !== undefined, 'exports["."] is required for the host half')
ok(manifest.exports?.['./client'] !== undefined, 'exports["./client"] is required for the browser half')
ok(manifest.exports?.['./package.json'] !== undefined, 'exports["./package.json"] is required: DSH reads metadata through it')
ok(manifest.exports?.['./locale/*.json'] !== undefined, 'exports["./locale/*.json"] is required: DSH resolves display metadata through it')
for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (key.includes('*')) continue
  ok(existsSync(join(ROOT, target)), `exports["${key}"] points at missing file ${target}`)
}

/* 4. Display metadata: icon within the documented limits, locales parse. */
ok(typeof manifest.icon === 'string', 'package.json declares no icon')
if (typeof manifest.icon === 'string') {
  const icon = join(ROOT, manifest.icon)
  ok(existsSync(icon), `icon ${manifest.icon} is missing`)
  if (existsSync(icon)) {
    const bytes = statSync(icon).size
    ok(bytes <= 256 * 1024, `icon is ${bytes} bytes; DSH accepts at most 256 KiB`)
    ok(/\.(svg|png|jpe?g|webp)$/i.test(manifest.icon), 'icon must be SVG, PNG, JPEG or WebP')
  }
}
const locales = globSync('locale/*.json', { cwd: ROOT })
ok(locales.includes('locale/en.json'), 'locale/en.json is required: it seeds the language map')
for (const file of locales) {
  const parsed = JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
  ok(typeof parsed.meta?.title === 'string' && parsed.meta.title.length > 0, `${file}: meta.title is required`)
  ok(typeof parsed.meta?.description === 'string' && parsed.meta.description.length > 0, `${file}: meta.description is required`)
}

/* 5. `files` actually ships what the package references. */
const shipped = new Set()
for (const entry of manifest.files ?? []) for (const file of globSync(entry, { cwd: ROOT })) shipped.add(file)
ok(shipped.size > 0, 'package.json files matches nothing')
for (const entry of manifest.files ?? []) {
  ok(globSync(entry, { cwd: ROOT }).length > 0, `files entry ${entry} matches nothing`)
}
for (const required of ['host.js', 'pointer.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE', ...locales]) {
  ok(shipped.has(required) || required === 'package.json', `${required} is not shipped by files`)
}

if (fail.length > 0) {
  for (const message of fail) console.log(`FAIL ${message}`)
  console.log(`identity check failed: ${fail.length} problem(s)`)
  process.exit(1)
}
console.log(`identity ok: name=${manifest.name} version=${manifest.version} clientId=${clientId} patch=${patchName} files=${shipped.size}`)
