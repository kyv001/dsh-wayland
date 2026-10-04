/**
 * dsh-wayland — capture overlay.
 *
 * `wayland_screenshot` can burn a labelled coordinate grid into a capture. That
 * needs pixels, so this module decodes the capture, draws the rules and their
 * labels on it, and re-encodes it.
 *
 * The PNG codec is [pngjs](https://github.com/lukeapage/pngjs) — the plugin's
 * only runtime dependency, deliberately confined to this file so `host.js` and
 * `pointer.js` keep using nothing but node built-ins. It replaced ~185 lines of
 * hand-written codec that covered nothing but grim's 8-bit RGB/RGBA output. The
 * measured trade is in [README.md](../README.md).
 *
 * The 5x7 font and the drawing below stay ours: pngjs is a codec, not a canvas.
 *
 * Nothing here knows about sway, sessions or tools: it takes PNG bytes and
 * returns PNG bytes, which is also what makes it checkable on its own.
 *
 * Why a grid at all: a screenshot is a picture of the screen, and the model has
 * to guess where a cell or a button sits inside it. Reading a coordinate off a
 * printed rule is a lookup; estimating one from a scaled-down image is a guess
 * that silently costs a whole round trip when it is wrong. So the labels carry
 * *session* coordinates — the same numbers `wayland_input` takes — and they are
 * drawn after magnification, so the lines stay crisp and stay put.
 */

import { PNG } from 'pngjs'

/* --------------------------------------------------------------- PNG codec */

/**
 * Decode a PNG into straight RGBA bytes.
 *
 * @param png - the complete PNG file.
 * @returns `{ width, height, data }` with 4 bytes per pixel, row-major.
 */
export function decodePng(png) {
  try {
    return PNG.sync.read(png)
  } catch (error) {
    /* pngjs reports a truncated or non-PNG buffer as a stream complaint, which
       names neither the file nor the field; say what the input was meant to be. */
    throw new Error(`not a decodable PNG (${error.message})`, { cause: error })
  }
}

/**
 * Encode straight RGBA bytes as a PNG, with pngjs' default filtering.
 * @param image - `{ width, height, data }` as returned by {@link decodePng}.
 * @returns the complete PNG file.
 */
export function encodePng(image) {
  return PNG.sync.write(image)
}

/* ------------------------------------------------------------ tiny bitmap font */

const GLYPH_W = 5
const GLYPH_H = 7

/** 5x7 digits, one string per row, MSB on the left. */
const GLYPHS = {
  0: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

/** Width in pixels of `text` drawn at `size`. */
const textWidth = (text, size) => text.length * (GLYPH_W + 1) * size - size

/* ----------------------------------------------------------------- drawing */

/** Alpha-blend one solid rectangle into an RGBA buffer, clipped to the image. */
function blendRect(image, x, y, w, h, [r, g, b], alpha) {
  const { width, height, data } = image
  const x0 = Math.max(0, x)
  const y0 = Math.max(0, y)
  const x1 = Math.min(width, x + w)
  const y1 = Math.min(height, y + h)
  if (x1 <= x0 || y1 <= y0) return
  const a = alpha >= 1 ? 1 : alpha
  for (let py = y0; py < y1; py += 1) {
    let o = (py * width + x0) * 4
    for (let px = x0; px < x1; px += 1, o += 4) {
      data[o] = Math.round(data[o] * (1 - a) + r * a)
      data[o + 1] = Math.round(data[o + 1] * (1 - a) + g * a)
      data[o + 2] = Math.round(data[o + 2] * (1 - a) + b * a)
      data[o + 3] = 255
    }
  }
}

/** Draw `text` (digits only) with its top-left corner at `x, y`. */
function drawText(image, x, y, text, size, color, alpha) {
  let cursor = x
  for (const char of text) {
    const glyph = GLYPHS[char]
    if (glyph) {
      for (let row = 0; row < GLYPH_H; row += 1) {
        for (let col = 0; col < GLYPH_W; col += 1) {
          if (glyph[row][col] === '1') blendRect(image, cursor + col * size, y + row * size, size, size, color, alpha)
        }
      }
    }
    cursor += (GLYPH_W + 1) * size
  }
}

/** The colours of the two rules; x and y are distinct so a label's axis is never in doubt. */
const AXIS_COLOR = { x: [255, 45, 149], y: [0, 229, 255] }
const LABEL_COLOR = [0, 0, 0]
const LINE_ALPHA = 0.9
const LABEL_PAD = 1

/** Smallest step accepted: below this the rules would be denser than the content. */
export const MIN_GRID_STEP = 5

/**
 * Burn a labelled coordinate grid into a PNG capture.
 *
 * Lines land on multiples of `step` in *session* pixels, and every line carries
 * that session coordinate as its label — x values along the top edge, y values
 * down the left edge. Because the capture may be magnified, `scale` maps session
 * pixels to image pixels: a line at session x sits at `(x - originX) * scale`.
 * Drawing happens after that magnification, so rules are drawn at their true
 * width instead of being blown up with the picture, and a label stays legible
 * whatever the zoom.
 *
 * @param png - the captured PNG.
 * @param originX - session x of the image's left edge.
 * @param originY - session y of the image's top edge.
 * @param scale - image pixels per session pixel (the `grim -s` factor).
 * @param step - grid pitch in session pixels.
 * @returns the re-encoded PNG plus the image dimensions it actually had.
 */
export function drawGrid(png, { originX, originY, scale, step }) {
  if (!Number.isFinite(step) || step < MIN_GRID_STEP) {
    throw new Error(`grid step must be a number of at least ${MIN_GRID_STEP} session pixels`)
  }
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('grid needs a positive capture scale')
  const image = decodePng(png)
  const { width, height } = image
  /* One rule per step, so an absurd step/scale pair cannot spin here. */
  const spanX = width / scale
  const spanY = height / scale
  if (spanX / step > 4096 || spanY / step > 4096) throw new Error('grid step is too small for this capture')
  const lineWidth = Math.max(1, Math.round(scale))
  const fontSize = Math.max(1, Math.min(4, Math.round(scale)))
  const labelHeight = GLYPH_H * fontSize

  const firstX = Math.ceil(originX / step) * step
  for (let at = firstX; at <= originX + spanX; at += step) {
    const px = Math.round((at - originX) * scale)
    if (px < 0 || px >= width) continue
    blendRect(image, px, 0, lineWidth, height, AXIS_COLOR.x, LINE_ALPHA)
    const text = String(at)
    const chipW = textWidth(text, fontSize) + LABEL_PAD * 2 * fontSize
    const chipH = labelHeight + LABEL_PAD * 2 * fontSize
    /* Right of the rule by default, flipped to its left when the image ends. */
    let lx = px + lineWidth + LABEL_PAD * fontSize
    if (lx + chipW > width) lx = px - lineWidth - LABEL_PAD * fontSize - chipW
    if (lx < 0) lx = 0
    blendRect(image, lx, 0, chipW, chipH, AXIS_COLOR.x, 1)
    drawText(image, lx + LABEL_PAD * fontSize, LABEL_PAD * fontSize, text, fontSize, LABEL_COLOR, 1)
  }

  const firstY = Math.ceil(originY / step) * step
  for (let at = firstY; at <= originY + spanY; at += step) {
    const py = Math.round((at - originY) * scale)
    if (py < 0 || py >= height) continue
    blendRect(image, 0, py, width, lineWidth, AXIS_COLOR.y, LINE_ALPHA)
    const text = String(at)
    const chipW = textWidth(text, fontSize) + LABEL_PAD * 2 * fontSize
    const chipH = labelHeight + LABEL_PAD * 2 * fontSize
    let ly = py + lineWidth + LABEL_PAD * fontSize
    if (ly + chipH > height) ly = py - lineWidth - LABEL_PAD * fontSize - chipH
    if (ly < 0) ly = 0
    /* Offset from the left edge so the two axes' labels do not sit on top of
       each other where the rules cross near the origin. */
    const lx = Math.min(width - chipW, LABEL_PAD * fontSize)
    blendRect(image, lx, ly, chipW, chipH, AXIS_COLOR.y, 1)
    drawText(image, lx + LABEL_PAD * fontSize, ly + LABEL_PAD * fontSize, text, fontSize, LABEL_COLOR, 1)
  }

  return { data: encodePng(image), width, height }
}
