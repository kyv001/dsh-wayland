/**
 * Offline check: what the panel actually renders, without a browser.
 *
 * The client half is a `__ModuleLoader__.load({ id, factory })` module, so this
 * loads it exactly the way the browser would, supplies a minimal React (enough
 * for the hooks the panel uses, and deliberately *not* running effects, so no
 * requests or timers are involved), and walks the returned element tree.
 *
 * It asserts the things a person sees and a screenshot would show:
 *   - the chrome is translated (English and Chinese), with no dictionary key
 *     leaking through as text, no English left behind in the Chinese render, and
 *     both dictionaries holding exactly the same keys;
 *   - every interactive control's hover hint is *reachable*: a hint the browser
 *     would never show is not a hint. Disabled form controls are not hit-tested,
 *     so a `disabled` control must inherit its hint from a wrapper, and an
 *     element that cannot receive the pointer (`pointer-events: none`) must not
 *     carry one at all;
 *   - the panel contributes chrome and therefore inherits the shell's type scale
 *     instead of hardcoding px sizes;
 *   - the locale service may arrive *after* the plugin applies; the panel must
 *     pick it up then rather than staying on the English fallback forever;
 *   - the removed "Live/Crisp" toggle is gone, and the Host's live profile is
 *     what drives the frame request;
 *   - the missing-dependency screen names each binary with a translated purpose
 *     and shows the Host's install lines.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `DSH_WAYLAND_CLIENT` checks an artifact other than the working copy — the
 *  bytes the renderer will actually load, fetched from the plugin route. */
const CLIENT = process.env.DSH_WAYLAND_CLIENT ?? join(HERE, '..', 'plugin', 'client.js')

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

/** Minimal React: createElement plus the hooks this panel calls, no effects. */
function makeReact() {
  let hooks = []
  let cursor = 0
  return {
    reset() { hooks = []; cursor = 0 },
    React: {
      createElement: (type, props, ...children) => ({
        type,
        props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
      }),
      useState: (initial) => {
        const slot = cursor++
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
        return [hooks[slot], () => {}]
      },
      useReducer: (_reducer, initial) => {
        const slot = cursor++
        if (!(slot in hooks)) hooks[slot] = initial
        return [hooks[slot], () => {}]
      },
      useEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (initial) => {
        const slot = cursor++
        if (!(slot in hooks)) hooks[slot] = { current: initial }
        return hooks[slot]
      },
    },
  }
}

/** Locale stub with the runtime's shape: register/bind/subscribe, including the
 *  real registry's rule that a namespace+locale may be registered only once. */
function makeLocale() {
  const dicts = new Map()
  const listeners = new Set()
  const state = { active: 'en' }
  return {
    state,
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts)
      let locales = dicts.get(ns)
      if (!locales) { locales = new Map(); dicts.set(ns, locales) }
      for (const [locale] of pairs) {
        if (locales.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
      }
      for (const [locale, entries] of pairs) locales.set(locale, entries)
      return () => { for (const [locale] of pairs) locales.delete(locale) }
    },
    entries(ns) {
      const locales = dicts.get(ns)
      if (!locales) return undefined
      return Object.fromEntries(locales)
    },
    bind(ns) {
      return (key, params) => {
        const locales = dicts.get(ns) ?? new Map()
        const entries = locales.get(state.active) ?? locales.get('en') ?? {}
        const template = entries[key] ?? key
        if (params === undefined) return template
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    setActive(language) { state.active = language; for (const listener of listeners) listener() },
  }
}

/** Load the client module the way the browser does and return its plugin object. */
function loadClient() {
  const source = readFileSync(CLIENT, 'utf8')
  const mini = makeReact()
  const storage = { value: null }
  let registration = null
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load: (value) => { registration = value } } },
    localStorage: { getItem: () => storage.value, setItem: (key, value) => { storage.value = value } },
  }
  sandbox.globalThis = sandbox
  runInContext(source, createContext(sandbox), { filename: CLIENT })
  check(registration?.id === 'dsh-wayland', `client registers as ${JSON.stringify(registration?.id)}`)
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return mini.React
    throw new Error(`unexpected require(${specifier})`)
  })
  check(plugin?.inject?.includes('slots'), 'the client half must inject the slots service')
  /* The client module reads its boot facts from *its own* global, so the test
     must inject them there rather than into the probe's global. */
  return { plugin, mini, storage, boot: (value) => { sandbox.__DSH_WAYLAND__ = value } }
}

/** Collect every string and every element, each element with its ancestor chain. */
function walk(node, out = { strings: [], elements: [], entries: [] }, ancestors = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.strings.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out, ancestors); return out }
  out.elements.push(node)
  out.entries.push({ element: node, ancestors })
  walk(node.props?.children, out, [...ancestors, node])
  return out
}

/**
 * Mount the plugin the way the shell does.
 * `localeAtApply: false` models the race this check exists to prevent: a dynamic
 * client plugin applying before the locale service is mounted, which then has to
 * arrive through `ctx.inject`.
 * `preRegistered: true` models the state a hot reload leaves behind when the
 * previous instance's dictionary is still in the registry — the locale service
 * rejects the duplicate, and that must not cost the panel.
 */
function mount({ localeAtApply = true, serviceAtApply = true, preRegistered = false, registerThrows = false } = {}) {
  const { plugin, mini, boot, storage } = loadClient()
  const locale = makeLocale()
  const injections = []
  let tabType = null
  let Panel = null
  let applyError = null
  const registry = {
    register: (spec) => {
      if (registerThrows) throw new Error('sidebarRightTabs: a type with this id already exists')
      tabType = spec
      return () => {}
    },
  }
  /* Services the plugin may reach through `ctx.get`; everything else must be
     injected. The real client runtime *throws* on an undeclared service property
     (`cannot get property "x" without inject`), so this stub does too — the
     permissive version of this stub is exactly why the missing `sidebarRightTabs`
     declaration went unnoticed until a user's console showed the stack. */
  const base = {
    get: (name) => {
      if (name === 'locale') return localeAtApply ? locale : undefined
      if (name === 'sidebarRightTabs') return serviceAtApply ? registry : undefined
      return undefined
    },
    inject: (deps, callback) => { injections.push({ deps, callback }); return () => {} },
    slots: { inject: (_name, register) => register(), register: (_spec, component) => { Panel = component; return () => {} } },
    effect: (callback) => { callback(); return () => {} },
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const undeclared = (name) => ({
    get() { throw new Error(`cannot get property "${name}" without inject`) },
  })
  const ctx = { ...base }
  Object.defineProperty(ctx, 'locale', undeclared('locale'))
  Object.defineProperty(ctx, 'sidebarRightTabs', undeclared('sidebarRightTabs'))
  try {
    if (preRegistered) locale.register('dsh-wayland', { en: { 'tab.title': 'stale' }, zh: { 'tab.title': 'stale' } })
    plugin.apply(ctx)
  } catch (error) {
    applyError = error
  }
  const render = (facts, props = {}) => {
    boot(facts)
    mini.reset()
    return walk(Panel({ useTabInfo: () => ({ tab: { id: 'check', visible: true } }), ...props }))
  }
  return {
    locale,
    injections,
    storage,
    get tabType() { return tabType },
    get Panel() { return Panel },
    get applyError() { return applyError },
    render,
    /** Hand the recorded `ctx.inject(['locale'])` callback the service. A real
     *  inject callback receives a derived context that keeps the parent's services
     *  *and* injects the requested one, so `scope.locale` is a legal access here. */
    deliverLocale() {
      let delivered = false
      for (const injection of injections) {
        if (!injection.deps.includes('locale')) continue
        injection.callback({ ...base, locale })
        delivered = true
      }
      return delivered
    },
    /** Hand the recorded `ctx.inject(['sidebarRightTabs'])` callback the registry,
     *  modelling a shell that provides it after this entry starts. */
    deliverRegistry() {
      let delivered = false
      for (const injection of injections) {
        if (!injection.deps.includes('sidebarRightTabs')) continue
        injection.callback({ ...base, sidebarRightTabs: registry })
        delivered = true
      }
      return delivered
    },
  }
}

const label = (element) => String(element.props?.children ?? '')
/** The hint a pointer would actually surface: the element's own, or an ancestor's. */
const reachableTip = ({ element, ancestors }) => {
  if (typeof element.props?.title === 'string' && element.props.title.length > 0) return element.props.title
  for (const ancestor of ancestors) {
    if (typeof ancestor.props?.title === 'string' && ancestor.props.title.length > 0) return ancestor.props.title
  }
  return undefined
}

/** A hint that can never appear is not a hint; a px font size ignores the shell. */
function checkRender({ entries, elements }, language) {
  for (const entry of entries) {
    const { element } = entry
    const style = element.props?.style ?? {}
    if (element.props?.title !== undefined && style.pointerEvents === 'none') {
      check(false, `${language}: a title sits on a pointer-events:none ${element.type}; that hint can never appear`)
    }
    const fontSize = style.fontSize
    if (fontSize !== undefined) {
      check(fontSize === 'inherit' || (typeof fontSize === 'string' && fontSize.endsWith('em')),
        `${language}: ${element.type} hardcodes font-size ${JSON.stringify(fontSize)} instead of following the shell`)
    }
    if (element.type !== 'button') continue
    const own = typeof element.props.title === 'string' && element.props.title.length > 0
    const tip = reachableTip(entry)
    check(tip !== undefined, `${language}: button "${label(element)}" has no reachable hover hint`)
    if (element.props.disabled === true) {
      check(!own && tip !== undefined,
        `${language}: disabled button "${label(element)}" carries its own title, which its browser never shows`)
    }
    if (tip !== undefined) {
      check(tip.trim() !== label(element).trim(), `${language}: button "${label(element)}" only repeats its label in the hint`)
      check(tip.length > label(element).length, `${language}: button "${label(element)}" has a hint no longer than its label`)
    }
  }
  for (const entry of entries) {
    if (entry.element.props?.tabIndex !== 0) continue
    check(reachableTip(entry) !== undefined, `${language}: a focusable ${entry.element.type} has no reachable hover hint`)
  }
  const root = entries[0]?.element
  check(root?.props?.style?.fontSize === 'inherit', `${language}: the panel root must inherit the shell font size`)
}

const toolchain = (over = {}) => ({
  ready: true, mode: 'PATH', binDir: '', required: [], optional: [],
  missingRequired: [], missingOptional: [], installHints: [], ...over,
})
const ALL_REQUIRED = ['sway', 'swaymsg', 'grim', 'wtype', 'wlrctl']
const missingBoot = {
  toolchain: toolchain({
    ready: false,
    missingRequired: ALL_REQUIRED,
    missingOptional: ['wayvnc'],
    required: ALL_REQUIRED.map((name) => ({ name, purpose: `host text for ${name}`, required: true })),
    optional: [{ name: 'wayvnc', purpose: 'host text for wayvnc', required: false }],
    installHints: [
      { platform: 'Debian/Ubuntu', command: 'sudo apt install sway grim wtype wlrctl foot wl-clipboard' },
      { platform: 'Other distributions', command: 'install sway, grim, wtype, wlrctl and foot, then make sure they are on PATH' },
    ],
  }),
  sessions: [],
}

/** Ready toolchain that is still missing one optional binary. */
const optionalMissing = toolchain({
  missingOptional: ['wayvnc'],
  optional: [{ name: 'wayvnc', purpose: 'host text for wayvnc', required: false }],
})

const session = mount()
const { locale } = session
check(session.applyError === null, `apply must not throw: ${session.applyError?.message}`)
check(typeof session.Panel === 'function', 'the panel component was not registered')
check(typeof session.tabType?.title === 'function', 'the tab type was not registered')

/* ------------------------------------------------------------- dictionaries */
{
  const dict = locale.entries('dsh-wayland')
  const en = Object.keys(dict?.en ?? {})
  const zh = Object.keys(dict?.zh ?? {})
  check(en.length > 0, 'the client half registered no dictionary')
  check(en.length === zh.length && en.every((key) => key in dict.zh) && zh.every((key) => key in dict.en),
    `en and zh must hold the same keys: en ${en.length}, zh ${zh.length}`)
  console.log(`--- dictionary: ${en.length} keys per language`)
}

/* ---------------------------------------------------------------- English */
{
  const { strings, elements, entries } = session.render({ toolchain: optionalMissing, sessions: [], live: { fps: 20, quality: 82, mediaType: 'image/jpeg' } })
  const text = strings.join('\n')
  for (const wording of ['New', 'Refresh', 'Close', 'Control on']) check(text.includes(wording), `English chrome is missing ${wording}`)
  check(!/\bLive\b|\bCrisp\b/.test(text), `the removed Live/Crisp toggle still renders: ${text}`)
  check(text.includes('No Wayland session yet.'), 'the empty state does not explain itself')
  check(text.includes('mouse and keyboard'), 'the empty state does not say how to take over input')
  check(text.includes('Optional, not found: wayvnc'), 'the ready screen does not list a missing optional binary')
  checkRender({ entries, elements }, 'en')
  check(typeof session.tabType.title() === 'string' && session.tabType.title().length > 0, 'the tab title is empty')
  console.log(`--- English panel chrome: ${elements.filter((e) => e.type === 'button').map(label).join(' | ')}`)
}

/* ------------------------------------------------------------------ 中文 */
{
  locale.setActive('zh')
  const { strings, elements, entries } = session.render({ toolchain: optionalMissing, sessions: [], live: { fps: 20 } })
  const text = strings.join('\n')
  for (const wording of ['新建', '刷新', '关闭', '输入：开']) check(text.includes(wording), `中文界面缺少 ${wording}`)
  check(!/\bNew\b|\bRefresh\b|\bClose\b|Control on/.test(text), `中文界面里残留英文：${text}`)
  check(text.includes('还没有 Wayland 会话。'), '中文空状态文案缺失')
  check(text.includes('接管鼠标和键盘'), '中文空状态没有说明如何接管输入')
  check(text.includes('可选依赖未找到：wayvnc'), '中文就绪状态没有列出缺失的可选依赖')
  check(String(session.tabType.title()).includes('Wayland'), '中文标签页标题异常')
  checkRender({ entries, elements }, 'zh')
  const tips = entries.filter(({ element }) => element.type === 'button').map((entry) => String(reachableTip(entry)))
  for (const tip of tips) check(/[\u4e00-\u9fff]/.test(tip), `按钮悬停简介没有被翻译：${tip}`)
  console.log(`--- 中文按钮悬停简介: ${tips.join(' / ')}`)
}

/* ------------------------------------------- missing dependencies, both */
for (const language of ['en', 'zh']) {
  locale.setActive(language)
  const { strings, entries, elements } = session.render(missingBoot)
  const text = strings.join('\n')
  for (const name of ALL_REQUIRED) check(text.includes(name), `${language}: missing report never names ${name}`)
  for (const name of ALL_REQUIRED) check(!text.includes(`host text for ${name}`), `${language}: the Host's English purpose for ${name} was not translated`)
  check(text.includes('sudo apt install sway grim wtype wlrctl foot wl-clipboard'), `${language}: install command missing`)
  check(language === 'zh' ? text.includes('其他发行版') : text.includes('Other distributions'), `${language}: the generic platform label was not localized`)
  check(!/\{[a-z]+\}/.test(text), `${language}: an interpolation placeholder leaked into the text: ${text}`)
  check(!/(^|\n)(toolbar|missing|empty|hud|purpose|platform|guide|error|stage)\.[A-Za-z]/.test(text), `${language}: a dictionary key leaked into the text`)
  checkRender({ entries, elements }, language)
  console.log(`--- ${language} missing-dependency screen`)
  console.log(text.split('\n').map((line) => `    ${line}`).join('\n'))
}

/* ------------------------ a session is on screen: stage, overlay and badges */
{
  const live = mount()
  live.storage.value = 'w-check'
  live.locale.setActive('en')
  const { entries, elements } = live.render({
    toolchain: optionalMissing,
    sessions: [{ id: 'w-check', name: 'panel 1024x640', width: 1024, height: 640, alive: true, apps: 1 }],
    live: { fps: 20, quality: 82, mediaType: 'image/jpeg' },
  })
  checkRender({ entries, elements }, 'en stage')
  const overlay = entries.find(({ element }) => element.props?.style?.cursor === 'crosshair')
  check(overlay !== undefined, 'the picture overlay is missing while a session is shown')
  check(typeof overlay?.element.props?.title === 'string' && overlay.element.props.title.length > 0,
    'the picture overlay carries no hover hint, so the badge legend is unreachable')
  const badges = entries.filter(({ element }) => element.props?.style?.pointerEvents === 'none' && element.props?.['aria-label'] !== undefined)
  check(badges.length === 2, `both picture badges must expose their meaning as aria-label, found ${badges.length}`)
  for (const badge of badges) {
    check(badge.element.props.title === undefined, 'a pointer-events:none badge carries a title it can never show')
  }
  console.log('--- stage: reachable overlay hint, badges labelled instead of titled')
}

/* ------- the tab registry may arrive after this entry starts (boot order) */
{
  const late = mount({ serviceAtApply: false })
  check(late.tabType === null, 'nothing may register while the tab registry does not exist yet')
  check(late.deliverRegistry(), 'the plugin must ask for sidebarRightTabs through ctx.inject instead of giving up')
  check(typeof late.tabType?.title === 'function',
    'the tab type must register once the registry appears, whatever the entry order')
  check(typeof late.Panel === 'function', 'the tab body must register once the registry appears')
  check(late.applyError === null, `asking for the registry must not fail the entry: ${late.applyError?.message}`)
  console.log('--- late tab registry: registration waits for it instead of giving up')
}

/* ------------- a registration that throws must not fail the client entry */
{
  const broken = mount({ registerThrows: true })
  check(broken.applyError === null,
    `a throw while registering would mark the entry failed and abort the app boot: ${broken.applyError?.message}`)
  check(broken.Panel === null, 'nothing should be registered once the tab type registration threw')
  console.log('--- throwing registration: entry stays alive, the app keeps booting')
}

/* ---------------- a stale dictionary from a previous instance is not fatal */
{
  const stale = mount({ preRegistered: true })
  check(stale.applyError === null,
    `a locale registry that already holds this namespace must not abort apply: ${stale.applyError?.message}`)
  check(typeof stale.Panel === 'function' && typeof stale.tabType?.title === 'function',
    'the panel and its tab type must register even when the dictionary is rejected')
  const { strings } = stale.render({ toolchain: optionalMissing, sessions: [] })
  const text = strings.join('\n')
  check(text.includes('New') && text.includes('No Wayland session yet.'),
    `a rejected dictionary must still render the shipped English: ${text}`)
  check(!/(^|\n)(toolbar|empty|hud|error|missing|stage|purpose)\.[A-Za-z]/.test(text),
    `a rejected dictionary must not leak keys into the text: ${text}`)
  console.log('--- stale dictionary: panel still registers and renders English')
}

/* ------------------------- the locale service arriving after the plugin */
{
  const late = mount({ localeAtApply: false })
  check(late.injections.some((injection) => injection.deps.includes('locale')),
    'the plugin never asks for the locale service, so one mounting later can never reach the panel')
  const before = late.render({ toolchain: optionalMissing, sessions: [] }).strings.join('\n')
  check(before.includes('New'), 'the English fallback should render while the locale service is absent')
  check(late.deliverLocale(), 'no ctx.inject callback carried the locale service')
  late.locale.setActive('zh')
  const after = late.render({ toolchain: optionalMissing, sessions: [] }).strings.join('\n')
  check(after.includes('新建'), 'the panel stayed on the English fallback after the locale service arrived late')
  check(!/\bNew\b|\bRefresh\b|\bClose\b/.test(after), `a late locale service did not translate the chrome: ${after}`)
  console.log('--- late locale service: panel picks it up instead of staying English')
}

if (failures.length > 0) {
  for (const message of failures) console.log(`FAIL ${message}`)
  console.log(`panel check failed: ${failures.length} problem(s)`)
  process.exit(1)
}
console.log('panel check ok: en/zh chrome and dictionary parity, reachable hover hints, shell type scale, late locale service, no Live/Crisp toggle, dependency screen')
