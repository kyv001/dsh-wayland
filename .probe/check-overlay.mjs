/**
 * Offline check for `plugin/overlay.js` — the PNG codec and the coordinate grid
 * that `wayland_screenshot` burns into a capture.
 *
 * The fixtures are real PNG bytes embedded as base64, so the decoder is tested
 * against every PNG filter type — and against the palette, interlaced and
 * 16-bit inputs only pngjs accepts — without needing a toolchain on the host.
 * The expected pixels are recomputed here from the same formula the fixtures
 * were built from, which keeps the check independent of the encoder under test.
 *
 * Run: node .probe/check-overlay.mjs
 */
import { drawGrid, decodePng, encodePng, MIN_GRID_STEP } from '../plugin/overlay.js'

const W = 6
const H = 5
const pixel = (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 61) % 256, (x * 97 + y * 3) % 256]

/**
 * `[name, colourType, base64]`. The first seven cover the five PNG filter types
 * plus mixed RGB and RGBA; the last three are formats the hand-written codec
 * this replaced rejected outright (palette, interlaced, 16-bit). Each one is a
 * lossless encoding of `pixel(x, y)`, so a single oracle covers them all; the
 * last three were generated once with ImageMagick/Pillow and embedded here so
 * that running this stays toolchain-free.
 */
const FIXTURES = [
  ['filter0', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAADpOgqxAAAAaklEQVR42gFfAKD/AAAAACUFYUoKwm8PI5QUhLkZ5QALPQMwQmRVR8V6TCafUYfEVugAFnoGO39nYITIhYkpqo6Kz5PrACG3CUa8amvBy5DGLLXLjdrQ7gAs9AxR+W12/s6bAy/ACJDlDfFgyyhO3OE5fAAAAABJRU5ErkJggg=='],
  ['filter1', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAADpOgqxAAAAJklEQVR42mNkYGBQZU1ERozctszoQmJVbOhCits50YV0vvCgCQEA1fAQh5L4uNgAAAAASUVORK5CYII='],
  ['filter2', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAADpOgqxAAAAI0lEQVR42mNiYGBQZU304jqUz688RaRlp+RTJm5bZjREthAAtv0MOHE96yUAAAAASUVORK5CYII='],
  ['filter3', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAADpOgqxAAAAOklEQVR42mNmYGBQZU204JjkxXUolrc4n38xM7cts4SiERhtgjCYBWNY0YXEqtjQhWRmciCEFhoBEQA9mRHtvP6ShAAAAABJRU5ErkJggg=='],
  ['filter4', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAADpOgqxAAAAGklEQVR42mNhYGBQZU1ERizctszcrCiIbCEAVAIFdN53p8wAAAAASUVORK5CYII='],
  ['rgb-mixed', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAADpOgqxAAAAOElEQVR42mNgYGBQZU304jqUz688RaRlp+RTRm5bZqAQMmICCqEhZrEqNglFIzDaBGGwgGRYURAAJUQNy/i4iS8AAAAASUVORK5CYII='],
  ['rgba-paeth', 6, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAYAAABmWJ3mAAAAHUlEQVR42mNhYGD4r8qayICOWbhtmRm4WTExFSUAOs8Gc5oRbvwAAAAASUVORK5CYII='],
  ['palette', 3, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAMAAABRhm3UAAAAWlBMVEXa0O61y412/s5rwcuQxixR+W0s9AxGvGohtwnPk+uqjoqFiSnEVuhghMg7f2cWegafUYd6TCa5GeWUFIRvDyPlDfHACJCbAy9VR8UwQmQLPQNKCsIlBWEAAAAt/LqzAAAAK0lEQVR4nGOQlZEWERZikJKUEBTgYeDn4+Xm4mTgYGdmYWRgYGNlEhcTBQAkNAG0arrUhgAAAABJRU5ErkJggg=='],
  ['interlaced', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAIAAAGePTonAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAABQSURBVAjXY2BgYGCYItLCoPOF5wDHBAYvrkNMOl94GMWq2Ly4DnlxHWJQZU3M51feKfmURayKTYyLTYyLDcFi5LZlVmVNREYsYlVsYqwoCABABxGpyC+SvgAAAABJRU5ErkJggg=='],
  ['16-bit', 2, 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFEAIAAAC5qtbyAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAmSURBVAjXY2RgYGBgYFBVZWVNTMRFsnBz29oyM3Nzs7LiJumsCAAg9grQtZHLYwAAAABJRU5ErkJggg=='],
]

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) return
  failures += 1
  console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

/* ---------------------------------------------------------- PNG decode */

for (const [name, colorType, b64] of FIXTURES) {
  const image = (() => {
    try {
      return decodePng(Buffer.from(b64, 'base64'))
    } catch (error) {
      check(`${name}: decodes`, false, error.message)
      return null
    }
  })()
  if (!image) continue
  check(`${name}: dimensions`, image.width === W && image.height === H, `${image.width}x${image.height}`)
  let mismatched = 0
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4
      const [r, g, b] = pixel(x, y)
      if (image.data[o] !== r || image.data[o + 1] !== g || image.data[o + 2] !== b) mismatched += 1
      /* RGB fixtures have no alpha channel; RGBA carries the opaque value. */
      if (image.data[o + 3] !== 255) mismatched += 1
    }
  }
  check(`${name}: pixels (colourType ${colorType})`, mismatched === 0, `${mismatched} mismatched bytes`)
}

/* --------------------------------------------------------- PNG round trip */

{
  const source = { width: 9, height: 7, data: Buffer.alloc(9 * 7 * 4) }
  for (let i = 0; i < 9 * 7; i += 1) {
    source.data[i * 4] = (i * 7) % 256
    source.data[i * 4 + 1] = (i * 13) % 256
    source.data[i * 4 + 2] = (i * 29) % 256
    source.data[i * 4 + 3] = 255
  }
  const again = decodePng(encodePng(source))
  check('round trip: dimensions', again.width === source.width && again.height === source.height)
  check('round trip: bytes identical', again.data.equals(source.data))
}

/* ------------------------------------------------------------ bad input */

/* A capture that is not a PNG must fail, and the message must still say what
   the input was meant to be: pngjs' own text talks about a stream instead. */
for (const [label, bytes] of [
  ['an empty buffer', Buffer.alloc(0)],
  ['a file that is not a PNG', Buffer.from('this is not a png at all')],
  ['a truncated PNG', Buffer.from('iVBORw0KGgoAAAANSUhEUg==', 'base64')],
]) {
  let message = null
  try {
    decodePng(bytes)
  } catch (error) {
    message = error.message
  }
  check(`decode: rejects ${label}`, typeof message === 'string' && message.includes('PNG'), message ?? 'no error thrown')
}

/* -------------------------------------------------------- grid placement */

/** A uniform grey capture: neither the black label digits nor the rules blend into it. */
const BACKGROUND = [128, 128, 128]

/** A uniform PNG of the given size, as the capture grim would hand us. */
const blank = (width, height) => {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = BACKGROUND[0]
    data[i + 1] = BACKGROUND[1]
    data[i + 2] = BACKGROUND[2]
    data[i + 3] = 255
  }
  return encodePng({ width, height, data })
}

const at = (image, x, y) => {
  const o = (y * image.width + x) * 4
  return [image.data[o], image.data[o + 1], image.data[o + 2]]
}
/** Anything that is not the flat background: a rule, a label chip or a digit. */
const marked = (image, x, y) => at(image, x, y).some((v, i) => v !== BACKGROUND[i])
/** Marked indices collapsed to the start of each run, so one rule counts once. */
const ruleStarts = (indices) => indices.filter((value, i) => i === 0 || value !== indices[i - 1] + 1)
const scanRow = (image, y) => ruleStarts([...Array(image.width).keys()].filter((x) => marked(image, x, y)))
const scanColumn = (image, x) => ruleStarts([...Array(image.height).keys()].filter((y) => marked(image, x, y)))

{
  /* origin (300,250), 200x120 area, step 50 -> x rules at 300/350/400/450
     (500 is the right edge, outside) and y rules at 250/300/350. */
  const out = drawGrid(blank(200, 120), { originX: 300, originY: 250, scale: 1, step: 50 })
  const image = decodePng(out.data)
  check('grid: dimensions preserved', out.width === 200 && out.height === 120 && image.width === 200)

  /* Scanned clear of every label chip: the chips sit at the top and left edges. */
  const columns = scanRow(image, 30)
  check('grid: x rules land on session multiples', JSON.stringify(columns) === '[0,50,100,150]', JSON.stringify(columns))
  const rows = scanColumn(image, 180)
  check('grid: y rules land on session multiples', JSON.stringify(rows) === '[0,50,100]', JSON.stringify(rows))

  /* Hue, not exact RGB: the rule must be visible and belong to the right axis. */
  const xRule = at(image, 0, 30)
  const yRule = at(image, 180, 0)
  check('grid: x rule is the warm rule', xRule[0] > xRule[1] && xRule[2] > xRule[1], xRule.join(','))
  check('grid: y rule is the cool rule', yRule[2] > yRule[1] && yRule[1] > yRule[0], yRule.join(','))

  /* Every rule carries its session coordinate as a chip of black digits. */
  let digits = 0
  for (let y = 0; y < 12; y += 1) for (let x = 0; x < 40; x += 1) if (at(image, x, y).every((v) => v === 0)) digits += 1
  check('grid: x label digits drawn', digits > 5, `${digits} black pixels near the top`)
}

{
  /* Magnified capture: rules are drawn after scaling, so a rule maps to
     (x - origin) * scale and stays one rule — wider, not duplicated. */
  const out = drawGrid(blank(400, 200), { originX: 100, originY: 100, scale: 2, step: 50 })
  const image = decodePng(out.data)
  const columns = scanRow(image, 150)
  check('grid: scale 2 maps each session rule once', JSON.stringify(columns) === '[0,100,200,300]', JSON.stringify(columns))
  const rows = scanColumn(image, 380)
  check('grid: scale 2 rows', JSON.stringify(rows) === '[0,100]', JSON.stringify(rows))
}

/* ------------------------------------------------------------ rejection */

for (const [label, options] of [
  ['step below the floor', { originX: 0, originY: 0, scale: 1, step: MIN_GRID_STEP - 1 }],
  ['non-numeric step', { originX: 0, originY: 0, scale: 1, step: Number.NaN }],
  ['zero scale', { originX: 0, originY: 0, scale: 0, step: 50 }],
]) {
  let threw = false
  try {
    drawGrid(blank(40, 40), options)
  } catch {
    threw = true
  }
  check(`grid: rejects ${label}`, threw)
}

console.log(failures === 0 ? 'overlay ok' : `overlay FAILURES=${failures}`)
process.exit(failures === 0 ? 0 : 1)
