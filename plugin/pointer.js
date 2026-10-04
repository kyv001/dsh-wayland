/**
 * dsh-wayland — persistent virtual pointer.
 *
 * A session's pointer input runs through ONE `zwlr_virtual_pointer_v1` object
 * that lives as long as the session, instead of one `wlrctl` process per action.
 * Two measured facts force this shape:
 *
 * 1. **Buttons from a throw-away device are lost.** `wlrctl pointer click`
 *    creates a virtual pointer, sends the button, and exits; the seat's pointer
 *    focus is set too late for that device (wlroots drops a button when
 *    `pointer_state.focused_client` is null) and is cleared again when the device
 *    is destroyed, so the click never reaches the client. Measured both on a
 *    Tk/Xwayland window and through `bindsym --whole-window button1`, which fires
 *    for every `wlrctl` click while the client sees nothing. With one long-lived
 *    pointer attached, `wlrctl` clicks start arriving — and so do ours.
 * 2. **Relative motion has no usable origin.** sway's cursor does not start at
 *    (0,0) on a fresh headless output, so the old "assume (0,0) and track deltas"
 *    model put the first click tens of pixels off. `motion_absolute` carries the
 *    position itself: no origin, no accumulated drift, no state to desync.
 *
 * The wire protocol is spoken by hand (node builtins only: a unix socket plus
 * little-endian structs), because the plugin must stay dependency-free. Only the
 * few objects this file needs are parsed; every other event is skipped by its
 * self-describing header size.
 *
 * Protocol: wlr-virtual-pointer-unstable-v1 (manager version 2).
 *   zwlr_virtual_pointer_v1: motion(0) motion_absolute(1) button(2) axis(3)
 *                            frame(4) axis_source(5) axis_stop(6)
 *                            axis_discrete(7) destroy(8)
 *   zwlr_virtual_pointer_manager_v1: create_virtual_pointer(0) destroy(1)
 *                            create_virtual_pointer_with_output(2)
 */
import { readFileSync } from 'node:fs'
import net from 'node:net'

const DISPLAY_ID = 1
const DISPLAY_ERROR = 0
const DISPLAY_DELETE_ID = 1

/** Linux input event codes, as `zwlr_virtual_pointer_v1.button` wants them. */
const BUTTONS = { left: 272, middle: 274, right: 273 }
/** `wl_pointer.axis` values. */
const AXES = { vertical: 0, horizontal: 1 }
const AXIS_SOURCE_WHEEL = 1

const OP = {
  motionAbsolute: 1,
  button: 2,
  axis: 3,
  frame: 4,
  axisSource: 5,
  axisStop: 6,
  destroy: 8,
}

/** Milliseconds since boot: the same clock sway stamps its own events with. */
function monotonicMs() {
  try {
    return Math.round(parseFloat(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000) >>> 0
  } catch {
    return Date.now() >>> 0
  }
}

function uint32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0)
  return buffer
}

function fixed(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32LE(Math.round(value * 256) | 0)
  return buffer
}

/** Wayland string: length (with NUL), bytes, padding to a 4-byte boundary. */
function waylandString(value) {
  const data = Buffer.from(`${value}\0`, 'utf8')
  const padding = (4 - (data.length % 4)) % 4
  return Buffer.concat([uint32(data.length), data, Buffer.alloc(padding)])
}

/**
 * Open a persistent virtual pointer on a Wayland socket.
 *
 * @param socketPath - the compositor's `wayland-N` socket inside the session.
 * @param width - output width in pixels; absolute motion is expressed as a
 *   fraction of this extent, so passing the session size makes x/y literal
 *   session pixels.
 * @param height - output height in pixels.
 * @param timeoutMs - give up if the handshake does not finish in time.
 * @param probeOnly - ask the compositor what it offers and stop: no seat bind, no
 *   `create_virtual_pointer`, no device. Resolves `{available, interfaceVersion?,
 *   reason?}` and never rejects, which is what a health check wants — an ephemeral
 *   device would perturb a live session (see the note at the top of this file).
 * @returns a pointer with `move/press/release/click/scroll/destroy`; every method
 *   resolves once the compositor has processed the request (a `wl_display.sync`
 *   round trip), so a caller may screenshot immediately afterwards.
 * @throws when the socket, the seat or the virtual-pointer interface is missing
 *   (not in `probeOnly` mode).
 */
export function openVirtualPointer({ socketPath, width, height, timeoutMs = 5000, probeOnly = false }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    let nextId = 2
    let inbox = Buffer.alloc(0)
    let queue = []
    let writing = false
    let settled = false
    let dead = null
    let chain = Promise.resolve()
    const callbacks = new Map()
    const globals = new Map()
    let registryId = 0
    let managerId = 0
    let seatId = 0
    let pointerId = 0

    const timer = setTimeout(() => {
      const reason = `virtual pointer handshake timed out after ${timeoutMs}ms`
      if (probeOnly) finish(null, { available: false, reason })
      else finish(new Error(reason))
    }, timeoutMs)

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (probeOnly) {
        /* One contract for every outcome: a probe resolves a verdict. */
        try { socket.end() } catch {}
        try { socket.destroy() } catch {}
        resolve(value ?? { available: false, reason: String(error?.message ?? error ?? 'unknown failure') })
        return
      }
      if (error) {
        try { socket.destroy() } catch {}
        reject(error)
      } else {
        resolve(value ?? api)
      }
    }

    function message(objectId, opcode, payload) {
      const body = payload ?? Buffer.alloc(0)
      const header = Buffer.alloc(8)
      header.writeUInt32LE(objectId >>> 0, 0)
      header.writeUInt32LE((((8 + body.length) << 16) >>> 0 | (opcode & 0xffff)) >>> 0, 4)
      return Buffer.concat([header, body])
    }

    function flush() {
      if (writing || queue.length === 0) return
      writing = true
      const batch = Buffer.concat(queue)
      queue = []
      socket.write(batch, () => {
        writing = false
        flush()
      })
    }

    function send(...buffers) {
      if (dead) return
      queue.push(...buffers)
      flush()
    }

    /** Wait until the compositor has handled everything sent so far. */
    function roundtrip() {
      return new Promise((res, rej) => {
        if (dead) return rej(dead)
        const id = nextId++
        callbacks.set(id, { resolve: res, reject: rej })
        send(message(DISPLAY_ID, 0, uint32(id))) // wl_display.sync
      })
    }

    function readString(payload, offset) {
      const length = payload.readUInt32LE(offset)
      const value = payload.toString('utf8', offset + 4, offset + 4 + length - 1)
      return [value, offset + 4 + length + ((4 - (length % 4)) % 4)]
    }

    function dispatch(objectId, opcode, payload) {
      if (objectId === DISPLAY_ID) {
        if (opcode === DISPLAY_ERROR) {
          const target = payload.readUInt32LE(0)
          const code = payload.readUInt32LE(4)
          const [text] = readString(payload, 8)
          fail(new Error(`wayland protocol error on object ${target} (${code}): ${text}`))
        }
        /* delete_id only retires ids; ours are never reused. */
        return
      }
      if (objectId === registryId && opcode === 0) {
        const name = payload.readUInt32LE(0)
        const [iface, offset] = readString(payload, 4)
        globals.set(iface, { name, version: payload.readUInt32LE(offset) })
        return
      }
      /* wl_callback.done retires a round trip. */
      const pending = callbacks.get(objectId)
      if (pending) {
        callbacks.delete(objectId)
        pending.resolve(objectId)
      }
    }

    function fail(error) {
      dead = error
      for (const pending of callbacks.values()) pending.reject(error)
      callbacks.clear()
      finish(error)
    }

    socket.on('data', (chunk) => {
      inbox = inbox.length ? Buffer.concat([inbox, chunk]) : chunk
      while (inbox.length >= 8) {
        const objectId = inbox.readUInt32LE(0)
        const word = inbox.readUInt32LE(4)
        const size = word >>> 16
        if (size < 8 || inbox.length < size) break
        try {
          dispatch(objectId, word & 0xffff, inbox.subarray(8, size))
        } catch (error) {
          fail(error)
          return
        }
        inbox = inbox.subarray(size)
      }
    })
    socket.on('error', (error) => fail(new Error(`wayland socket: ${error.message}`)))
    socket.on('close', () => fail(new Error('wayland socket closed')))

    /* --------------------------------------------------------- injection */

    function absoluteMove(x, y) {
      const px = Math.max(0, Math.min(width - 1, Math.round(x)))
      const py = Math.max(0, Math.min(height - 1, Math.round(y)))
      send(message(pointerId, OP.motionAbsolute, Buffer.concat([
        uint32(monotonicMs()), uint32(px), uint32(py), uint32(width), uint32(height),
      ])))
      send(message(pointerId, OP.frame))
      return { x: px, y: py }
    }

    function pressButton(name, state) {
      const code = BUTTONS[String(name ?? 'left').toLowerCase()] ?? BUTTONS.left
      send(message(pointerId, OP.button, Buffer.concat([uint32(monotonicMs()), uint32(code), uint32(state)])))
      send(message(pointerId, OP.frame))
    }

    /** Run one command on the shared chain so two calls cannot interleave. */
    function serialize(job) {
      const run = chain.then(async () => {
        if (dead) throw dead
        return job()
      })
      chain = run.catch(() => {})
      return run
    }

    const api = {
      /** Position of the pointer after the last move, in session pixels. */
      position: { x: 0, y: 0 },

      /** Move to an absolute session pixel; resolves once the compositor applied it. */
      move(x, y) {
        return serialize(async () => {
          api.position = absoluteMove(x, y)
          await roundtrip()
          return { ...api.position }
        })
      },

      /**
       * Hold a button down, and leave it held: the device lives on, so the
       * compositor keeps the button state across calls. This is what makes
       * press-and-hold gestures (long press, drag) expressible at all.
       */
      press(button = 'left') {
        return serialize(async () => {
          pressButton(button, 1)
          await roundtrip()
          return { button: String(button), held: true }
        })
      },

      /** Release a button held by {@link press}; a no-op button state for the client. */
      release(button = 'left') {
        return serialize(async () => {
          pressButton(button, 0)
          await roundtrip()
          return { button: String(button), held: false }
        })
      },

      /**
       * Press and release a button at the current position. The gap keeps the
       * two events in separate frames, which toolkits expect from a click.
       */
      click(button = 'left', gapMs = 15) {
        return serialize(async () => {
          pressButton(button, 1)
          await roundtrip()
          await new Promise((r) => setTimeout(r, gapMs))
          pressButton(button, 0)
          await roundtrip()
          return { button: String(button) }
        })
      },

      /** Wheel scroll; one axis pair per step, shaped like a wheel event. */
      scroll(dx = 0, dy = 0) {
        return serialize(async () => {
          const steps = []
          for (let i = 0; i < Math.abs(Math.round(dy)); i++) steps.push([AXES.vertical, Math.sign(dy)])
          for (let i = 0; i < Math.abs(Math.round(dx)); i++) steps.push([AXES.horizontal, Math.sign(dx)])
          if (steps.length === 0) return { dx: 0, dy: 0 }
          for (const [axis, direction] of steps) {
            send(message(pointerId, OP.axisSource, uint32(AXIS_SOURCE_WHEEL)))
            send(message(pointerId, OP.axis, Buffer.concat([uint32(monotonicMs()), uint32(axis), fixed(direction)])))
            send(message(pointerId, OP.frame))
            send(message(pointerId, OP.axisSource, uint32(AXIS_SOURCE_WHEEL)))
            send(message(pointerId, OP.axisStop, Buffer.concat([uint32(monotonicMs()), uint32(axis)])))
            send(message(pointerId, OP.frame))
          }
          await roundtrip()
          return { dx: Math.round(dx), dy: Math.round(dy) }
        })
      },

      /**
       * Destroy the device and close the socket. Called when the session is
       * recycled; a session must not leave a pointer behind on the compositor.
       */
      destroy() {
        return serialize(async () => {
          send(message(pointerId, OP.destroy))
          await roundtrip().catch(() => {})
          try { socket.end() } catch {}
          try { socket.destroy() } catch {}
          dead = new Error('virtual pointer destroyed')
        }).catch(() => {})
      },
    }

    /* ---------------------------------------------------------- handshake */

    /* The seat is only needed as the `create_virtual_pointer` argument. */
    const seatVersion = 5

    const handshake = (async () => {
      await new Promise((res, rej) => {
        socket.once('connect', res)
        socket.once('error', rej)
      })
      registryId = nextId++
      send(message(DISPLAY_ID, 1, uint32(registryId))) // wl_display.get_registry
      await roundtrip()

      const manager = globals.get('zwlr_virtual_pointer_manager_v1')
      const seat = globals.get('wl_seat')
      if (!manager) throw new Error('the compositor does not offer zwlr_virtual_pointer_manager_v1')
      if (!seat) throw new Error('the compositor does not offer wl_seat')
      if (probeOnly) return { available: true, interfaceVersion: manager.version }

      managerId = nextId++
      send(message(registryId, 0, Buffer.concat([
        uint32(manager.name), waylandString('zwlr_virtual_pointer_manager_v1'),
        uint32(Math.min(manager.version, 2)), uint32(managerId),
      ])))
      seatId = nextId++
      send(message(registryId, 0, Buffer.concat([
        uint32(seat.name), waylandString('wl_seat'),
        uint32(Math.min(seat.version, seatVersion)), uint32(seatId),
      ])))
      await roundtrip()

      pointerId = nextId++
      send(message(managerId, 0, Buffer.concat([uint32(seatId), uint32(pointerId)])))
      await roundtrip()
      return { pointerId, interfaceVersion: manager.version }
    })()

    handshake
      .then((value) => finish(null, probeOnly ? value : undefined))
      .catch((error) => {
        const reason = error?.message ?? String(error)
        /* A probe reports what it could not find; an open fails loudly. */
        if (probeOnly) finish(null, { available: false, reason })
        else finish(error)
      })
  })
}

/**
 * Read-only capability probe: does this compositor offer the virtual-pointer
 * protocol? It binds nothing and creates no device, so it is safe to run against
 * a live session — an ephemeral pointer is exactly what breaks button delivery
 * (see the file header), so a health check must never create one.
 *
 * @returns `{available: true, interfaceVersion}` or `{available: false, reason}`.
 */
export function probeVirtualPointer(options) {
  return openVirtualPointer({ ...options, probeOnly: true })
}
