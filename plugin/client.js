/**
 * dsh-wayland — Client half.
 *
 * Registers a "wayland" tab type in the right sidebar. The tab body pulls
 * frames from the Host half one at a time (so it can report real latency and
 * detect a stalled stream), draws them, and forwards pointer/keyboard events
 * back through the same small HTTP API.
 *
 * Two things the panel owes the person using it:
 *   - it scales with the surrounding UI (14px, the sidebar's own body size)
 *     instead of a hardcoded small size, and every control explains itself on
 *     hover;
 *   - it is translated through the client locale service, with an English
 *     dictionary as a fallback so the panel still renders without it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wayland',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ID = 'dsh-wayland'
    const BASE = '/dsh-wayland'
    /** Locale namespace: every user-visible string in this file lives here. */
    const NS = 'dsh-wayland'

    /**
     * Shipped copy. The Host half reports dependencies in English (it also talks
     * to the model, which reads one language); the panel translates what it puts
     * in front of a person, including those reports' per-binary purposes and
     * distribution labels, by keying them on the stable identifiers the Host
     * sends (binary name, platform label).
     */
    const DICT = {
      en: {
        'tab.title': 'Wayland',
        'guide.title': 'Wayland desktop',
        'guide.description': 'Run and control a headless Wayland session in this panel',
        'toolbar.session.label': 'Session to show',
        'toolbar.session.tip': 'Pick which session this panel shows; one session at a time.',
        'toolbar.new': 'New',
        'toolbar.new.tip': 'Start a headless desktop sized to this panel and open the default terminal in it.',
        'toolbar.refresh': 'Refresh',
        'toolbar.refresh.tip': 'Re-read the session list and the access token — use it when the picture is stuck or the panel reports 403.',
        'toolbar.close': 'Close',
        'toolbar.close.tip': 'Shut this session down: every program in it is terminated and its temporary files are removed.',
        'toolbar.control.on': 'Control on',
        'toolbar.control.off': 'Control off',
        'toolbar.control.tip': 'On: this panel captures the mouse and keyboard and forwards them into the session. Off: watch only.',
        'stage.tip': 'Click the picture to take over the mouse and keyboard. The badge reports live metrics: ● live, ‖ paused, ◌ stalled.',
        'empty.title': 'No Wayland session yet.',
        'empty.start': 'Start a session',
        'empty.starting': 'Starting…',
        'empty.workflow': 'After it starts, click the picture to take over the mouse and keyboard; toggle Control off to go back to watching.',
        'empty.optional': 'Optional, not found: {names}',
        'missing.title': 'Missing runtime: {names} — sessions cannot start.',
        'missing.why': '{name}: {purpose}',
        'missing.search': 'Looked in {where} and then PATH. Install the packages, or point config.binDir at a directory that has them.',
        'missing.searchPath': 'Looked in PATH (no binDir is configured). Install the packages, or point config.binDir at a directory that has them.',
        'hud.tip': 'Live metrics: frame rate · frame time · frame size · session resolution. ● live, ‖ paused, ◌ stalled.',
        'hud.noSession': 'no session',
        'hud.paused': 'paused · panel not visible',
        'hud.connecting': 'connecting…',
        'hud.stalled': 'stalled · last frame {seconds}s ago',
        'hud.metrics': '{fps} fps · {ms} ms · {kb} KB · {width}x{height}',
        'hud.inputOn': 'input on',
        'hud.inputOff': 'input off',
        'image.alt': 'Wayland session',
        'error.host': 'cannot reach the dsh-wayland host half',
        'error.frame': 'frame request failed ({status})',
        'error.request': 'the Host refused the request: {message}',
        'error.generic': 'the request failed',
        'purpose.sway': 'the headless compositor that hosts every session',
        'purpose.swaymsg': 'sway IPC: window tree, focus, output background',
        'purpose.grim': 'screenshots and the live panel frames',
        'purpose.wtype': 'keyboard injection',
        'purpose.wlrctl': 'pointer injection (move, click, scroll)',
        'purpose.wl-copy': 'pasting non-ASCII text',
        'purpose.foot': "the panel's default terminal",
        'purpose.wayvnc': 'planned smooth streaming',
        'purpose.wf-recorder': 'planned recording',
        'purpose.xterm': 'legacy X11 terminal',
        'purpose.unknown': 'required by the plugin',
        'platform.other': 'Other distributions',
      },
      zh: {
        'tab.title': 'Wayland',
        'guide.title': 'Wayland 桌面',
        'guide.description': '在这个面板里运行并操控一个无头 Wayland 会话',
        'toolbar.session.label': '显示的会话',
        'toolbar.session.tip': '选择这个面板显示哪个会话；同一时间只显示一个。',
        'toolbar.new': '新建',
        'toolbar.new.tip': '按面板尺寸新建一个无头桌面，并在里面打开默认终端。',
        'toolbar.refresh': '刷新',
        'toolbar.refresh.tip': '重新读取会话列表与访问令牌——画面卡住或面板报 403 时用它。',
        'toolbar.close': '关闭',
        'toolbar.close.tip': '关闭这个会话：其中的所有程序都会被终止，临时文件被删除。',
        'toolbar.control.on': '输入：开',
        'toolbar.control.off': '输入：关',
        'toolbar.control.tip': '开：面板捕获鼠标与键盘并转发进会话。关：只观看，不接管输入。',
        'stage.tip': '点击画面即可接管鼠标和键盘；角标显示实时指标：● 实时、‖ 已暂停、◌ 卡住。',
        'empty.title': '还没有 Wayland 会话。',
        'empty.start': '新建会话',
        'empty.starting': '正在启动…',
        'empty.workflow': '启动后点一下画面即可接管鼠标和键盘；把"输入"切回关闭就恢复为只看。',
        'empty.optional': '可选依赖未找到：{names}',
        'missing.title': '缺少运行时依赖：{names}——无法新建会话。',
        'missing.why': '{name}：{purpose}',
        'missing.search': '查找过 {where}，然后是 PATH。安装这些软件包，或把 config.binDir 指向含它们的目录。',
        'missing.searchPath': '只在 PATH 里找过（没有配置 binDir）。安装这些软件包，或把 config.binDir 指向含它们的目录。',
        'hud.tip': '实时指标：帧率 · 单帧耗时 · 帧大小 · 会话分辨率。● 实时 ‖ 已暂停 ◌ 卡住。',
        'hud.noSession': '无会话',
        'hud.paused': '已暂停 · 面板不可见',
        'hud.connecting': '连接中…',
        'hud.stalled': '卡住 · 最后一帧在 {seconds} 秒前',
        'hud.metrics': '{fps} fps · {ms} ms · {kb} KB · {width}x{height}',
        'hud.inputOn': '输入开',
        'hud.inputOff': '输入关',
        'image.alt': 'Wayland 会话画面',
        'error.host': '联系不上 dsh-wayland 的 Host half',
        'error.frame': '取帧失败（{status}）',
        'error.request': 'Host 拒绝了这次请求：{message}',
        'error.generic': '请求失败',
        'purpose.sway': '承载每个会话的无头合成器',
        'purpose.swaymsg': 'sway IPC：窗口树、焦点、输出背景',
        'purpose.grim': '截图与面板的实时画面',
        'purpose.wtype': '键盘注入',
        'purpose.wlrctl': '指针注入（移动、点击、滚轮）',
        'purpose.wl-copy': '粘贴非 ASCII 文本',
        'purpose.foot': '面板默认打开的终端',
        'purpose.wayvnc': '计划中的流畅串流',
        'purpose.wf-recorder': '计划中的录制',
        'purpose.xterm': '老式 X11 终端',
        'purpose.unknown': '插件必需',
        'platform.other': '其他发行版',
      },
    }

    /** Interpolate `{name}` the way the locale runtime does. */
    const fill = (template, params) => (params === undefined
      ? template
      : String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)))

    /** English-only seat, used when the client tree has no locale service. */
    const fallbackT = (key, params) => fill(DICT.en[key] ?? key, params)

    /**
     * The locale service, plus the panels currently on screen. A dynamic client
     * plugin can apply before the locale service mounts, and a service that is not
     * there yet must not leave the panel English for its whole lifetime: the
     * service is resolved again through `ctx.inject`, and every mounted panel
     * watches this seat so a late arrival — or a language switch — re-renders it.
     */
    const seat = { locale: null, watchers: new Set(), unsubscribe: null }
    const notifyWatchers = () => { for (const watcher of seat.watchers) watcher() }

    function watch(locale) {
      if (typeof locale?.register !== 'function' || typeof locale?.bind !== 'function') return
      if (locale === seat.locale) return
      seat.unsubscribe?.()
      seat.locale = locale
      seat.unsubscribe = typeof locale.subscribe === 'function' ? locale.subscribe(notifyWatchers) : null
      notifyWatchers()
    }

    /** Translate through the locale, or fall back to the shipped English. A
     *  registry that holds this namespace without this key — an older dictionary
     *  left behind by a previous instance — must show English, never the raw key
     *  (`locale.bind` returns the key itself when it has no entry for it). */
    const translate = (key, params) => {
      if (seat.locale) {
        const value = seat.locale.bind(NS)(key, params)
        if (value !== key) return value
      }
      return fallbackT(key, params)
    }
    /** The shipped dictionary registers at most once per module instance: the
     *  locale registry rejects a namespace+locale it already holds. */
    let copyRegistered = false
    /** Re-render on a language switch and when the locale service arrives late. */
    function useT() {
      const [, bump] = React.useReducer((count) => count + 1, 0)
      React.useEffect(() => {
        const watcher = () => bump((count) => count + 1)
        seat.watchers.add(watcher)
        return () => { seat.watchers.delete(watcher) }
      }, [])
      return translate
    }

    /** Boot facts come from the Host route (never browser-cached); the injected
     *  global is only a fallback, because it goes stale the moment the Host half
     *  reloads and rotates its token. */
    let bootInfo = null
    async function ensureBoot(force = false) {
      if (!force && bootInfo) return bootInfo
      try {
        const res = await fetch(`${BASE}/boot`, { cache: 'no-store' })
        const payload = await res.json()
        if (payload?.ok) {
          bootInfo = payload.value
          return bootInfo
        }
      } catch {
        /* fall through to the injected value */
      }
      if (globalThis.__DSH_WAYLAND__) {
        bootInfo = globalThis.__DSH_WAYLAND__
        return bootInfo
      }
      if (bootInfo) return bootInfo
      throw new Error(translate('error.host'))
    }

    /** Authenticated request that survives a Host-half reload: a rejected token
     *  is re-read once and the request replayed. */
    async function request(path, init = {}) {
      const send = (info) => fetch(path, {
        ...init,
        cache: 'no-store',
        headers: { ...(init.headers ?? {}), 'x-dsh-wayland-token': info.token },
      })
      const first = await ensureBoot()
      let res = await send(first)
      if (res.status === 401 || res.status === 403) {
        const fresh = await ensureBoot(true)
        if (fresh.token !== first.token) res = await send(fresh)
      }
      return res
    }

    async function call(method, params) {
      const res = await request(`${BASE}/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params: params ?? null }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok || !payload.ok) {
        /* Host prose is English by design (the same text serves the model); the
           sentence the panel puts around it is the panel's to translate. */
        throw new Error(payload.error ? translate('error.request', { message: payload.error }) : translate('error.generic'))
      }
      return payload.value
    }

    /** The panel always renders the Host's live profile (frame rate, quality and
     *  format come from `liveFps`/`liveQuality`/`liveMediaType` config). */
    const DEFAULT_LIVE = { fps: 20, quality: 82, mediaType: 'image/jpeg' }

    const KEY_NAMES = {
      Enter: 'Return', Backspace: 'BackSpace', Escape: 'Escape', Tab: 'Tab', ' ': 'space',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', Insert: 'Insert',
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /* Type scale: this panel is chrome inside the shell's own sidebar, so it
       inherits the shell's font size and expresses every smaller tier in `em`.
       Hardcoding 14/13/12px made the panel the one surface that ignored the
       host's scale — and the tiers drifted apart again as soon as the host's
       scale changed. Nothing here sets an absolute px font size. */
    const styles = {
      root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 'inherit', lineHeight: 1.43, background: 'var(--dsw-alias-bg-base, transparent)' },
      bar: { display: 'flex', alignItems: 'center', gap: '0.57em', padding: '0.57em 0.71em', borderBottom: '0.5px solid var(--dsw-alias-border-l3)', flexWrap: 'wrap' },
      control: { display: 'inline-flex' },
      select: {
        flex: '1 1 10.7em', minWidth: '7.9em', height: '2.14em', fontSize: 'inherit', lineHeight: 1.43, padding: '0 0.57em',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 6,
      },
      button: {
        height: '2.14em', fontSize: 'inherit', lineHeight: 1.43, padding: '0 0.86em', borderRadius: 6, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '0.5px solid var(--dsw-alias-border-l3)',
      },
      primary: { fontWeight: 500 },
      stage: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#101318' },
      image: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
      overlay: { position: 'absolute', inset: 0, outline: 'none', cursor: 'crosshair' },
      hud: { position: 'absolute', left: '0.71em', bottom: '0.57em', fontSize: '0.86em', lineHeight: 1.14, padding: '0.29em 0.57em', borderRadius: 6, pointerEvents: 'none', background: 'rgba(0,0,0,.6)', color: '#d8dee9' },
      message: { padding: '1.43em', fontSize: 'inherit', color: 'var(--dsw-alias-label-secondary)', display: 'flex', flexDirection: 'column', gap: '0.71em', alignItems: 'flex-start' },
      hint: { fontSize: '0.93em', lineHeight: 1.43, color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))', maxWidth: '48em' },
      error: { padding: '0.57em 0.71em', fontSize: '0.93em', color: 'var(--dsw-alias-label-primary)', background: 'rgba(200,60,60,.18)' },
    }

    function WaylandPanel(props) {
      const t = useT()
      const useTabInfo = props.useTabInfo
      const info = useTabInfo ? useTabInfo() : { tab: { id: 'default', visible: true } }
      const tabId = info?.tab?.id ?? 'default'
      const tabVisible = true /* gated by mount + window visibility instead */
      const storageKey = `dsh.wayland.tab.${tabId}`

      const [token, setToken] = React.useState(bootInfo?.token ?? '')
      const [sessions, setSessions] = React.useState(bootInfo?.sessions ?? [])
      const [selected, setSelected] = React.useState(() => {
        try { return globalThis.localStorage?.getItem(storageKey) ?? '' } catch { return '' }
      })
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [capture, setCapture] = React.useState(true)
      const [nonce, setNonce] = React.useState(0)
      const [dims, setDims] = React.useState({ width: 1280, height: 800 })
      const [frame, setFrame] = React.useState({ url: '', fps: 0, ms: 0, at: 0, bytes: 0 })
      const [now, setNow] = React.useState(Date.now())
      const [windowVisible, setWindowVisible] = React.useState(() => globalThis.document?.visibilityState !== 'hidden')
      const root = React.useRef(null)
      const overlay = React.useRef(null)
      const dragging = React.useRef(null)
      const revokeQueue = React.useRef([])

      React.useEffect(() => {
        const onVisibility = () => setWindowVisible(globalThis.document?.visibilityState !== 'hidden')
        globalThis.document?.addEventListener('visibilitychange', onVisibility)
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => {
          globalThis.document?.removeEventListener('visibilitychange', onVisibility)
          clearInterval(timer)
        }
      }, [])

      React.useEffect(() => {
        if (token) return undefined
        let alive = true
        ensureBoot()
          .then((value) => { if (alive) setToken(value.token) })
          .catch((cause) => { if (alive) setError(cause.message) })
        return () => { alive = false }
      }, [token])

      const refresh = React.useCallback(async () => {
        if (!token) return []
        try {
          const value = await call('sessions.list')
          setSessions(value.sessions ?? [])
          setError('')
          return value.sessions ?? []
        } catch (cause) {
          setError(cause.message)
          return []
        }
      }, [token])

      React.useEffect(() => {
        if (!token) return undefined
        let alive = true
        const tick = async () => { if (alive) await refresh() }
        tick()
        const timer = setInterval(tick, 4000)
        return () => { alive = false; clearInterval(timer) }
      }, [refresh, token])

      React.useEffect(() => {
        if (sessions.length === 0) return
        const known = sessions.some((s) => s.id === selected)
        const next = known ? selected : sessions[sessions.length - 1].id
        if (!known) {
          setSelected(next)
          try { globalThis.localStorage?.setItem(storageKey, next) } catch {}
        }
        const found = sessions.find((s) => s.id === next)
        if (found) setDims({ width: found.width, height: found.height })
      }, [sessions, selected, storageKey])

      /* One request per frame: the panel knows exactly when a frame arrived, so
         it can show real latency and call out a stalled stream. */
      const live = Boolean(selected && token && tabVisible && windowVisible)
      React.useEffect(() => {
        if (!live) return undefined
        const profile = { scale: 1, ...DEFAULT_LIVE, ...(bootInfo?.live ?? {}) }
        const interval = 1000 / profile.fps
        const controller = new AbortController()
        let stopped = false
        let lastAt = 0
        let fps = 0

        const loop = async () => {
          while (!stopped) {
            const started = performance.now()
            const url = `${BASE}/frame?session=${encodeURIComponent(selected)}&mediaType=${profile.mediaType}`
              + `&scale=${profile.scale}&quality=${profile.quality}&t=${Date.now()}`
            try {
              const res = await request(url, { signal: controller.signal })
              if (!res.ok) throw new Error(translate('error.frame', { status: res.status }))
              const blob = await res.blob()
              if (stopped) return
              const objectUrl = URL.createObjectURL(blob)
              revokeQueue.current.push(objectUrl)
              const elapsed = performance.now() - started
              const at = Date.now()
              if (lastAt) fps = fps === 0 ? 1000 / (at - lastAt) : fps * 0.7 + (1000 / (at - lastAt)) * 0.3
              lastAt = at
              setFrame({ url: objectUrl, fps, ms: Math.round(elapsed), at, bytes: blob.size })
              setError('')
            } catch (cause) {
              if (stopped || cause?.name === 'AbortError') return
              setError(cause.message)
              await sleep(400)
            }
            const elapsed = performance.now() - started
            if (elapsed < interval) await sleep(interval - elapsed)
          }
        }
        void loop()
        return () => {
          stopped = true
          controller.abort()
        }
      }, [live, selected, token, nonce])

      const onFrameLoad = React.useCallback(() => {
        /* the browser has the current frame; drop every earlier blob */
        while (revokeQueue.current.length > 1) {
          const stale = revokeQueue.current.shift()
          try { URL.revokeObjectURL(stale) } catch {}
        }
      }, [])

      const createSession = React.useCallback(async () => {
        setBusy(true)
        try {
          /* Match the session to the panel's physical pixels so the picture is
             never upscaled (a 1280-wide session on a HiDPI panel looks soft). */
          const dpr = globalThis.devicePixelRatio || 1
          const cssWidth = root.current?.clientWidth ?? 0
          const width = Math.max(1280, Math.min(1920, Math.round(((cssWidth || 1280) * dpr) / 2) * 2))
          const height = Math.round((width * 10) / 16 / 2) * 2
          const value = await call('sessions.create', { name: `panel ${width}x${height}`, width, height })
          const id = value?.session?.id ?? ''
          if (id) {
            setSelected(id)
            try { globalThis.localStorage?.setItem(storageKey, id) } catch {}
          }
          await refresh()
          if (id) {
            await call('apps.launch', { session: id, command: 'foot', wait: false }).catch(() => {})
            setNonce((n) => n + 1)
          }
          setError('')
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [refresh, storageKey])

      const closeSession = React.useCallback(async () => {
        if (!selected) return
        setBusy(true)
        try {
          await call('sessions.close', { session: selected })
          setSelected('')
          await refresh()
        } catch (cause) {
          setError(cause.message)
        } finally {
          setBusy(false)
        }
      }, [selected, refresh])

      const send = React.useCallback((actions) => {
        const session = selected
        if (!session || actions.length === 0) return
        call('input', { session, actions }).catch((cause) => setError(cause.message))
      }, [selected])

      const toSession = React.useCallback((event) => {
        const element = event.currentTarget
        const rect = element.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 }
        const aspect = dims.width / dims.height
        const boxAspect = rect.width / rect.height
        let renderW = rect.width
        let renderH = rect.height
        let offsetX = 0
        let offsetY = 0
        if (boxAspect > aspect) {
          renderW = rect.height * aspect
          offsetX = (rect.width - renderW) / 2
        } else {
          renderH = rect.width / aspect
          offsetY = (rect.height - renderH) / 2
        }
        return {
          x: Math.max(0, Math.min(dims.width - 1, Math.round(((event.clientX - rect.left - offsetX) / renderW) * dims.width))),
          y: Math.max(0, Math.min(dims.height - 1, Math.round(((event.clientY - rect.top - offsetY) / renderH) * dims.height))),
        }
      }, [dims])

      const onMouseDown = (event) => {
        if (!capture) return
        event.preventDefault()
        overlay.current?.focus()
        const point = toSession(event)
        const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
        dragging.current = button === 'left' ? point : null
        send([{ do: 'click', at: [point.x, point.y], button }])
      }

      const onMouseMove = (event) => {
        if (!capture || !dragging.current) return
        const point = toSession(event)
        send([{ do: 'move', to: [point.x, point.y] }])
      }

      const onMouseUp = () => { dragging.current = null }

      const onWheel = (event) => {
        if (!capture) return
        event.preventDefault()
        send([{ do: 'scroll', by: [Math.round(-event.deltaX / 40), Math.round(-event.deltaY / 40)] }])
      }

      const onKeyDown = (event) => {
        if (!capture) return
        event.preventDefault()
        const modifiers = []
        if (event.ctrlKey) modifiers.push('ctrl')
        if (event.altKey) modifiers.push('alt')
        if (event.metaKey) modifiers.push('super')
        if (event.shiftKey && (KEY_NAMES[event.key] || event.key.length > 1)) modifiers.push('shift')
        if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
          send([{ do: 'type', text: event.key }])
          return
        }
        const key = KEY_NAMES[event.key] ?? event.key
        if (key.length > 1 || modifiers.length > 0) send([{ do: 'key', keys: [...modifiers, key].join('+') }])
      }

      /* The Host half reports the toolchain; missing required binaries block every
         session, missing optional ones only remove a feature. Purposes and
         distribution labels are translated here, keyed on what the Host sends. */
      const toolchain = bootInfo?.toolchain ?? globalThis.__DSH_WAYLAND__?.toolchain ?? null
      const missingRequired = toolchain?.missingRequired ?? []
      const missingOptional = toolchain?.missingOptional ?? []
      const toolchainReady = toolchain ? toolchain.ready : true
      const entries = [...(toolchain?.required ?? []), ...(toolchain?.optional ?? [])]
      const purposeOf = (name) => {
        const translated = t(`purpose.${name}`)
        return translated === `purpose.${name}` ? (entries.find((e) => e.name === name)?.purpose ?? t('purpose.unknown')) : translated
      }
      /* The Host decides what to install and how; the panel only renders it, so
         there is one place to fix when distributions change their package names. */
      const installHints = toolchain?.installHints ?? []
      const platformLabel = (platform) => (platform === 'Other distributions' ? t('platform.other') : platform)
      const age = frame.at ? Math.max(0, Math.round((now - frame.at) / 1000)) : null
      const stalled = live && frame.at > 0 && age >= 3
      let hudText
      if (!selected) hudText = t('hud.noSession')
      else if (!tabVisible || !windowVisible) hudText = t('hud.paused')
      else if (!token) hudText = t('hud.connecting')
      else if (frame.at === 0) hudText = t('hud.connecting')
      else if (stalled) hudText = t('hud.stalled', { seconds: age })
      else {
        hudText = t('hud.metrics', {
          fps: frame.fps > 0 ? frame.fps.toFixed(1) : '–',
          ms: frame.ms,
          kb: Math.round(frame.bytes / 1024),
          width: dims.width,
          height: dims.height,
        })
      }

      /* A disabled form control is not hit-tested by the browser, so a `title` on
         the button itself never appears exactly when someone hovers to find out
         what the control does (no session yet, or a request in flight). The hint
         therefore lives on a wrapper that stays hoverable in both states, and the
         button carries none — one hover target, one tooltip, either state. */
      const control = (key, { label, tip, disabled, primary, style, onClick }) => h('span', {
        key,
        style: styles.control,
        title: tip,
      }, h('button', {
        style: { ...styles.button, ...(primary ? styles.primary : null), ...(style ?? null) },
        disabled,
        onClick,
      }, label))

      const children = []
      children.push(h('div', { key: 'bar', style: styles.bar },
        h('select', {
          style: styles.select,
          value: selected,
          title: t('toolbar.session.tip'),
          'aria-label': t('toolbar.session.label'),
          onChange: (event) => {
            setSelected(event.target.value)
            const found = sessions.find((s) => s.id === event.target.value)
            if (found) setDims({ width: found.width, height: found.height })
            try { globalThis.localStorage?.setItem(storageKey, event.target.value) } catch {}
          },
        },
        sessions.length === 0
          ? h('option', { value: '' }, t('hud.noSession'))
          : sessions.map((s) => h('option', { key: s.id, value: s.id }, `${s.name} · ${s.width}x${s.height}`)),
        ),
        control('new', { label: t('toolbar.new'), tip: t('toolbar.new.tip'), disabled: busy || !token, primary: true, onClick: createSession }),
        control('refresh', {
          label: t('toolbar.refresh'),
          tip: t('toolbar.refresh.tip'),
          disabled: !token,
          onClick: () => {
            ensureBoot(true).then((value) => setToken(value.token)).catch(() => {})
            setNonce((n) => n + 1)
            refresh()
          },
        }),
        control('close', { label: t('toolbar.close'), tip: t('toolbar.close.tip'), disabled: busy || !selected, onClick: closeSession }),
        control('capture', {
          label: capture ? t('toolbar.control.on') : t('toolbar.control.off'),
          tip: t('toolbar.control.tip'),
          style: { opacity: capture ? 1 : 0.6 },
          onClick: () => setCapture((value) => !value),
        }),
      ))

      if (error) children.push(h('div', { key: 'error', style: styles.error }, error))
      if (!toolchainReady) {
        children.push(h('div', { key: 'missing', style: styles.message },
          h('div', null, t('missing.title', { names: missingRequired.join(', ') })),
          ...missingRequired.map((name) => h('div', { key: `why-${name}`, style: styles.hint }, t('missing.why', { name, purpose: purposeOf(name) }))),
          h('div', { style: styles.hint }, toolchain?.binDir
            ? t('missing.search', { where: toolchain.binDir })
            : t('missing.searchPath')),
          ...installHints.map((hint) => h('div', { key: `hint-${hint.platform}`, style: styles.hint }, `${platformLabel(hint.platform)}: ${hint.command}`)),
        ))
      } else if (!selected) {
        children.push(h('div', { key: 'empty', style: styles.message },
          h('div', null, t('empty.title')),
          ...(missingOptional.length > 0 ? [h('div', { key: 'optional', style: styles.hint }, t('empty.optional', { names: missingOptional.join(', ') }))] : []),
          h('div', { style: styles.hint }, t('empty.workflow')),
          control('start', { label: busy ? t('empty.starting') : t('empty.start'), tip: t('toolbar.new.tip'), disabled: busy || !token, onClick: createSession }),
        ))
      } else {
        children.push(h('div', { key: 'stage', style: styles.stage },
          frame.url ? h('img', { src: frame.url, style: styles.image, alt: t('image.alt'), onLoad: onFrameLoad, draggable: false }) : null,
          h('div', {
            ref: overlay,
            style: styles.overlay,
            tabIndex: 0,
            title: t('stage.tip'),
            onMouseDown,
            onMouseMove,
            onMouseUp,
            onMouseLeave: onMouseUp,
            onWheel,
            onKeyDown,
            onContextMenu: (event) => event.preventDefault(),
          }),
          /* These two badges are `pointer-events: none` so dragging the desktop
             never starts on them, which also means a `title` here could never
             appear; their meaning is reachable on the overlay above and exposed
             to assistive tech as a label. */
          h('div', { style: { ...styles.hud, color: stalled ? '#e5a94e' : '#d8dee9' }, 'aria-label': t('hud.tip') },
            `${stalled ? '◌' : live ? '●' : '‖'} ${hudText}`),
          h('div', { style: { ...styles.hud, left: 'auto', right: '0.71em' }, 'aria-label': t('toolbar.control.tip') },
            capture ? t('hud.inputOn') : t('hud.inputOff')),
        ))
      }

      return h('div', { ref: root, style: styles.root }, children)
    }

    /**
     * Register the tab type and its body, then wire the optional locale service.
     * Separate from `apply` so the whole registration can be guarded there.
     */
    function registerPanel(ctx) {
      /* The shell provides the tab registry through `ctx.reflect.provide`, not as a
         catalogued Service, and it may not exist yet when this entry starts. Two
         things follow, both learned from a real stack trace
         (`cannot get property "sidebarRightTabs" without inject`):
         - the dependency is *declared* through `ctx.inject`, which fires as soon as
           the registry appears, whatever the entry order (the shipped client plugins
           list `sidebarRightTabs` in their static `inject` for the same reason);
         - it is reached only through `ctx.get(name)`, never `ctx.name`: this runtime
           reports an undeclared service property access as a thrown error, so the
           `?? ctx.sidebarRightTabs` fallback that used to sit here threw during boot
           and cost the panel its registration. */
      const present = ctx.get?.('sidebarRightTabs')
      if (present) registerTab(ctx, present)
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs'], (scope) => {
          if (scope.sidebarRightTabs !== present) registerTab(scope, scope.sidebarRightTabs)
        })
      } else if (!present) {
        console.error('[dsh-wayland] sidebarRightTabs is unavailable; the panel cannot register')
      }
    }

    /** The registration itself, run in whichever context owns the registry. */
    function registerTab(ctx, service) {
      if (!service) return
      ctx.effect(() => service.register({
        id: ID,
        kind: 'wayland',
        multiple: true,
        priority: 'extension',
        title: () => translate('tab.title'),
        guide: [{
          id: 'wayland',
          order: 25,
          title: () => translate('guide.title'),
          description: () => translate('guide.description'),
        }],
      }), 'dsh-wayland:tab-type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, WaylandPanel)), 'dsh-wayland:tab-body')

      /* Then the locale service: optional, so it is asked for rather than
         required — synchronously first, then through `ctx.inject`, which also
         fires when it mounts after this plugin (otherwise a plugin that applies
         first would stay on the English fallback for its whole lifetime). Both
         the wiring and the registration are non-fatal by design. */
      const registerCopy = (scope, locale) => {
        if (copyRegistered) return
        copyRegistered = true
        watch(locale)
        try {
          scope.effect(() => locale.register(NS, DICT), 'dsh-wayland:locale')
        } catch (error) {
          console.warn('[dsh-wayland] locale dictionary not registered; keeping the shipped English copy', error)
        }
      }
      try {
        /* `ctx.get` only — see the note on the tab registry above: an undeclared
           service property access throws in this runtime. */
        const present = ctx.get?.('locale')
        if (present) registerCopy(ctx, present)
        if (typeof ctx.inject === 'function') {
          ctx.inject(['locale'], (scope) => {
            if (scope.locale !== present) registerCopy(scope, scope.locale)
          })
        } else if (!present) {
          console.warn('[dsh-wayland] locale service unavailable; the panel falls back to English')
        }
      } catch (error) {
        console.warn('[dsh-wayland] locale wiring failed; the panel stays in English', error)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        /* A throwing client entry is not a missing tab. The renderer's boot marks
           the entry `failed` and aborts the whole application with
           `web boot: N entry did not activate` — that is how this plugin once left
           the browser unable to start. Registration is therefore guarded: the app
           always boots, and a panel that cannot register is a missing tab plus one
           loud console line, never a dead application. */
        try {
          registerPanel(ctx)
        } catch (error) {
          console.error('[dsh-wayland] panel registration failed; the app keeps booting without the wayland tab', error)
        }
      },
    }
  },
})
