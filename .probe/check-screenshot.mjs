/**
 * End-to-end check for `wayland_screenshot`'s `region`, `grid` and `scale`.
 *
 * Everything else in `.probe/` is offline. This one is not: it mounts the real
 * Host half on a stub context, opens a real sway session, captures with real
 * grim, and then reads the PNG back to prove the grid is on the pixels and that
 * the geometry the tool reports matches the image it returned. That is the part
 * a unit test cannot show — the coordinate a label prints has to be the
 * coordinate `wayland_input` takes.
 *
 * Where the toolchain is absent it reports a skip and exits 0, because needing a
 * compositor is exactly what this check is for and not a reason for a red build.
 *
 * Run: node .probe/check-screenshot.mjs
 */
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../plugin/host.js'
import { decodePng } from '../plugin/overlay.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SESSION_ROOT = join(HERE, '.tmp-screenshot')

const tools = new Map()
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  webServer: { tapIndex: () => () => {}, register: () => () => {} },
  effect: (callback) => { callback?.(); return () => {} },
  get: () => undefined,
  on: () => () => {},
  logger: { info() {}, warn() {}, error() {} },
}

/* JPEG for plain screenshots, so the check can prove a grid capture overrides
   the deployment format rather than silently inheriting it. */
apply(ctx, { sessionRoot: SESSION_ROOT, screenshotMediaType: 'image/jpeg' })

const shot = tools.get('wayland_screenshot')
if (!shot) {
  console.log('FAIL wayland_screenshot is not registered')
  process.exit(1)
}

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`ok   ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

const refused = async (label, args) => {
  let threw = false
  try {
    await shot.execute(args)
  } catch {
    threw = true
  }
  check(label, threw)
}

const pixelAt = (image, x, y) => {
  const o = (y * image.width + x) * 4
  return [image.data[o], image.data[o + 1], image.data[o + 2]]
}
/**
 * Dimensions from a JPEG's SOF marker. Plain screenshots keep the deployment
 * format, so a region capture has to be measured rather than assumed — this is
 * what proves grim honoured the rectangle instead of returning the whole output.
 */
function jpegSize(buffer) {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  throw new Error('no SOF marker in JPEG')
}
/** Rule families, told apart by hue so a background of any colour still works. */
const isWarmRule = ([r, g]) => r > g + 60
const isCoolRule = ([r, g, b]) => b > r + 60 && g > r + 60
/** Marked columns collapsed to the start of each run: one rule counts once. */
const ruleStarts = (columns) => columns.filter((value, i) => i === 0 || value !== columns[i - 1] + 1)

let session = null
try {
  session = (await tools.get('wayland_session_create').execute({ name: 'screenshot probe', width: 480, height: 320 })).id
} catch (error) {
  /* A missing compositor is the one thing this check cannot work around, and it
     is a property of the host, not a defect in the plugin. */
  console.log(`skipped: no wayland session (${error.message})`)
  await rm(SESSION_ROOT, { recursive: true, force: true })
  process.exit(0)
}

try {
  /* ---------------------------------------------------- plain capture */
  const plain = await shot.execute({ session })
  check('plain: reports the whole output', plain.width === 480 && plain.height === 320, `${plain.width}x${plain.height}`)
  check('plain: origin is the screen corner', JSON.stringify(plain.origin) === '[0,0]', JSON.stringify(plain.origin))
  check('plain: scale is 1', plain.scale === 1, String(plain.scale))
  check('plain: keeps the deployment format', plain.mediaType === 'image/jpeg', plain.mediaType)
  const plainBytes = await readFile(plain.path)
  check('plain: really is a JPEG', plainBytes[0] === 0xff && plainBytes[1] === 0xd8)
  check('plain: no grid field', plain.grid === undefined)

  /* -------------------------------------------------------- a region */
  const region = { x: 20, y: 30, width: 200, height: 120 }
  const cut = await shot.execute({ session, region })
  check('region: echoes the area', cut.width === 200 && cut.height === 120, `${cut.width}x${cut.height}`)
  check('region: origin is the region corner', JSON.stringify(cut.origin) === '[20,30]', JSON.stringify(cut.origin))
  const cutBytes = await readFile(cut.path)
  const cutSize = jpegSize(cutBytes)
  check('region: grim honoured the rectangle', cutSize.width === 200 && cutSize.height === 120, `${cutSize.width}x${cutSize.height}`)

  /* ------------------------------------------- a region with a grid */
  const gridded = await shot.execute({ session, region: { x: 0, y: 0, width: 200, height: 120 }, grid: 50 })
  check('grid: forces PNG over the deployment format', gridded.mediaType === 'image/png', gridded.mediaType)
  check('grid: echoes the step', gridded.grid === 50, String(gridded.grid))
  check('grid: keeps the region geometry', gridded.width === 200 && gridded.height === 120, `${gridded.width}x${gridded.height}`)
  const gridImage = decodePng(await readFile(gridded.path))
  const columns = []
  for (let x = 0; x < gridImage.width; x += 1) if (isWarmRule(pixelAt(gridImage, x, 90))) columns.push(x)
  check('grid: x rules sit on session multiples', JSON.stringify(ruleStarts(columns)) === '[0,50,100,150]', JSON.stringify(ruleStarts(columns)))
  const rows = []
  for (let y = 0; y < gridImage.height; y += 1) if (isCoolRule(pixelAt(gridImage, 190, y))) rows.push(y)
  check('grid: y rules sit on session multiples', JSON.stringify(ruleStarts(rows)) === '[0,50,100]', JSON.stringify(ruleStarts(rows)))
  let digits = 0
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 60; x += 1) if (pixelAt(gridImage, x, y).every((v) => v === 0)) digits += 1
  check('grid: labels are printed', digits > 5, `${digits} label pixels`)

  /* ----------------------------------- a grid at an offset origin, zoomed */
  const zoomed = await shot.execute({ session, region: { x: 37, y: 11, width: 120, height: 80 }, grid: 50, scale: 2 })
  check('zoom: reports the scale', zoomed.scale === 2, String(zoomed.scale))
  const zoomImage = decodePng(await readFile(zoomed.path))
  check('zoom: the image is the region doubled', zoomImage.width === 240 && zoomImage.height === 160, `${zoomImage.width}x${zoomImage.height}`)
  const zoomColumns = []
  for (let x = 0; x < zoomImage.width; x += 1) if (isWarmRule(pixelAt(zoomImage, x, 140))) zoomColumns.push(x)
  /* Session x = 37 + image x / 2, so the rules on 50 and 100 land at image 26 and 126. */
  check('zoom: rules follow the offset origin', JSON.stringify(ruleStarts(zoomColumns)) === '[26,126,226]', JSON.stringify(ruleStarts(zoomColumns)))

  /* -------------------------------------------- regions off the screen edge */
  const spilled = await shot.execute({ session, region: { x: 400, y: 280, width: 500, height: 500 } })
  check('overflow: clipped, not refused', spilled.width === 80 && spilled.height === 40, `${spilled.width}x${spilled.height}`)
  check('overflow: origin stays where it was asked for', JSON.stringify(spilled.origin) === '[400,280]', JSON.stringify(spilled.origin))

  const negative = await shot.execute({ session, region: { x: -50, y: -50, width: 100, height: 100 } })
  check('overflow: negative origin clamps to the screen', JSON.stringify(negative.origin) === '[0,0]', JSON.stringify(negative.origin))

  /* ------------------------------------------- a region overrides a window */
  let windowId = null
  try {
    await tools.get('wayland_launch').execute({ session, command: 'foot', waitMs: 10000 })
    windowId = (await tools.get('wayland_windows').execute({ session })).windows[0]?.id ?? null
  } catch {
    /* foot is an optional dependency; the override is simply not exercised here. */
  }

  if (windowId === null) {
    console.log('note: no window available, skipping the region-over-window assertions')
  } else {
    const over = await shot.execute({ session, window: windowId, region: { x: 5, y: 6, width: 60, height: 40 } })
    check('override: the region wins', over.width === 60 && over.height === 40 && JSON.stringify(over.origin) === '[5,6]', `${over.width}x${over.height} at ${over.origin}`)
    check('override: no window is claimed', over.window === undefined, JSON.stringify(over.window))

    const byWindow = await shot.execute({ session, window: windowId })
    check('window: a window capture still reports its rect', byWindow.window?.id === windowId && byWindow.width > 0, JSON.stringify(byWindow.window))
  }

  /* ------------------------------------------------------------ refusals */
  await refused('refuses a grid below the floor', { session, grid: 1 })
  await refused('refuses a non-numeric grid', { session, grid: 'wide' })
  await refused('refuses a region without numbers', { session, region: { x: 0, y: 0 } })
  await refused('refuses a window id that is not mapped', { session, window: 999999 })
} finally {
  await tools.get('wayland_session_close').execute({ session }).catch(() => {})
  await rm(SESSION_ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? 'screenshot ok' : `screenshot FAILURES=${failures}`)
process.exit(failures === 0 ? 0 : 1)
