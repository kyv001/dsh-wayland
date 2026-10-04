/**
 * Offline check for plugin/pointer.js — the persistent virtual pointer.
 *
 * A fake compositor on a unix socket answers the handshake (registry globals,
 * sync callbacks) and records every request the client sends, so the protocol
 * this plugin speaks by hand can be asserted without sway, wlrctl or a screen:
 *
 *   - the handshake binds zwlr_virtual_pointer_manager_v1 + wl_seat and creates
 *     exactly one virtual pointer, which then stays alive (no per-action device)
 *   - move() sends motion_absolute carrying literal pixels, not a delta
 *   - click() sends press then release of the right linux button code
 *   - scroll() sends wheel axis events
 *   - destroy() retires the device and closes the connection
 *   - a compositor without the interface fails loudly instead of silently
 *
 * Run: node .probe/check-pointer.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { join } from 'node:path'

const HERE = new URL('.', import.meta.url).pathname
const { openVirtualPointer, probeVirtualPointer } = await import(`file://${join(HERE, '..', 'plugin', 'pointer.js')}`)

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

const DISPLAY = 1
const OP = { motionAbsolute: 1, button: 2, axis: 3, frame: 4, axisSource: 5, axisStop: 6, destroy: 8 }

const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }

function wlString(value) {
  const data = Buffer.from(`${value}\0`, 'utf8')
  return Buffer.concat([u32(data.length), data, Buffer.alloc((4 - (data.length % 4)) % 4)])
}

function readString(payload, offset) {
  const length = payload.readUInt32LE(offset)
  const value = payload.toString('utf8', offset + 4, offset + 4 + length - 1)
  return [value, offset + 4 + length + ((4 - (length % 4)) % 4)]
}

function encode(objectId, opcode, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(objectId >>> 0, 0)
  header.writeUInt32LE((((8 + payload.length) << 16) >>> 0 | opcode) >>> 0, 4)
  return Buffer.concat([header, payload])
}

/** Split a stream into complete wayland messages; returns [messages, rest]. */
function decode(buffer) {
  const out = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset + 4) >>> 16
    if (size < 8 || offset + size > buffer.length) break
    out.push({
      objectId: buffer.readUInt32LE(offset),
      opcode: buffer.readUInt32LE(offset + 4) & 0xffff,
      payload: buffer.subarray(offset + 8, offset + size),
    })
    offset += size
  }
  return [out, buffer.subarray(offset)]
}

/**
 * A compositor that only knows how to say hello. `withVirtualPointer: false`
 * models a compositor that lacks the protocol this plugin wants.
 */
function fakeCompositor({ withVirtualPointer = true } = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'dsh-wayland-pointer-'))
  const socketPath = join(dir, 'wayland-1')
  const state = { requests: [], binds: [], created: [], registryId: 0, managerId: 0, closed: false }
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      const [messages, rest] = decode(Buffer.concat([pending, chunk]))
      pending = rest
      const replies = []
      for (const message of messages) {
        state.requests.push(message)
        if (message.objectId === DISPLAY && message.opcode === 1) {
          state.registryId = message.payload.readUInt32LE(0)
          replies.push(encode(state.registryId, 0, Buffer.concat([u32(1), wlString('wl_seat'), u32(9)])))
          if (withVirtualPointer) {
            replies.push(encode(state.registryId, 0, Buffer.concat([u32(2), wlString('zwlr_virtual_pointer_manager_v1'), u32(2)])))
          }
        } else if (message.objectId === state.registryId && message.opcode === 0) {
          const name = message.payload.readUInt32LE(0)
          const [iface, after] = readString(message.payload, 4)
          const bind = { name, iface, version: message.payload.readUInt32LE(after), id: message.payload.readUInt32LE(message.payload.length - 4) }
          state.binds.push(bind)
          if (iface === 'zwlr_virtual_pointer_manager_v1') state.managerId = bind.id
        } else if (message.objectId === DISPLAY && message.opcode === 0) {
          replies.push(encode(message.payload.readUInt32LE(0), 0, u32(1)))
        } else if (message.objectId === state.managerId && message.opcode === 0) {
          state.created.push({ seat: message.payload.readUInt32LE(0), id: message.payload.readUInt32LE(4) })
        }
      }
      if (replies.length) socket.write(Buffer.concat(replies))
    })
    socket.on('close', () => { state.closed = true })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({ dir, socketPath, server, state }))
  })
}

const cleanup = (fake) => {
  fake.server.close()
  rmSync(fake.dir, { recursive: true, force: true })
}

/* ------------------------------------------------------------- happy path */
{
  const fake = await fakeCompositor()
  const pointer = await openVirtualPointer({ socketPath: fake.socketPath, width: 1280, height: 800 })
  const { state } = fake
  const bound = state.binds.map((bind) => bind.iface)
  check(bound.includes('zwlr_virtual_pointer_manager_v1'), `handshake never bound the manager (bound: ${bound})`)
  check(bound.includes('wl_seat'), `handshake never bound a seat (bound: ${bound})`)
  check(state.created.length === 1, `expected exactly one create_virtual_pointer, saw ${state.created.length}`)
  const pointerId = state.created[0]?.id
  check(state.created[0]?.seat === state.binds.find((b) => b.iface === 'wl_seat')?.id,
    'create_virtual_pointer must pass the bound seat')

  /** Requests sent to the pointer object since `mark`. */
  const since = (mark) => state.requests.slice(mark).filter((r) => r.objectId === pointerId)

  let mark = state.requests.length
  await pointer.move(320, 200)
  const move = since(mark)
  check(move[0]?.opcode === OP.motionAbsolute, `move() should send motion_absolute first, saw opcode ${move[0]?.opcode}`)
  const args = move[0] ? [0, 4, 8, 12, 16].map((o) => move[0].payload.readUInt32LE(o)) : []
  check(args[1] === 320 && args[2] === 200, `motion_absolute must carry literal pixels, saw ${args.slice(1, 3)}`)
  check(args[3] === 1280 && args[4] === 800, `motion_absolute must carry the session extent, saw ${args.slice(3, 5)}`)
  check(move[1]?.opcode === OP.frame, 'move() must frame the motion')

  mark = state.requests.length
  await pointer.click('left')
  const click = since(mark)
  const buttons = click.filter((r) => r.opcode === OP.button)
    .map((r) => ({ code: r.payload.readUInt32LE(4), state: r.payload.readUInt32LE(8) }))
  check(buttons.length === 2 && buttons[0].state === 1 && buttons[1].state === 0,
    `click() must send press then release, saw ${JSON.stringify(buttons)}`)
  check(buttons.every((button) => button.code === 272), `left must be BTN_LEFT (272), saw ${JSON.stringify(buttons)}`)
  check(click.filter((r) => r.opcode === OP.frame).length === 2, 'each button event must be framed')

  /* press/release are what long-press and drag are built from, so they must be
     separable and must reuse the same device. */
  mark = state.requests.length
  await pointer.press('right')
  const held = since(mark).filter((r) => r.opcode === OP.button)
  check(held.length === 1 && held[0].payload.readUInt32LE(8) === 1 && held[0].payload.readUInt32LE(4) === 273,
    `press('right') must send one button-down for BTN_RIGHT (273), saw ${JSON.stringify(held.map((r) => [r.payload.readUInt32LE(4), r.payload.readUInt32LE(8)]))}`)
  mark = state.requests.length
  await pointer.release('right')
  const freed = since(mark).filter((r) => r.opcode === OP.button)
  check(freed.length === 1 && freed[0].payload.readUInt32LE(8) === 0 && freed[0].payload.readUInt32LE(4) === 273,
    'release(\'right\') must send exactly one button-up for the same button')
  check(state.created.length === 1, 'press/release must reuse the one persistent pointer, not create another device')

  mark = state.requests.length
  await pointer.scroll(0, 2)
  const scroll = since(mark)
  const axes = scroll.filter((r) => r.opcode === OP.axis)
  check(axes.length === 2, `scroll(0, 2) should send two axis events, saw ${axes.length}`)
  check(axes.every((r) => r.payload.readUInt32LE(4) === 0), 'a vertical scroll must use axis 0')
  check(scroll.some((r) => r.opcode === OP.axisSource), 'a wheel scroll should announce its axis source')

  mark = state.requests.length
  await pointer.destroy()
  check(since(mark).filter((r) => r.opcode === OP.destroy).length === 1, 'destroy() must retire the virtual pointer object')
  cleanup(fake)
}

/* ------------------------------------- compositor without the interface */
{
  const fake = await fakeCompositor({ withVirtualPointer: false })
  const error = await openVirtualPointer({ socketPath: fake.socketPath, width: 640, height: 480 }).then(() => null, (e) => e)
  check(error instanceof Error, 'a compositor without the interface must reject, not hang')
  check(/virtual_pointer/.test(String(error?.message)), `the rejection should name the missing interface, saw ${error?.message}`)
  cleanup(fake)
}

/* ------------------------------------- the read-only capability probe */
{
  /* A health check must be able to ask "is the protocol here?" without creating
     an ephemeral pointer — an ephemeral device is what breaks button delivery. */
  const fake = await fakeCompositor()
  const verdict = await probeVirtualPointer({ socketPath: fake.socketPath, timeoutMs: 2000 })
  check(verdict?.available === true, `probe must report the interface as available, saw ${JSON.stringify(verdict)}`)
  check(verdict?.interfaceVersion === 2, `probe must report the interface version, saw ${JSON.stringify(verdict)}`)
  check(fake.state.created.length === 0, 'probe must not create a virtual pointer device')
  check(fake.state.binds.length === 0, 'probe must bind nothing')
  cleanup(fake)
}
{
  const fake = await fakeCompositor({ withVirtualPointer: false })
  const verdict = await probeVirtualPointer({ socketPath: fake.socketPath, timeoutMs: 2000 })
  check(verdict?.available === false, `a compositor without the interface must probe as unavailable, saw ${JSON.stringify(verdict)}`)
  check(/virtual_pointer/.test(String(verdict?.reason)), `the reason should name the interface, saw ${JSON.stringify(verdict?.reason)}`)
  check(fake.state.created.length === 0, 'a failed probe must not create a device either')
  cleanup(fake)
}
{
  /* An unreachable socket is data for a check tool, never an exception. */
  const verdict = await probeVirtualPointer({ socketPath: join(os.tmpdir(), 'dsh-wayland-no-such-socket'), timeoutMs: 1000 })
  check(verdict?.available === false, `an unreachable socket must probe as unavailable, saw ${JSON.stringify(verdict)}`)
  check(typeof verdict?.reason === 'string' && verdict.reason.length > 0, 'an unavailable probe must carry a reason')
}

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`pointer check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('pointer check ok: one persistent zwlr_virtual_pointer_v1, absolute motion, press+release, wheel, clean teardown')
