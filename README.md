# dsh-wayland

在 DSH 右栏里嵌入一个**无头 Wayland 桌面**，并给模型一套工具去创建会话、跑 GUI 程序、截图、注入键鼠事件。

本文件描述**现状**（随重大变更更新）。对外可复用的插件参考在
[plugin/README.md](plugin/README.md)（英文，讲依赖/安装/配置/HTTP 接口/限制）；
模型实际看到的工具原文在 [docs/tool-definitions.md](docs/tool-definitions.md)。
工程规范见 [AGENTS.md](AGENTS.md)。

---

## 1. 当前状态

| 项 | 现状 |
|---|---|
| 插件包 | `dsh-wayland` 0.1.0，源码即 [`plugin/`](plugin)；已可按单包发布（`private` 已去掉、有 icon/locale/LICENSE，`npm pack` 11 个文件 60.3 kB），尚未发布 |
| 安装形态 | 作为普通 bundle 装进本机 DSH profile（未发布 npm，所以是 `link:<仓库>/plugin` + `dsh.profile.bundles` 里的一行，`node_modules/dsh-wayland` 是指向仓库的软链），Plugin Manager 中 enabled；profile patch 里只有一条 `- id: dsh-wayland / disabled: false`，没有任何机器路径 |
| 依赖 | 本体只有 1 个 npm 依赖——`pngjs`，锁在 `overlay.js` 的 PNG 编解码里（见 §6）；其余模块零依赖。外部**必需** `sway`/`swaymsg`/`grim`/`wtype`，`wlrctl` 降为**可选**（只在合成器没有虚拟指针协议时兜底）；按 `binDir` → `PATH` 解析；**指针注入默认不用任何外部二进制**——插件自己维持一个会话级虚拟指针（见 §3.3）；**仓库里不含工具链、不含发行版或包管理器配方**；缺依赖不崩，工具与面板都会报缺哪几个、各自干什么、怎么装（见 §3.6） |
| 依赖现状 | **本机（当前系统配置）工具链已就绪**：PATH 上有 `sway`/`swaymsg`/`grim`/`wtype`/`wlrctl`（实测解析到 `/etc/profiles/per-user/kyv/bin/*`），没有配 `binDir`；可选缺 `wayvnc`/`wf-recorder`/`xterm`。插件 `ready`，8 个工具与面板取帧都可用（§9 有本轮实测记录） |
| 工具 | 8 个：`wayland_session_create / _list / _check / _close / launch / windows / screenshot / input`。端到端实测跑通（含图像返回）；工具链就绪时 8 个全部可用，`wayland_check` 兼作依赖与光标主题体检，缺依赖时其余工具按 §3.6 报缺什么 |
| 面板 | 右栏 `wayland` tab：字号跟随侧栏（14px）、en/zh 双语（跟随 DSH 的语言设置）、每个控件都有悬停说明、**没有 Live/Crisp 切换**（帧格式由 `liveMediaType` 决定）。帧/HUD/输入回传已由用户目视确认；工具链就绪时面板显示实时画面（注册状态已用 Client inspect 在实时页面核对，像素仍由用户目视） |
| 实时性 | 默认 Live = JPEG 1:1 q82 @ **20 fps**；本机实测面板循环 19.9 fps、最差帧 46ms、不设限上限 ~31 fps |
| 鉴权 | token 持久化在 `<sessionRoot>/token`（0600），跨插件重载稳定；错误 token 仍 403 |
| 会话 | 全部是临时的：DSH 重启或插件重载（改代码）即被回收 |

运行期目录：会话根默认 `$XDG_RUNTIME_DIR/dsh-wayland`（本机 `/run/user/1000/dsh-wayland`），
每个会话一个子目录，含私有 `run/`（Wayland socket、sway IPC socket、Xwayland）。

---

## 2. 目录结构

```
LICENSE                 MIT（根目录副本；与 plugin/LICENSE 逐字节一致，由 `.probe/check-identity.mjs` 核对）
plugin/                 DSH bundle（源码即安装源，link 安装）
  host.js               Host half：会话管理器 + 依赖探测/报告 + HTTP 取帧/控制服务 + 8 个工具定义（含 `wayland_check` 自检）（约 2000 行）
  pointer.js            会话级持久虚拟指针：手写 Wayland 协议（只用 node 内置），绝对定位 + 按键 + 滚轮（约 350 行）
  overlay.js            截图叠加：PNG 编解码走 `pngjs`（插件唯一的 npm 依赖，只出现在这个文件里）+ 自带的 5×7 位图字体，给 `wayland_screenshot` 的 `grid` 画带坐标标注的标尺（约 190 行）
  client.js             Client half：右栏 tab（逐帧 fetch 循环、HUD、依赖横幅、输入回传）+ **面板全部文案**（内联 `DICT`，49 键 × 中英）
  package.json          bundle 清单：name/icon/files/exports + dsh.bundle.patch + dsh.client
  cordis.patch.yml      插入 dsh-wayland 行（**不含机器相关路径**）
  icon.svg              插件管理页图标（≤256 KiB，manifest 相对路径）
  locale/{en,zh}.json   **只**是插件管理页那张卡片的标题与描述（各 2 个键；DSH 侧 dsh-app-boot 读 `meta`）
  LICENSE               MIT
  README.md             对外参考（英文）
docs/
  tool-definitions.md   模型可见工具原文（由代码渲染，勿手改）
  *-demo*.png           实测截图（工具返回的原始字节）
.probe/
  dsh-tools.mjs         定位正在运行的 DSH 安装（$DSH_TOOLS → 进程的 --app-path → 父进程链）
  check-plugin.mjs      离线校验：把 8 个工具定义喂给真实的 schema 校验器（不需要任何工具链）
  check-identity.mjs    离线校验：包名 / client.js 注册 id / patch 行名三处一致，且包可发布
  check-degraded.mjs    离线校验：工具链全缺 / 部分缺 / 齐全三种情况下的降级与报告，以及 `wayland_check` 的自检形状（含"什么都没解析出来时不许报 ok"）
  check-panel.mjs       离线校验：用迷你 React 把面板组件树渲染出来，断言中英双语与字典键齐平、**悬停说明可达**、**跟随宿主字号**、locale 迟挂载、字典被拒/注册抛错都不致命、无 Live/Crisp；`DSH_WAYLAND_CLIENT=<file>` 可改测服务端实际提供的那份字节
  check-pointer.mjs     离线校验：用一个假合成器（unix socket）断言 pointer.js 的握手、报文与**只读能力探测**（不建设备）——只建一个持久虚拟指针、move 用 motion_absolute 带字面像素与 extent、click 是先按后放的 BTN_LEFT、滚轮带 axis_source、destroy 回收、缺协议时明确报错
  check-input.mjs       离线校验：`wayland_input` 的 10 个变体（required/properties 逐条钉死）与 9 条报错文案，并断言"校验先于会话查找"
  check-launch.mjs      离线校验：`wayland_launch` 的结果契约——四种 outcome 必须渲染成四句不同的话（exited 点名退出码与日志、timeout 说明进程还在跑），"没有 shell" 只写在 `command` 参数上；并对着**真实 `/proc` 树**钉住"哪个窗口算这次启动的"（任意深度的子进程、只有一个新窗口时才认领、已有窗口绝不认领）
  check-cursor.mjs      离线校验：光标主题——配置的主题与尺寸写进生成的 sway.conf、装不上的主题要如实报 warn（并说明会退回 sway 自带光标）、自动探测结果与配置文件必须一致、`wayland_check` 带 cursor 行、截图描述写明指针就在图里
  render-tools.mjs      重新渲染 docs/tool-definitions.md
```

仓库里**没有**工具链目录、没有包管理器配置、没有发行版相关的安装脚本：插件只认
「PATH 上有 `sway`/`swaymsg`/`grim`/`wtype`/`wlrctl`」或「`config.binDir` 指向一个含它们的目录」。
本机这套工具链在仓库外（Nix per-user profile，`/etc/profiles/per-user/kyv/bin`），
直接经 PATH 解析，profile 里没有任何 `binDir` 覆盖行。

---

## 3. 它是怎么工作的

### 3.1 一个"会话"是什么

每个会话 = 一个 headless sway 实例 + 私有 `XDG_RUNTIME_DIR`（`<sessionRoot>/<id>/run`）
+ 自己的 `wayland-1` socket + 自己的 Xwayland。程序由插件**直接 spawn**（不是 `swaymsg exec`），
这样能拿到 pid 与退出码，并按 pid 把窗口和命令对应起来。

### 3.2 必须遵守的环境规则（都是踩出来的）

- sway 的 IPC socket 名形如 `sway-ipc.<uid>.<pid>.sock`，插件**扫描 runtime 目录**去找它，
  不用 spawn 的 pid 拼路径：发行版的 `sway` 包装脚本可能 `exec` 一个中间进程
  （`dbus-run-session` 之类）再由它 fork 合成器，此时 socket 里的 pid 不是我们 spawn 的 pid。
  **本机实测属于"pid 保真"那一类**（包装脚本直接 `exec` 合成器，socket 名里的 pid 就是 sway
  的 pid，其 ppid 就是 DSH 进程），但这个前提换发行版/换包装脚本版本就不成立，所以保留扫描。
- **不能给 sway 传空的 `SWAYSOCK`**：空值会让它干脆不创建 IPC socket（表现为 20s 超时）。
- Xwayland 的 `:N` 通过扫描 `/proc/*/stat` 按**进程组**匹配获得（wrapper 会让 Xwayland 被
  重新挂到别的父进程下，按 ppid 匹配不可靠）。
- 给**被启动的程序**显式设置 `DBUS_SESSION_BUS_ADDRESS` 指向用户总线：wrapper 给 sway 自己的
  子进程用的是私有总线，而我们要让程序用共享总线（portal、文件对话框、按 pid 过滤的 dbus 监听）。

### 3.3 取帧与注入

- `grim` 逐帧抓取（`-o` 与 `-g` 互斥，按窗口裁剪时不能带 `-o`）。
- 面板是 **JS 顺序 fetch 循环**（不是黑盒 MJPEG），因此能显示真实 fps/延迟/帧大小并检测卡死；
  `/stream` 的 MJPEG 接口保留给其它消费者。
- 注入：`wtype` 打键盘（用 `-s` 覆盖客户端 focus 握手，否则首字会丢）、指针走会话自己的
  **持久虚拟指针**（`pointer.js`，见下）、非 ASCII 文本走 `wl-copy` + Ctrl+V 粘贴
  （`wl-copy` 会 fork 出后台进程持有剪贴板，不能等它的 stdio 关闭）。

指针为什么不是"一个动作一个进程"（本轮实测踩出来的，也是这套接口现在最重要的约束）：

- `wlrctl pointer click` 每次都新建一个虚拟指针、发完按键就退出。设备销毁时合成器会清掉
  seat 的指针 focus，而 wlroots 在 `pointer_state.focused_client` 为空时**直接丢弃**按键
  事件 —— 结果是：移动生效、**click 永远不生效**，而工具还回一句"已注入 N 个动作"。
  实测证据：Tk 窗口的 `<ButtonPress>` 从不触发；`bindsym --whole-window button1` 却会为
  每一次 `wlrctl` 点击触发（说明 sway 收到了按键，只是没有送达客户端）；只要另开一个长命
  虚拟指针挂着，同一句 `wlrctl pointer click` 立刻就能送达。
- `wlrctl pointer move` 只有**相对**位移，而 headless sway 的光标**不是**从 (0,0) 开始：新会话
  的指针设备一挂上，第一次 `enter` 报的位置就是输出的中心（1280x800 实测 640,400）。插件当年
  以为起点是 (0,0) 并按差值移动，于是第一击整体偏掉。绝对坐标必须由位置本身承载，不能靠累计差值。
- 所以 `pointer.js` 每个会话只开**一个** `zwlr_virtual_pointer_v1`，一直挂着，用
  `motion_absolute`（x/y 就是会话像素、extent 就是会话尺寸）、`button`、`axis` 注入；
  每条命令后跟一次 `wl_display.sync`，因此工具返回时合成器已经处理完了——紧接着截图不会
  拍到"还没生效"的画面。
- 合成器没有 `zwlr_virtual_pointer_manager_v1` 时（sway/wlroots 一直提供）降级顺序是
  `swaymsg seat <seat> cursor set` 绝对挪光标 → 相对 `wlrctl`；这条降级路径下 click 仍可能
  丢，属于已知限制（见 §10）。

**截图里的指针**（本轮加的；三条都是实测，不是推断）：

- **必须带 `-c`。** grim 的 `-c` 就是新协议的 `PAINT_CURSORS`，wlroots 收到后
  `wlr_output_lock_software_cursors()` 把这一帧强制改为软件光标。headless 输出平时挂着一个
  **硬件光标**（`sway -d` 日志：`Enabling hardware cursors on output 'HEADLESS-1' (locks: 0)`），
  而后端根本没有平面去合成它——所以**不带 `-c` 时指针永远不会出现在抓帧里**，换哪个主题都一样。
  实测：只给旧代码加 `-c`（其余不变），两个不同指针位置的截图从**逐字节相同**变成各自在指针处
  出现精灵；代价 800x600 JPEG q82 从 15.29 ms/张变成 15.99 ms/张（+0.7 ms，20 fps 预算 50 ms）。
- **指针设备必须存在。** sway 只在 seat 拿到指针能力那一刻加载光标图形，而能力来自指针设备；
  所以会话**创建时**就连上持久虚拟指针（而不是等第一次 `wayland_input`），否则"还没有任何输入"
  的会话抓帧里 0 个指针像素。实测：创建后立刻截图，指针在停放点（会话中心 300,200）出现，
  228 个非背景像素、bbox (298,198)-(312,220)；`wayland_input` move 到 (120,300) 后精灵跟过去，
  旧位置不留残影；窗口裁剪 `-g` 路径同样含指针（两次不同位置的窗口截图差异覆盖两处）。
- **主题只决定"画成什么样"。** 生成的 sway.conf 里写 `seat * xcursor_theme <theme> <size>`
  （`cursorTheme` 显式指定，空则自动探测本机第一个真带 `cursors/left_ptr` 的主题）；一个都找不到
  时 wlroots 有自己的内建 fallback（`wlr_xcursor_theme_load`：`cursor_count == 0` 时
  `load_default_theme`），所以退化成"较小的自带箭头"，**不是没有指针**——`wayland_check` 的
  cursor 行就是照这个口径写的。停放点的选择同理：`session.pointer` 以前一直记 (0,0)，而合成器
  实际在输出中心，创建时显式 move 到中心后，记账和图里的精灵才对得上。
  实测截图见 [docs/cursor-demo.png](docs/cursor-demo.png)：窗口裁剪路径下 terminal 里的 I 形文本光标，
  右下角红框是放大示意（截图本身是 `wayland_screenshot` 原样产物加注释）。

### 3.4 鉴权

- token 持久化在 `<sessionRoot>/token`（0600），插件重载时复用 → 已打开的页面不会突然 403。
- 注入到页面 `window.__DSH_WAYLAND__`；另有 `GET /boot`（免鉴权但跨源读不到响应）供客户端现取。
- 其它所有路由要求 `x-dsh-wayland-token`（或 `?token=`）。客户端遇 401/403 会重新取 token 并**重放一次**。

### 3.5 模块缓存（改代码时最容易踩的坑）

Host 进程把插件模块缓存到进程结束：**已安装的 bundle 行改了代码不会生效，必须重启 DSH**。
插件本身不会往 profile 里塞任何东西——普通用户的 profile 只有 `- id: dsh-wayland / disabled: false`
这一行。**只有在你改这个插件的代码时**才需要一条指向工作副本的开发行（路径换成自己仓库的位置）：

```yaml
- id: dsh-wayland
  disabled: true          # 见下面那条：bundle 行会挡住开发行
- insert:
    - id: dsh-wayland-dev
      name: "file:///abs/path/to/dsh-wayland/plugin/host.js?v=N"   # 换 id + 换 ?v= 才会拿到新模块
- id: dsh-wayland-dev
  disabled: false
```

插件内有进程级互斥（`Symbol.for('dsh-wayland.host.applied')`）：同进程重复挂载时后来者直接退出。
**这条互斥决定了"谁先挂载谁生效"**——bundle 行由 bundle 层先插入，于是开发行通常会被它挡住，
结果是开发行的新代码根本不执行（实测踩到过：改了 `host.js`、换了 `?v=`，工具输出的还是旧文案）。
所以开发期把 bundle 行 `disabled: true`，让开发行成为唯一实例；**重启 DSH 后再把 bundle 行改回
`disabled: false`、删掉开发行**，之后改代码又要重新走一遍"开发行 + 新 `?v=`"。不写代码的人不需要
这一节，只要重启 DSH 就能拿到新版本插件的代码。

> 顺带三条实测事实：
> 1. 改 profile patch 后，DSH 的 HMR 会就地挂载/卸载插件行（不重写 profile 目录里的
>    `cordis.yml`，那是启动时的组合快照），面板半边要**刷新页面**才拿到新的 `client.js`。
> 2. **`client.js` 不走 Host 的模块缓存**：客户端 bundle 由 `client-modules` 按文件元信息算出
>    `rev` 后提供——实测改完文件，旧 rev 返回 404、新 rev 返回 200，且字节与磁盘逐字节一致
>    （只多一行 `//# sourceMappingURL` 尾注）。上面"必须重启 DSH"说的是 `host.js`，它走 Host
>    进程的模块缓存，只有重启（或开发行换 `?v=`）才会换。
>    **但组合会滞后**：实测出现过"新 rev 也 404"的窗口（组合还停在改动前），此时刷新页面只会
>    拿到旧字节，**必须先重挂插件行**（Plugin Manager 里 disable→enable，或
>    `remove_bundle` → `install_bundle`）再看 rev 是否 200，然后刷新页面。
> 3. **`pointer.js` 走带 mtime 的动态 import**：`host.js` 用
>    `import(new URL('./pointer.js', import.meta.url) + '?mtime=…')` 加载它，所以开发行换 `?v=`
>    重挂时，改过的 `pointer.js` 也会跟着换（旧写法是普通相对 import，URL 恒定，改这个文件只能
>    重启 DSH——本轮实测踩到：`press` 明明写好了，运行时却报 `vptr.press is not a function`）。
> 4. **只换 `?v=`、不换行 id 不会重挂**（本轮实测连踩两次）：开发行的 `id` 保持
>    `dsh-wayland-dev`、只把 `?v=4` 改成 `?v=5`/`?v=6`，HMR 没有任何动作，工具还是旧模块——
>    **每次都要换 id**（`dsh-wayland-dev7` …）或者把这一行删掉再加回来；这也是本文件上面那句
>    "换 id + 换 `?v=`"的实测依据。
> 5. 开发行（`dsh-wayland-dev` → `file://…/host.js?v=1`）挂上后，HMR 就地换掉了模块——同一会话里
>    `wayland_session_list` 立刻改口（`wlrctl` 从必需变成可选），**不需要重启 DSH**；收尾时删掉
>    开发行、把 bundle 行 `disabled` 去掉即可。

### 3.6 依赖解析与降级（缺依赖不崩）

解析顺序固定为 **`config.binDir` → `PATH` 逐目录**，只做 `existsSync` 判定（不查可执行位、
不校验版本）。结果在"必需项齐全"时缓存 5 秒；**只要有必需项缺失就每次重新探测** —— 所以
装完二进制再调一次工具即可，不必重载插件。

必需 4 个：`sway`（合成器）、`swaymsg`（IPC）、`grim`（截图/取帧）、`wtype`（键盘）；
可选 6 个：`wlrctl`（指针降级：只在合成器没有 `zwlr_virtual_pointer_manager_v1` 时用）、
`wl-copy`（非 ASCII 粘贴）、`foot`（面板默认终端）、`wayvnc`/`wf-recorder`（预留）、
`xterm`（花屏，仅保留兼容）。每一项都带一句"用途"，
因为报告里要说的正是这个。表在 `host.js` 的 `BINARIES`。

缺必需项时**插件照常加载**，同一份报告从四个出口给出（已经在跑的会话不受影响：合成器进程早已启动，
工具链变化只影响**新建会话**和**取帧/截图**——`grim` 找不到时面板就取不到新帧）：

| 出口 | 内容 |
|---|---|
| 启动日志 | 缺谁、各自用途、`binDir` 当前值，以及 Debian/Fedora/Arch + "其他发行版"四条安装行 |
| `wayland_check` | 永远成功；返回 `toolchain`（ready / mode / binDir / 已解析项与来源 / missingRequired / missingOptional）+ **已解析的二进制用无副作用探针跑一遍** + `sessionRoot` 是否可写 + 每个会话一行体检（合成器 / IPC / Xwayland / 指针协议） |
| 需要工具链的工具 | `create`/`launch`/`windows`/`screenshot`/`input` 抛出的错误文本就是这份报告；没有会话时调 `windows` 之类的工具，只要工具链也缺就报依赖而不是 `unknown session` |
| 面板 | 缺哪些、为什么、去哪里装；只缺可选时降级成一行提示 |

`wayland_launch` 找不到可执行文件时也报"没找到 + 在 `binDir`/`PATH` 找过"，而不是留一行
ENOENT。以上三种工具链状态（全缺/部分/齐全）都有离线校验，见 §9。

### 3.7 面板（右栏 tab）

- 注册方式：`sidebarRightTabs.register({ id, kind:'wayland', title, guide })` + 往
  `sidebar.right.pane.tab` 插槽注册组件。注意 `title(address)` 是**开 tab 时取值**（面板
  id 是 `dsh-wayland`，两种语言的标题恰好都叫 "Wayland"，所以这里不受影响）。
- **文案写在 `client.js` 的内联 `DICT`**（`const DICT = { en: {...}, zh: {...} }`），不是
  `locale/*.json`——那个文件只服务插件管理页的卡片。原因：client half 是单个
  `__ModuleLoader__.load({id, factory})` bundle，运行时读不到包内文件；出厂 client 插件
  （如 `dsh-client-ui-sidebar-browser`）同样把字典内联在 bundle 里、包内没有 `locale/` 目录。
  **49 个键，两边键集必须一致**（`check-panel.mjs` 会核对）。
- **locale 服务是"问到"而不是"要求"**：`inject` 里只有必须存在的服务，locale 先用
  `ctx.get('locale')` 同步取，再用 `ctx.inject(['locale'], …)` 兜住"插件先挂载、服务后到"
  的情况；每次语言切换或服务迟到都会通知已挂载的面板重渲染（`seat.watchers`）。
  两者都没有时退回内置英文表，面板照常显示。
- **i18n 永远不能拖垮面板**（实测踩到过）：真实 locale 注册表对"同一 namespace + 同一语言"
  的重复注册会 **throw**——热重载后旧实例的字典还在注册表里就会命中。所以 `apply()` 现在
  **先注册 tab 类型与插槽，最后才做 locale 接线**，且注册沿用 `try/catch` + 每实例只注册一次
  （`copyRegistered`）；注册失败只降级为英文并留一条 console 警告。此前顺序反了：那句 throw
  打断了 `apply`，面板整块不再注册，表现为"wayland tab 直接消失"。
- 另外 `translate` 在 `locale.bind` 查不到键时（旧字典残留）**回退到内置英文**，绝不把
  `toolbar.new` 这种键名当文案显示出来。
- **`apply()` 抛错会拖垮整个 app 启动，所以它被整体包了 guard**（实测踩到过）：渲染端的
  启动检查会遍历所有 client entry，只要有一个 fiber 不是 `active` 就
  `throw new Error('web boot: N entry did not activate')`——`dsh-wayland: failed` 就是这么来的，
  结果是**整个浏览器界面起不来**，而不是少一个 tab。前端那段判定是：fiber 不存在 →
  `import failed`；状态 `pending` → 等某个服务；`failed`/`disposed`/`unloading` 也就地报错。
  因此 `apply()` 现在只做一件事：`try { registerPanel(ctx) } catch { console.error(…) }`，
  注册失败的代价降到"少一个 tab + 一行 console 错误"，app 永远能启动。
- **拿服务只能用 `ctx.get(name)` / 注入后的 scope，绝不用 `ctx.name`**（实测，用户控制台给出的
  原话：`Error: cannot get property "sidebarRightTabs" without inject`）。DSH 客户端运行时是
  **严格服务访问**：对没写进本插件 `inject` 的服务做属性访问会**抛错**，而不是返回 undefined。
  这一条踩了两次：(a) locale 与 sidebarRightTabs 都只声明了 `slots`，代码里用
  `ctx.get('…') ?? ctx.…` 兜底，运行到 `??` 右侧就抛；(b) 抛点又正好在注册之前，于是"app 能启动、
  右栏没有 wayland"。现在两处都只用 `ctx.get`，并且用 `ctx.inject([...], scope => …)` 在
  scope 内部访问服务（那里是声明过的，合法）。
- **tab 注册表要"声明式等待"**：shell 用 `ctx.reflect.provide('sidebarRightTabs', …)` 提供它
  （不在 Service 目录里），而启动顺序里它可能还没到。所以先 `ctx.get` 试一次，再用
  `ctx.inject(['sidebarRightTabs'], …)` 等它出现、出现即注册；出厂 client 插件把这个名字写进
  静态 `inject` 是同一个道理。
- **面板只翻译它自己给人的话**：Host 依赖报告里每个二进制的用途/发行版标签按稳定的
  `purpose.<name>` / `platform.*` 查表（查不到才回退 Host 英文原句），发行版命令行
  **原样保留**（`sudo apt install …` 译了反而不能用）；Host 的报错原文也是英文，面板只翻译
  包在外面的那句（`error.request`），因为同一段 Host 文案还要给模型看。
- **字号与控件尺寸跟随宿主，不写死**：根节点 `font-size: inherit`，其余层级（次级 0.93em、
  HUD 0.86em、控件高 2.14em、内距 0.57em…）全部用 `em`——因为面板是**宿主侧栏里的 chrome**，
  侧栏正文 14px，写死 14/13/12 会让面板成为唯一不跟宿主缩放的表面。仍然**不用**"会话内容
  字号"那个设置（它只管对话内容）。
- **悬停说明必须"可达"**：`title` 放在**包裹元素**上而不是按钮自己身上——`disabled` 的表单
  控件不参与浏览器命中测试，自带 `title` 的 New/Refresh/Close 恰好在你最想了解它们时（无会话
  / 请求在飞）什么都不弹。画面上的两个 HUD 角标是 `pointer-events: none`（不能让拖拽落在
  它们身上），因此不挂 `title`，改成 `aria-label`，把指标图例放在可悬停的画面覆盖层上。
  `check-panel.mjs` 断言的就是"可达"，不是"有属性"。
- **帧循环**：一次请求一帧（不是黑盒 MJPEG），所以能显示真实 fps/耗时/帧大小并检测卡住；
  帧格式与帧率只由 Host 的 `liveFps`/`liveQuality`/`liveMediaType` 决定，面板不再提供切换。
- **画面缩放现状（已知取舍）**：面板按面板物理像素建会话（`cssWidth × devicePixelRatio`，
  上限 1920），在 1.75 缩放的屏幕上这意味着画面以约 57% 显示（本机实测 1726 物理像素 →
  约 986 CSS px 栏宽）。要 1:1 就得让客座按逻辑像素渲染（sway output scale = dpr），
  那会牵动坐标语义（sway IPC 是逻辑像素、grim 是物理像素），目前**未做**。

### 3.8 截图给模型看：`region`、`scale` 与坐标网格

`wayland_screenshot` 原本只产出"整屏一张图"，模型要在这张图里**猜**一个格子或按钮在哪。猜错一次
就是一轮截图，比省下的那点文字贵得多。所以本轮加的两件事都挂在已有工具的参数上，不新增工具
（AGENTS.md：能用一个参数覆盖的，就不要新增工具）：

- **`region`**：任意矩形，会话像素、绝对坐标。`capture()` 本来就在用 `grim -g`（窗口裁剪走的就是它），
  只是被 `win.rect` 独占；现在优先级是 `region` > `window` > 整屏。越界是**裁剪**而不是报错
  （"从这儿到角落"是常见说法），并且抓完会用**真实回来的像素**重新量宽高，所以裁剪永远不会让标尺错位。
- **`grid`**：每 N 会话像素画一条标尺，每条线**标上它所在的会话坐标**——x 在顶边、y 在左边。
  模型读到数字直接交给 `wayland_input`，不做算术、不从图上估位置。
- **`scale`**：现在允许 > 1（此前只当缩小用）。**先放大再画线**：标尺由插件在 `grim -s` 之后画进像素，
  所以线在放大图里依然锐利（并按整数倍加粗）、标注清晰，而**标注值始终是 `wayland_input` 认的那个坐标**。

返回里因此多了 `origin`（图像左上角的会话坐标）与 `scale`，两者的契约是一行：
`会话坐标 = origin + 图像像素 / scale`。

实现落在新的 [`plugin/overlay.js`](plugin/overlay.js)：PNG 编解码改用 **`pngjs`**——插件唯一的
npm 依赖，只出现在这个文件里；上面那个 5×7 位图字体和绘图逻辑仍然是自己的（pngjs 是编解码器，
不是画布）。它像 `pointer.js` 一样按 mtime 加戳后动态导入，改完不必重启 DSH。

**为什么允许这一个依赖**（原来自带 ~185 行手写编解码，只覆盖 grim 的 8-bit RGB/RGBA）：
pngjs 解出来的 RGBA 与**独立的 Pillow 解码**在 6 种格式上逐字节相同——包括手写版直接拒绝的
palette、隔行与 16-bit，所以这是纯粹的覆盖面扩大，没有行为回退。代价是编码变慢、收益是文件更小；
两者都按下面的实测取舍，详见 §6。

**本机实测**（`.probe/check-screenshot.mjs`，真 sway + 真 grim，28 条断言全过）：

| 调用 | 实测结果 |
|---|---|
| 整屏，无网格 | 1280×800，`origin [0,0]`、`scale 1`，仍是部署配置的 JPEG |
| `region {20,30,200,120}` | 报 `origin [20,30]`；JPEG 的 SOF 标记实测正是 200×120（grim 真按矩形出图） |
| `region {0,0,200,120}, grid 50` | **强制 PNG**；竖线实测落在图 x=0/50/100/150，横线落在 y=0/50/100 |
| `region {37,11,120,80}, scale 2, grid 50` | 图 240×160；会话 x=50/100/150 落在图 x=26/126/226，即 `(x-37)×2` |
| `region {400,280,500,500}`（越界） | 不报错，裁成 80×40，`origin` 仍是 `[400,280]` |

离线那半边在 `.probe/check-overlay.mjs`：10 张**真实 PNG 字节**（内嵌 base64，覆盖全部 5 种滤波器 +
RGB/RGBA，以及手写版会拒绝的 palette/隔行/16-bit）解码后逐像素比对，每个 fixture 都是
`pixel(x, y)` 的无损编码，所以同一个判定公式就能覆盖全部；外加编码往返、3 条坏输入必须报错、
scale 1/2 两种落点、3 条 `grid` 参数拒绝路径。把这份校验指向被替换掉的手写编解码器，会精确地红在
palette / 隔行 / 16-bit 这三条上（`FAILURES=3`），新用例是能区分新旧实现的。

留档：整屏 + `grid 100` 见 [docs/screenshot-grid-demo.png](docs/screenshot-grid-demo.png)；
`region {170,200,420,300}` + `scale 2` + `grid 50` 见
[docs/screenshot-grid-zoom-demo.png](docs/screenshot-grid-zoom-demo.png)——那张图上的 200…550
全是真实屏幕坐标，线是先放大后才画的。

**取舍**：`grid` 要改像素，所以会强制 PNG；`screenshotMediaType: image/jpeg` 的部署在带网格时拿到 PNG。
这是有意的——宁可换格式，也不返回一张没有标尺、却被模型当成有标尺的图。schema 总量
9509 → 10824 字符（每轮多约 330 tokens），换掉的是一类"猜坐标、猜错重来"的往返。

**没做**：网格自动检测。识别"这里有个表格/棋盘"是图像处理工具的活，不属于一个截图工具；模型自己
知道该用 50 还是 100，而给它一个可能判错的自动检测，只会新增一个错误来源。

---

## 4. 性能实测（Ryzen 7 5800H；无 `/dev/dri`，pixman 软渲染）

| 内容 | 格式 | 大小 | 单帧耗时 |
|---|---|---|---|
| 纯文字终端 1600x1000 | PNG 1:1 | 7–30 KB | ~70 ms |
| 纯文字终端 1600x1000 | JPEG 1:1 q82 | 44 KB | ~36 ms |
| btop 动画 1600x1000 | PNG 1:1 | 271–308 KB | ~96 ms |
| btop 动画 1600x1000 | JPEG 1:1 q82 | ~229 KB | ~32 ms |

面板同款循环（20 fps 目标、btop + konsole、5 秒）：`100 帧 / 19.9 fps / 最差 46 ms / 0 帧超预算`。
不设限上限 ~31 fps。**PNG 只是对纯色/文字内容更小**，图形密集时反而更大 —— 这正是默认用 JPEG、
把 PNG 做成部署级配置项（`liveMediaType`）而不是面板里一个切换按钮的原因。

---

## 5. 模型可见的工具

8 个工具，见 [docs/tool-definitions.md](docs/tool-definitions.md)（由 `.probe/render-tools.mjs`
从代码渲染）。合计 10824 字符 schema ≈ 2.6k tokens（`wayland_session_list` 只列会话，**诊断全部归 `wayland_check`**：每个工具的描述只讲一件事；后续几轮去重把总量压到比拆分前还低，`region`/`grid` 那轮回涨约 1.3k 字符，见 §3.8）。
措辞原则：**描述必须与实现逐条对得上**——坐标系（`scale` 会改变像素↔坐标的换算）、返回时机
（指针动作返回时合成器已处理）都写在模型要读的那段里；**失败方式不写进描述，由报错本身说**
（关一个已关闭的 id 会报错；非法载荷在发出任何事件前就被拒掉，报错点名第几条、哪个字段；
跑一半失败则回报已应用了几条）；实现支持但 schema 没声明的旋钮不留
（曾经的 `delayMs`/`waitMs` 要么声明要么删掉；截图格式/质量、键盘前导与逐键间隔统统下沉到部署配置）。

`wayland_input` 的形状是**一张表驱动两处**：`host.js` 里的 `DIRECTIVES` 同时生成模型看到的
`oneOf` schema 和运行时校验，所以文档、schema、报错不会互相漂移；渲染器遇到 `oneOf` 会为每个
变体出一张子表（否则文档就成了残缺的渲染产物）。结构是 **6 个原语**（move / press / release /
scroll / wait / raise）+ **4 个糖**（click / drag / type / key，语义被定义为原语的精确组合）；
坐标是 `[x, y]` 元组，和弦写成一个字符串（`ctrl+shift+t`），窗口只认 id。
设计规则：描述自带「是什么 / 何时用与不用 / 返回什么」；默认值、单位、id 来源写在参数上；
边界写清（例如 `wayland_launch` 明确"跑 shell 命令请用 bash 工具"）。
`wayland_session_list` 兼作 **doctor**：它永远成功，并带上工具链报告，所以工具描述里明确
写了"别的工具报缺依赖时就来调它"——这样模型不需要为"查依赖"多背一个工具的 schema。

---

## 6. 依赖与安装

包本体只有 **1 个 npm 依赖：`pngjs`**（写在 `package.json` 的 `dependencies` 里），而且只被
[`plugin/overlay.js`](plugin/overlay.js) 的 PNG 编解码用到；`host.js` / `pointer.js` / `client.js`
仍然只用 node 内置模块。需要另外准备的是**外部 wlroots 工具链**，默认走 PATH，也可以用
`binDir` 钉住一个目录。

**为什么是 pngjs、代价多少**：`grid` 要往像素里画线，就需要一个 PNG 编解码器。原来自带 185 行
手写实现，只覆盖 grim 的 8-bit RGB/RGBA；pngjs 解出的 RGBA 与**独立 Pillow 解码**在 6 种格式
上逐字节相同，并额外支持 palette / 16-bit / 隔行。本机实测（node v24.21.0，1280×800 的一帧
UI 类画面，15 次均值）：

| 环节 | 手写编解码 | pngjs | |
|---|---|---|---|
| 解码 | 14.0 ms | 13.5 ms | 持平 |
| 编码 | 17.4 ms | 55.0 ms | 慢 3.2× |
| `grid` 一整趟（解码 + 画线 + 编码） | 31.8 ms | 75.0 ms | **+43 ms** |
| `grid` 输出的 PNG | 27.2 KiB | 11.6 KiB | **小 57%** |

即每次带 `grid` 的截图多花约 43 ms（grim 抓图本身远不止这个量级），换来发给模型的 base64
小一半多；两种实现画出的网格像素逐字节一致。数字取自 UI 类合成画面，纯噪声图上 pngjs 的逐行
自适应滤波反而更大（+111%），但真实截图不是噪声。

本仓是 link 安装的插件源，所以**克隆后要在 `plugin/` 里跑一次 `npm install`**（`node_modules/`
已 gitignore，发布物由 `package.json` 的 `files` 决定、不含它）：

```sh
cd plugin && npm install          # 装 pngjs；发布成 npm 包时由 npm 正常解析，无需这一步
```

安装工具链（普通发行版就这一步，装完即在 `/usr/bin` 等标准位置）：

```sh
sudo apt install sway grim wtype wlrctl foot wl-clipboard   # Debian/Ubuntu
sudo dnf install sway grim wtype wlrctl foot wl-clipboard   # Fedora
sudo pacman -S sway grim wtype wlrctl foot wl-clipboard     # Arch
```

任何发行版都可以自己决定工具链从哪来（发行版包、自编译、任意目录）——插件只要求
`sway`/`swaymsg`/`grim`/`wtype` 能通过 PATH 找到，或者被 `binDir` 指到（`wlrctl` 可选，
只是没有虚拟指针协议时的指针降级；上面的安装行仍然带着它，装上不亏）。
"GUI 启动的应用看不到 shell profile 里的 PATH"这类通用坑写在
[plugin/README.md](plugin/README.md)。本机这套工具链放在仓库外（Nix per-user profile），
经 PATH 解析、没有覆盖行；下面这种写法只在需要钉住某个目录时才用：

```yaml
# 可选：profile 的覆盖行（机器相关，不进仓库；不写就是走 PATH）
- id: dsh-wayland
  disabled: false
  config:
    binDir: /abs/path/to/toolchain/bin
```

安装插件本体有两种方式：本地目录用 Plugin Manager 的 `install_bundle` 指向本仓库的 `plugin/`；
发布之后是 `dsh plugin --profile <profile> add dsh-wayland`。
发布前请先跑 `node .probe/check-identity.mjs`（包名 / client id / patch 行名三处必须一致，
否则面板半边会静默加载失败）。

**重装要先卸载。** `install_bundle` 对"已经装好、spec 又完全相同"的 bundle 会走
`installed.length !== 1` 分支报 `ambiguous-install`——pnpm 层其实只回一句 `Already up to date`，
profile 文件一个字都不改，所以那不是真重装。实测可行的重装是
`remove_bundle dsh-wayland` → `install_bundle link:<仓库>/plugin`：卸载会立刻注销 8 个工具、
回收所有会话（`sessionRoot` 只剩 `token`），重装后工具与面板都重新注册；token 因为是
复用文件而不变，页面里的面板不需要重新取 token（但 `client.js` 有改动时仍要刷新页面，见 §3.5）。

---

## 7. 配置项（在 patch 的 `config:` 下）

| 键 | 默认 | 含义 |
|---|---|---|
| `binDir` | `''`（纯 PATH） | 先在这里找二进制，找不到再按 PATH 逐目录找；机器相关，应写在 profile 覆盖里而不是包自带的 patch 里 |
| `sessionRoot` | `$XDG_RUNTIME_DIR/dsh-wayland` | 会话运行期目录根 |
| `width` / `height` | `1280` / `800` | 默认屏幕尺寸 |
| `liveFps` | `20` | 面板帧率 |
| `liveQuality` | `82` | 面板 JPEG 质量 |
| `liveMediaType` | `image/jpeg` | 面板帧格式（`image/jpeg` / `image/png`）；面板里没有格式切换按钮，要 PNG 就改这里 |
| `streamFps` / `streamScale` / `streamQuality` | `10` / `0.6` / `70` | 独立 MJPEG `/stream` 接口 |
| `screenshotMediaType` | `image/png` | 模型工具截图用哪种格式（`image/png` / `image/jpeg`）。**不是工具参数**：模型不选格式，部署者选。带 `grid` 的调用是例外，一律返回 PNG，因为标尺要画进像素（§3.8） |
| `screenshotQuality` | `85` | 上面选成 `image/jpeg` 时的质量。同样只是部署项 |
| `inputLeadMs` / `inputKeyDelayMs` | `60` / `20` | 虚拟键盘等首次按键前的焦点握手时间、逐键间隔 |
| `cursorTheme` | `''`（自动探测） | 指针图形用哪个 xcursor 主题。空 = 取本机第一个真的带 `cursors/left_ptr` 的主题；一个都找不到时 sway 用自带的较小 fallback 光标 |
| `cursorSize` | `24` | 指针图形像素尺寸（8–512） |
| `maxSessions` | `6` | 并发会话上限 |
| `defaultApp` | `foot` | 面板 "New" 按钮启动的程序 |

---

## 8. HTTP 接口（面板在用）

- `GET /dsh-wayland/boot` — 免鉴权、同源可读：`{token, base, live, sessions, toolchain}`
  （`toolchain` 即 §3.6 的结构化报告，面板横幅直接用它）
- `GET /dsh-wayland/frame?session=&mediaType=&scale=&quality=` — 一帧；`X-Frame-At` 带时间戳
- `GET /dsh-wayland/stream?session=&fps=&scale=&quality=` — MJPEG 多部分流
- `POST /dsh-wayland/api` `{method, params}` — `sessions.list/create/close`、`apps.launch`、
  `windows.list`、`input`、`screenshot`（需 token）。`input` 的 `params` 就是工具那套：
  `{session, window?, actions:[{do, ...}]}`（面板的鼠标/键盘回传走这里，见 §5 的指令表）

注意：`/frame` 支持 `mediaType` 与 `scale`，但**不支持按窗口裁剪**（只有工具支持 `window`）。

状态码分两种"不行"：token 不对是 `403`；**会话已经不存在**是 `404` 且带 `{code: "unknown_session"}`
（面板据此丢掉旧画面并立刻重读会话列表，而不是对着死 id 一直重试）；其它被拒绝的请求是 `400`；
未知路径是普通 `404`。

---

## 9. 已验证 / 未验证

**已验证（本轮：拿这套工具玩扫雷，找出指针注入的真实缺陷并修掉）**：目标是
`/data/Programming/playground/minesweeper_tk.py`（Tk/Xwayland，跑在会话里）。结论是
**click 从来没有送达过客户端**（机制见 §3.3），而且**绝对坐标从第一击起就是错的**。

- 缺陷证据（全部本机实测）：`wayland_input` 回"已注入 1 个动作"，而 Tk 窗口的事件日志里只有
  `<Motion>`、**没有** `<ButtonPress>`；同一次 `wlrctl pointer click` 却能让
  `bindsym --whole-window button1` 触发（sway 收到了按键，客户端没收到）；另挂一个长命虚拟
  指针后，同一句 `wlrctl` 点击立刻送达；`WAYLAND_DEBUG=1 wlrctl pointer click left` 显示每次
  点击都是 `create_virtual_pointer → button → button → destroy`。坐标方面：插件以为光标在
  (0,0)、按差值移动，实测第一击落在 (+99,+99) 之外（Tk 事件坐标 399,499 对应光标 400,500）。
- 修复：新增 [`plugin/pointer.js`](plugin/pointer.js)——手写 `zwlr_virtual_pointer_v1` 协议
  （只用 node 内置：unix socket + 小端结构），每个会话只建**一个**持久设备，`motion_absolute`
  带字面像素与 extent、`button` 先按后放、`axis` 滚轮，每条命令后跟一次 `wl_display.sync`；
  `host.js` 的 move/click/scroll 走它，失败退回 `swaymsg seat … cursor set` → 相对 `wlrctl`；
  `wlrctl` 由必需降为可选（`check-degraded.mjs` 同步断言）。
- 离线证据：新增 `.probe/check-pointer.mjs`（假合成器 unix socket）——断言只建一个持久指针、
  `create_virtual_pointer` 带上绑定的 seat、move 是带字面像素与 extent 的 `motion_absolute`、
  click 是先按后放的 BTN_LEFT(272)、滚轮带 `axis_source`、destroy 回收、缺协议时明确报错；
  **反证**：把 `motion_absolute` 改成 `motion` 后 exit=1，还原后 exit=0。五个离线校验全绿。
- 真调用证据：用开发行（profile patch 里把 `dsh-wayland` 行 `disabled: true`，加
  `dsh-wayland-dev` → `file://…/host.js?v=1`，见 §3.5）让**运行中的** DSH 换上新代码——HMR
  就地生效，`wayland_session_list` 立刻把 `wlrctl` 从必需改成可选，不需要重启；随后
  `wayland_session_create` → `wayland_launch` → 第一击 (619,379) 精确打开棋盘 → 按截图判读
  + 求解器分批点击（一次 `wayland_input` 带 10 个 click）→ **Easy 9x9 通关**，状态栏
  "You Win!"，10 颗雷被游戏自动插旗（留档 [docs/minesweeper-win-demo.png](docs/minesweeper-win-demo.png)）。
  收尾时删掉开发行、恢复 bundle 行。
- 同期两局 Medium 16x16 没赢，都不是工具缺陷：一局是我自己的判读器把红色 "3" 读成空格
  （数字 3 的颜色与人造旗色同为 `#d32f2f`，分类撞色）→ 求解器据此把 3 个带雷格当安全格；
  一局是最低风险猜测（p≈0.14）踩雷。判读器加了"约束自相矛盾就报错"的防线后，这类误读不会再
  静默变成乱点。

- 同期收掉两个不该由模型选的旋钮：`wayland_screenshot` 曾经有 `mediaType`/`quality`，但**选图像
  编码不是模型的活**，而且描述写着 "png (default)" 时实现里省略参数会掉进 manager 的 JPEG 默认值
  （实测省略参数拿到 `wayland-*.jpg`，模型侧 `image/jpeg`）。现在工具**不接受**这两个参数：格式与
  质量由部署配置 `screenshotMediaType`（默认 PNG）/`screenshotQuality` 决定，执行时只把模型能选的
  `window`/`scale` 传下去，所以即便请求里混进 `mediaType`/`quality` 也不会生效。默认 PNG 的理由是
  实测的：同一个纯色 800x600 画面 PNG 2791 B vs JPEG 13753 B，而且无损。宿主保留了请求的格式，
  并没有强制转码（这一点也纠正了我先前的一次误判）。

- 同期重做了 `wayland_input`（原设计是 13 个字段平铺 + `type` 判别字段，字段按类型选择性生效、
  没有原语、`focus` 混在输入里）。新形状：6 原语（move/press/release/scroll/wait/raise）+ 4 糖
  （click/drag/type/key），`do` 判别，坐标 `[x, y]`，和弦一根字符串，窗口只认 id，顶层 `window`
  给出键盘目标；**一张表同时生成 `oneOf` schema 与运行时校验**，并且**先校验后执行**（非法载荷
  零副作用、报错带序号与字段名）。实测（会话里挂一个记录事件的 Tk 窗口）：`press` 在一次调用里
  按下、`release` 在下一次调用里抬起，中间**按住 14.0 秒**（事件日志 3272.893 → 3286.899）；
  `drag` 打出 motion(100,100) → buttonpress → motion(400,300)（事件 state=256，即按住掩码）→
  buttonrelease；`type`+`key` 真的进了 3 个按键；非法载荷 `{do:'press',button:'middle',key:'a'}`
  得到 `action 0 (press): unexpected "key"; it takes button`，且事件日志**零新增**；面板走的
  `POST /api {method:'input'}` 返回 `applied`/`pointer` 并在会话里看到对应 motion。键盘仍然无法
  按住（`wtype` 每次调用重建虚拟键盘，与 §3.3 里 `wlrctl` 丢 click 同源）。离线新增
  `.probe/check-input.mjs`（10 个变体的 required/properties 逐条钉死 + 9 条报错文案 + "校验先于
  会话查找"），六个离线校验全绿；schema 因此从 8921 涨到 10282 字符（+1361，≈ +340 tokens/轮）
  ——这是封闭联合的代价，换来的是错误不可能组合出非法指令。
- 随后又把 `wayland_session_create` 的描述从 805 字符压到 375：`private headless` 本身就含"不碰用户的
  真实屏幕"，`needs a window` 已说完触发条件，于是"举三个例子 + 换个说法再说一遍"、会话回收细节、
  "用完就关"的建议、二进制名与安装方式、以及"去哪看同一份报告"全部删掉——它们分别由
  `wayland_session_close`、`wayland_session_list` 与 create 自己的**报错正文**承担（`check-degraded.mjs`
  断言的就是报错里含缺失名与 `Install them`）。schema 总量随之回到 9852 字符。
- 同一把尺子又量了 `wayland_screenshot`：520 → 312 字符。窗口范围删掉（`window` 参数已定义"省略即整屏"）、
  格式与质量那句话整句删掉（**模型没有任何参数能影响它，写进提示词不可行动**，策略留在 §7/§10 与人读文档）、
  `right now` 与 `never cached` 是同一事实（合并成 "grabbed during this call"）、报错句收紧为
  "Errors if window is not currently mapped."。保留了 "At the default scale … where pointer actions land"：
  它讲的是**默认路径**上的跨工具契约（截图坐标 = `wayland_input` 的 x/y），而 `scale` 参数那句是从换算角度说的。
  schema 总量 9852 → 9644。
- 接着把**诊断从各工具里剥出来**，做成第 8 个工具 `wayland_check`：`wayland_session_list` 只列会话，
  `wayland_session_create` 不再提依赖报告，失败信息仍然就是那份报告（`dependencyError()` 在报告末尾
  加一句指路）。理由是两件事的生命周期无关——"有哪些桌面" vs "这台机器上这东西能不能跑"——而描述的钱
  每轮都要付、诊断却只在失败时才需要；顺带把自检做厚：已解析的二进制用**无副作用探针**真跑一遍
  （`sway --version` / `grim -h` / `wtype` 用法文本，补上"只看存在性"的盲区）、`sessionRoot` 可写性、
  以及每个会话一行体检（合成器存活 / sway IPC 版本 / Xwayland 显示号 / 是否提供
  `zwlr_virtual_pointer_manager_v1`——用**只读探测**，绝不建临时设备：临时设备正是 §3.3 里丢 click 的
  根因）。`.probe/check-degraded.mjs` 跟着改为校验 `wayland_check` 的形状，并断言"什么都没解析出来时
  不许报 ok"；`.probe/check-pointer.mjs` 增加只读探测的三条断言（有协议/无协议/连不上，且都不建设备）。
  schema 9644 → 9749 字符（新工具自己的描述约 320 字符）。
- 再修 `wayland_launch` 的结果：原来"没有窗口"把三种情况混成一句话（进程挂了 / 还在画 / 根本没等），
  现在回一个 `outcome`（`window` / `exited` / `timeout` / `skipped`）+ 已知的 `exitCode` + 会话日志路径，
  渲染也分情况说话（exited 点出退出码并指向日志、timeout 明说进程还在跑并提示稍后看 `wayland_windows`）；
  "不经过 shell" 从工具描述挪到 `command` 参数（描述里只留"要用 shell 该怎么办"），`env` 写清形状
  （名字→值、值会被字符串化、合并覆盖在会话环境之上、`DISPLAY` 由会话决定不可覆盖）。新增
  `.probe/check-launch.mjs` 把四种 outcome 的措辞与字段钉死（已反证：改掉 exited 的措辞 → exit=1）。
- 接着补上"要用 shell 语法怎么办"这条路：描述里给出**会话内终端**的做法
  （`command: "foot", args: ["-e", "bash", "-c", "…"]`），并实测确认了它的边界——`echo hi | tr a-z A-Z`
  确实在会话里跑出了 `HI-FROM-SHELL`、用户能在右栏看到，但**终端把输出渲染在 PTY 屏幕上，`apps.log`
  里只有 foot 自己的一行 warning（83 B）**，所以要文本仍应走 bash 工具（或让 shell 自己重定向到文件）。
  这条实测边界写进了描述，免得模型以为能去日志里读终端输出。schema 9724 → 9920。
- 再走一遍去重（四条反馈）：`The program inherits that desktop's screen, clipboard and input, so it appears
  only there` 删掉（"在虚拟桌面上跑程序"已经含了这个意思）；五个工具共用的 `session` 参数缩成
  `Session id from wayland_session_list or wayland_session_create.`（各省 21 字符）；既然描述里已经给了
  "要 shell 就用 bash 工具或会话内终端"这条路，`command` 上那条 `Run directly, without a shell…` 就是
  同一事实的第二遍，删掉；`"foot"/"konsole"/"firefox"` 这类"怎么写程序名"的示例也删。schema 9920 → 9598
  （比拆分诊断前的 9644 还低）。`.probe/check-launch.mjs` 的断言改成钉新口径：shell 这件事只在描述里说
  一次（路由 + 终端输出不进日志），`command` 参数里再出现规则或 `e.g.` 示例即失败。
- 最后删掉 `wayland_input` 描述里那句 `The whole list is validated before anything is sent: a rejected call
  names the action and field to fix and leaves the session untouched, and a directive that fails mid-run reports
  how many earlier ones were applied.`：前半句（`validated before anything is sent`）是**实现机制**，
  后半句的报错格式（点名第几条/哪个字段）模型读报错就知道了——**这两件事实都出现在报错里，描述里再说一遍就是第二次**：
  校验失败抛 `action 2 (click): …`（什么都没发出去），跑一半失败抛
  `wayland_input: action 3 (click) failed: … (2 earlier action(s) were applied)`（已应用几条）。
  后者实测过：`[move, wait 9000, move]` 在 `wait` 中途 `pkill` 掉合成器，真调一次拿回
  `Error: wayland_input: action 2 (move) failed: wayland socket closed (2 earlier action(s) were applied)`
  ——`applied` 数（含 `wait`）与实际发生的事一致。
  `.probe/check-input.mjs` 相应去掉"描述里必须出现 `validated before`"这条**散文断言**——失败语义改由
  行为断言钉（每条拒绝都带 action 序号/指令/字段，合法载荷必须越过校验），脚本注释里写明这个分工。
  schema 9598 → 9382。
- 本轮（光标可见）：三处改动加一个离线校验。`capture()` 加 `grim -c`；会话创建时就连上持久虚拟指针
  并把它停在会话中心；生成 sway.conf 时写 `seat * xcursor_theme <theme> <size>`（`cursorTheme`/
  `cursorSize`，空则自动探测）；`wayland_check` 多一行 `cursor`；`wayland_screenshot` 描述加一句
  "指针就在图里"。schema 9382 → 9509。
  **实测（本轮踩的关键坑）**：一开始用"`grim` 与 `grim -c` 在同一指针位置是否逐字节相同"来判断有没有
  指针——**这个判据是错的**：两者都含指针时当然相同。正确判据是在两个指针位置各抓一帧看差异，或数
  指针处的像素。改判据后拿到的真实结论是：旧代码两个位置的抓帧**逐字节相同（没有指针）**，只给它加
  `-c` 就各自出现精灵（209 px），headless 后端平时挂着硬件光标、根本不合成进输出缓冲（`sway -d` 日志
  `Enabling hardware cursors on output 'HEADLESS-1' (locks: 0)` ↔ 抓帧时的 `Disabling … (locks: 1)`）。
  另外纠正了上一版文档/断言里"没有主题就没有指针"的说法：wlroots 在主题加载不到时会用内建 fallback
  （`load_default_theme`），实测无主题、无 `XCURSOR_PATH` 时仍画出 40 px 的小箭头——所以 cursor 行
  写的是"退回 sway 自带光标"，不是"没有指针"。新代码实测：创建后未做任何输入，第一帧就在中心
  (300,200) 画出 228 个非背景像素的精灵，move 后跟到新位置且旧位无残影，窗口裁剪路径同样含指针；
  面板那条 `/frame`（JPEG、0.6 缩放，即右栏实时画面走的路）同样含指针：两个指针位置各取一帧，
  精灵出现在各自位置、旧位置没有。`-c` 的代价 15.29 → 15.99 ms/张（800x600 JPEG q82）。离线部分
  交给新的 `.probe/check-cursor.mjs`（假 sway + 假工具链：主题/尺寸落进 sway.conf、装不上的主题报
  warn 且措辞提到 fallback、自动探测与配置文件一致、cursor 行与截图描述都在）。
- 接着修用户报的 bug：**关掉最后一个会话后，面板既不丢旧画面、还一直报 400**。两半都有责任：
  Host 把"会话已经不存在"和"请求本身不对"混成同一个 `400`，面板只看得到状态码；而面板的
  `selected` 在会话列表变空时**没有清掉**（那个 effect 见空列表直接 `return`），于是帧循环继续
  对着死 id 抓帧、`frame.url` 还指着上一张图。改动：`require()` 给这个错误打 `code = 'unknown_session'`，
  HTTP 层据此回 `404 {code}`（403/400/未知端点不变）；面板在列表清空时清掉 `selected` **和**最后
  一帧，抓帧收到 404 时丢画面、清错误、立刻 `sessions.list` 再退出循环（不再 400ms 一次地重试）。
  `.probe/check-panel.mjs` 因此扩出一个**真跑 effect** 的渲染模式（自造 `useState`/`useEffect` 依赖
  比较、假时钟、假 Host、浏览器全局 `fetch`/`URL`/`AbortController`/定时器），钉住生命周期：
  有会话时画面出现 → 会话消失后旧画面消失、错误行消失、立刻重读列表、回落到"没有会话"那一屏、
  再推进 3 秒**不再有任何抓帧请求**。两种"会话没了"都测：Host 回 `404` 时**只允许 1 次**抓帧；
  面板比 Host 新（对方是只回 `400` 的旧半）时也要自己收敛——首帧失败立刻问一次列表，实测同样
  1 次就停（这条兼容是有意留的：客户端半能单独热重载，Host 半不会）。同一节还用**真 Host 的
  handler** 断言 `404 + unknown_session`、`403`、未知路径 `404`、以及工具报错仍是给人读的句子。
  **反证**：换成修复前的 `client.js`（`DSH_WAYLAND_CLIENT`）→ 5 条断言失败，其中一条正是"又多了
  8 次抓帧"、并打印出用户看到的那屏 `"frame request failed (404)"`；换成修复前的 `host.js` →
  `/frame` 回 400。
  顺带修掉反证里露出来的另一个小 bug：同一毫秒内到两帧会让平滑 fps 变 `Infinity`，HUD 就真的
  打印 `● Infinity fps`（现在 delta 为 0 时跳过，探针断言 HUD 不出现 `Infinity`/`NaN`，同样反证过）。
- 再修用户报的 launch 等待：**窗口明明出现了，`wayland_launch` 却等到超时**。按用户给的例子实测
  （flatpak KMines）拿到根因：等待条件原来是 `w.pid === child.pid`，而 `flatpak run` 的进程树是
  `flatpak → bwrap → … → kmines`——启动的 pid 是 77575（bwrap），窗口属于 77586（kmines，父链
  77585 bwrap → 77575），**差一个进程层级就永远匹配不上**，于是 30 秒超时、而窗口已经在屏幕上。
  还有第二种形态：`setsid foot -e sleep 30` 的启动进程立刻退出（应用被 reparent 到 init），旧代码
  在窗口 map 之前就回 `exited`。修法三条：①按 `/proc` 走**任意深度的子孙进程**（`descendantPids`）；
  ②没有子孙匹配时，若**恰好多出一个启动前不存在的窗口**就认领它（覆盖 reparent/dbus 激活这类
  脱离进程树的交接；多个新窗口则不猜）；③启动进程退出后**再等 1.5 秒**看有没有交接窗口
  （`EXIT_GRACE_MS`），并把"deadline 到了但进程已退出"从 `timeout` 纠正为 `exited`。
  实测（同一台机器、真应用）：KMines **30 s 超时 → 584 ms 拿到 `window` 5/`org.kde.kmines`**；
  `setsid foot` **`exited` → 316 ms 拿到 `window` 6/foot**（exitCode 0 仍如实带上）；`true`/`false`
  仍回 `exited`（0/1，晚 1.5 s）、`sleep 30` 回 `timeout`、`wait:false` 回 `skipped`。
  `.probe/check-launch.mjs` 用一个真实三层进程树（probe → bash → 子 shell → sleep）钉住走树的深度、
  排除无关进程与 init、进程消失后不留残余，并用合成窗口钉住认领规则（子孙优先、唯一新窗口才认领、
  两个新窗口不猜、已有窗口/不可见窗口不认领）。**反证**：把 `descendantPids` 换回"只返回自己"→
  3 条断言失败。schema 不变（`outcome` 在输出 schema 里，不计入那段 token）。

**已验证（实测，第一轮）**：7 个工具端到端（`create → launch → windows → screenshot → input`，图像真的回到上下文）；
按窗口裁剪；非 ASCII（中文）经剪贴板输入；绝对坐标点击能切换两个窗口的焦点；20 fps 循环；
token 跨重载不变、错误 token 403；帧是活的（相隔 4s 两帧有 3.11% 像素变化，包围盒恰好是动画窗口）；
面板可用（用户目视）。

**已验证（实测，2026-10-03 重装复验轮；工具链就绪）**：四个离线校验全过；工具链 `ready`
（`sway`/`swaymsg`/`grim`/`wtype`/`wlrctl` 经 PATH → `/etc/profiles/per-user/kyv/bin/*`，`binDir` 为空，
可选缺 `wayvnc`/`wf-recorder`/`xterm`）；先 `remove_bundle` 再 `install_bundle(link:<仓库>/plugin)`
真重装一遍（卸载瞬间 7 个工具从 Host 工具表消失、所有会话被回收；重装后工具与面板都重新注册），
重装后端到端跑通——`create`（960x600）→ `launch` foot（拿回 pid 与 window `#5`）→ `windows`
（`960x600+0+0 [focused]`）→ `input`（33 字符 + Return，截图里终端真的执行了该命令）→
`screenshot` 返回图像 → `close`（会话目录、sway 与 foot 进程都被回收）；`GET /boot` 免鉴权 200
且带 `toolchain.ready:true`，`GET /frame` 无 token 403、带 token 200（`scale=0.5` → 480x300 JPEG）；
token 文件 0600、48 位 hex，**卸载→重装前后是同一个 token**（复用文件，不是重新生成）；
client 侧用 cordis Client inspect 读到实时插槽树里 `sidebar.right.pane.tab` 的 occupant 含
`@local/dsh-wayland`（`active:true`；DSH 给本地 link 插件加 `@local/` 前缀）。

**已验证（截图 `region`/`grid`，一半离线一半端到端）**：`check-overlay.mjs` 不需要任何工具链——
10 张内嵌的真实 PNG 字节（覆盖 PNG 的 5 种行滤波器，加 RGB 与 RGBA 两种 colour type，再加手写
编解码器会拒绝的 palette/隔行/16-bit）解出来逐像素等于构造它们时的原始像素，编码→解码往返逐字节
相同，3 条坏输入（空 buffer / 非 PNG / 截断）如实报错，`grid` 在 `scale 1` 与 `scale 2` 下的落点分别是
`session 步长的整数倍` 与 `(x-origin)×scale`，且 step 过小 / 非数字 / scale 为 0 三条都拒绝。
把这份校验指向已删除的手写编解码器会精确红在新增的 3 张格式上，说明用例真的在区分新旧实现。
`check-screenshot.mjs` 则**真的开一个 sway 会话、真的用 grim 抓图**：`region` 的 origin 与宽高如实回报、
越界矩形被裁成 80×40 而不报错、`grid` 把部署配置的 JPEG 强制成 PNG、标尺在像素上的落点与预期一致、
放大时映射是 `(x-origin)×scale`；缺工具链时它报 skipped 并 exit 0，**不**把"这台机器没有合成器"
伪装成插件缺陷。

**已验证（离线，`.probe/`，全程不需要任何工具链）**：三种工具链状态的降级行为——全缺时激活成功、
`wayland_session_list` 报出 4 个缺失名与用途、`wayland_session_create` 报出安装命令、需要会话的
工具报依赖而不是 `unknown session`、返回结构（含 `installHints`）通过真实 schema 校验；部分缺失时
只报缺的那些；齐全时翻成 ready；报告里不含任何发行版特有机制（校验脚本会拦下这类文案）；
包名/client id/patch 行名三处一致且 `files`/`exports`/icon/locale 齐全（`check-identity.mjs`）；
8 个工具的 schema 通过真实校验器（`check-plugin.mjs`）。`npm pack --dry-run` 打 11 个文件 60.3 kB。
`.probe/render-tools.mjs` 补上缺失的 `node:path`/`node:url` 导入后可以重渲染，产物与磁盘上的
`docs/tool-definitions.md` **字节相同**（sha256 一致），所以 §5 的 7302 字符确实来自代码而不是手抄。
四个脚本都按自身位置定位仓库、按运行中的 DSH 定位工具运行时（`$DSH_TOOLS` → `--app-path` → 父进程链），
所以换路径、换机器都不用改它们。

**已验证（缺依赖时的面板侧行为，本机实测）**：让工具链不可达后（**不是**清配置，而是让已解析的
目录消失），`/boot` 立即变成 `ready:false` + 4 个缺失名，面板取帧的 `/frame` 返回
HTTP 400 且响应体就是同一份依赖报告；**已经在跑的会话不受影响**（合成器进程照常运行，只是取不到新帧），
恢复目录后 `ready:true`、取帧又回到 200。这也是"缺依赖不崩、而是说清缺什么"的证据。

**注意区分两件事**：清空 `binDir` 只会改变**该插件实例的解析结果**，不代表机器上真的没有工具链；
而"让目录消失"才是真正的不可达。§9 的两条都只说明插件行为，不说明某台机器的配置。

**已验证（离线，面板渲染）**：`.probe/check-panel.mjs` 用迷你 React 把真实的面板组件树渲染出来，
断言：英文与中文两套 chrome 都在（且中文渲染里不残留英文标签）、**49 个键两边键集完全一致**、
每个可交互元素的悬停说明**可达**（`disabled` 按钮不能自带 `title`，必须有带 `title` 的包裹元素；
`pointer-events: none` 的元素不能挂 `title`；说明必须比标签长）、**面板内不存在写死的 px 字号**
（根节点 `inherit`、其余 `em`）、**locale 服务迟到时面板会切到中文而不是终生英文**、
组件树里不存在 Live/Crisp 按钮、依赖页把每个缺失二进制连同**翻译过**的用途一起列出并带上安装行。
**但这只是组件树，不是浏览器像素。**

**已验证（本轮，离线校验本身的"反证"）**：把旧写法塞回去，`check-panel.mjs` 必须失败——实测
两组：① `disabled` 按钮自带 `title` → 报 `disabled button "New" carries its own title, which its
browser never shows`（4 个按钮 × 2 语言）；② 把次级文案写死 `fontSize: 13` → 报
`div hardcodes font-size 13 instead of following the shell`。还原后全绿，说明这些断言不是摆设。

**已验证（本轮，客户端 bundle 提供链路）**：改 `client.js` 后，服务端对**旧 rev** 返回 404、
对**新 rev** 返回 200，且返回体与磁盘逐字节一致（只多一行 `//# sourceMappingURL` 尾注），
里面能找到 `stage.tip` / `watchers` / `fontSize: 'inherit'` / `0.86em` / `error.request`。
**并实测到这条链路会滞后**：修完最后一版后新 rev 一度也返回 404（组合仍停在上一版），
此时刷新页面会拿到旧字节；重挂插件行后同一 rev 才转为 200。所以"改 client.js"的正确收尾是
**重挂一次插件行 + 刷新页面**，而不是只刷新。

**已验证（本轮，真实 Cordis 复现"面板整块消失"）**：用安装里的 `cordis@4.0.4` 起真实上下文 +
一个遵守真实重复注册规则的 locale 替身，直接 `apply()` 本插件的三个场景：干净上下文、
同进程 apply 两次、**旧实例字典仍在注册表**。修复前第三种会在 `locale.register` 处 throw，
且因为当时 locale 接线排在注册之前，`tabType` 与 body 都是 `MISSING`（这正是"tab 直接消失"的
机制）；修复后三种全部 `apply OK / tabType=registered / body=registered`，重复注册只留一条
console 警告。同一场景也进了 `check-panel.mjs`（`preRegistered: true`），断言"字典被拒也
必须注册 + 渲染英文 + 不泄漏键名"。

**已验证（本轮，插件被移除后的重装）**：profile `bundles` 列表里丢掉 `dsh-wayland` 时
（patch 行随之消失、`wayland_*` 报 `unknown tool`、会话被回收），残留的 `link:` 依赖会让直接
`install_bundle` 报 `ambiguous-install`；`remove_bundle` → `install_bundle` 后 `changed:true /
applied`，Host 工具立刻回来、client occupant 自己回来（key 从 `@local/dsh-wayland` 变为
`dsh-wayland`），服务端对当前文件的 rev 返回 200 且与磁盘逐字节一致。

**已验证（本轮，"entry 失败会拖垮启动"及其防线）**：DSH 前端 `index-*.js` 的启动检查是
`loader.entries()` 逐个体检 fiber —— 不存在 → `import failed`，`pending` → 等服务，状态不是
`active` 就 `throw new Error('web boot: N entry did not activate')`；本机因此留下两份
`crash-*-web-boot.log`，报的是 `dsh-wayland: failed`（fiber 存在但状态是 failed = `apply` 抛了）。
这条链路现在有离线防线：`check-panel.mjs` 新增场景"注册就抛"（`registerThrows: true`），断言
`apply` **不抛**、entry 不会变 failed（修前会直接冒泡出去）。另外把**服务端实际提供的那份
字节**（`/plugins/??dsh-wayland/client.js&rev=…`）抓下来交给
`DSH_WAYLAND_CLIENT=<file> node .probe/check-panel.mjs` 跑同一套断言——本轮实测 200、与磁盘
逐字节一致、校验全过；这比只测工作副本更接近 renderer 的真实输入。同一轮还补了另一个场景
**"tab 注册表晚到"**（`serviceAtApply: false`）：断言"注册表不存在时不许注册、`ctx.inject`
必须被登记、注册表出现后 tab 类型与 body 都要补注册"——重启后"app 能开但右栏没有 wayland"
就是旧代码在这个场景下直接放弃。

**已验证（本轮，严格服务访问 & 桩的严格化）**：用户控制台给出的真实堆栈是
`Error: cannot get property "sidebarRightTabs" without inject`，落在
`ctx.get?.('sidebarRightTabs') ?? ctx.sidebarRightTabs` 的 `??` 右侧——即**该运行时对未注入服务
的属性访问是抛错**（我先前用裸 `Context` 测得"返回 undefined"是错的：那是默认模式，所以这条
结论以运行中的客户端为准）。两处（locale、sidebarRightTabs）现在只用 `ctx.get`，属性访问只
发生在 `ctx.inject` 的 scope 内部。`check-panel.mjs` 的桩同步改成**严格模式**：`locale` /
`sidebarRightTabs` 用抛错的 getter 声明，注入后才由 `deliverLocale()` / `deliverRegistry()`
以派生 scope 提供，且派生 scope 用安全字段拼出来（不能直接展开带 getter 的 ctx）。
反证实测：把 `?? ctx.sidebarRightTabs` 塞回去 → `check-panel.mjs` **exit=1**，报出
`the plugin must ask for sidebarRightTabs through ctx.inject instead of giving up`、
`the tab type must register once the registry appears…`、`the tab body …`；还原后 exit=0。
另外用真实 `cordis@4.0.4` 单独验证了 `ctx.inject` 的等待语义：服务提供前不触发，`ctx.provide`
与 `ctx.reflect.provide` 提供后都会触发并把服务交给回调。

**未验证**：面板渲染没有浏览器自动化（能自动核对的只有**注册状态**——client 侧 slot occupant 在实时页面里
active，见上一节；组件树渲染出的像素不在其中）。可以间接读面板内容：用 `/boot` 拿 token 后
`curl -H "x-dsh-wayland-token: …" '/dsh-wayland/frame?session=<id>&scale=0.5'` 存成图片再看，
它与面板拿到的是同一帧；但"面板此刻画了什么 DOM / 悬停提示弹没弹 / 字号看起来多大"仍然只能靠用户目视。
`wayvnc` 流畅流未做；录制 / AT-SPI 结构化提取 / DBus 工具未做；多会话并发只做了单会话压测。

---

## 10. 已知问题与限制

- **xterm 在无头会话里花屏**（Xwayland 字体/渲染路径），用 `foot` / `konsole`；它仍留在
  "可选"表里只是为了不把已有部署判成缺依赖，实际体检只报"存在与否"、不报"能不能用"。
- `wayvnc` / `wf-recorder` 目前是**幽灵依赖**：会被解析、但没有任何调用点（见 §9 未做项）。
- **依赖解析**只看存在性（`existsSync`），不校验版本、也不校验可执行位；`wayland_check` 会额外把已解析的二进制用无副作用的探针跑一遍（`sway --version` / `grim -h` / `wtype` 用法文本…）来区分"能跑"与"存在但起不来"（缺共享库那类），但**仍不校验版本号**——版本不对只能靠报错内容自查。
- **指针降级路径的 click 仍可能丢**：合成器没有 `zwlr_virtual_pointer_manager_v1` 时，插件退回
  `swaymsg seat … cursor set` + `wlrctl`，而 `wlrctl` 每次新建/销毁虚拟指针正是 §3.3 里那个
  丢 click 的形态——所以那时只能保证移动与键盘，click 不可靠（sway/wlroots 一直提供该协议，
  本机不受影响）。同一情形下截图里也不会有指针：没有指针设备就没有光标图形。
- **`wayland_launch` 认领窗口的边界**：`window` 靠"子孙进程的窗口"或"这次调用唯一新增的窗口"判定。
  如果程序把请求交给了**已经在运行的实例**（D-Bus 激活、`firefox` 复用已有窗口），既没有子孙进程也
  没有新窗口，只能回 `exited`/`timeout`——这时用 `wayland_windows` 看那个已有窗口。反过来，如果
  启动期间有**多个**互不相关的新窗口出现且没有一个是子孙，插件不猜，仍是 `timeout`。
- **指针图形取决于机器上装了哪些 xcursor 主题**：`cursorTheme` 为空时只按 `XCURSOR_PATH` 与常见
  icons 目录探测"第一个真的带 `cursors/left_ptr` 的主题"；一个都没有时用 wlroots 内建的 fallback
  箭头（较小，实测 10x16，本机 40 个非背景像素）。`wayland_check` 的 cursor 行会说明到底用的哪一个，
  但检验不了那个主题画出来好不好看。
- **长按现在能做了**（原限制已解除）：`wayland_input` 有 `press`/`release` 两个原语，会话级持久
  虚拟指针跨调用保持按键状态，所以"按住 >0.45 秒"（原扫雷用例）与 `drag` 都能直接表达。**键盘
  仍然不能按住**：`wtype` 每次调用都新建并销毁一个虚拟键盘，键位状态不跨调用（与 §3.3 里
  `wlrctl` 丢 click 是同一类问题）；`key` 的按键与释放始终在同一条指令内完成。
- **`mediaType` 是有效的，宿主不会强行转成 JPEG**（本轮实测，纠正过一次误判）：显式要 png 时，
  模型侧拿到的那份附件实测就是 `image/png`；要 jpeg 时是 `image/jpeg`。之前的误判来自本仓自己
  的 bug——描述写着 "png (default)"，而实现里**没传参数会掉进 manager 的 JPEG 默认值**，于是我
  看到的每张截图都是 JPEG，看起来就像"宿主强制转码"。同一个纯色 800x600 画面实测：PNG 2791 B，
  JPEG 13753 B（PNG 反而小 5 倍），所以默认 PNG 既无损通常也更省。宿主自己的说明是"may be
  resized or re-encoded"，要 grim 原字节仍然走 `/frame?mediaType=png`。
- 已修：`wayland_session_close` 的返回渲染会抛 `output.render failed: lines is not iterable`
  （`toolText` 的 `lines` 参数没有默认值）。
- 已修：locale 字典重复注册抛错会打断 `apply()`，导致 `wayland` tab 整块不再注册（热重载后旧实例
  字典仍在注册表时必现）。现在先注册面板、i18n 接线放在最后并降级为英文，见 §3.7。
- 20 fps 期间约占用单核 2/3；窗口不可见时面板会自动暂停。
- 帧格式是部署级选择：`liveMediaType: image/png` 在图形密集内容上可到 ~300 KB/帧（面板不再有
  "large frame, try Live" 那种提示，因为没有可切的东西了；要 JPEG 就改配置）。
- 无 GPU：浏览器等重图形程序很慢或起不来。
- **画面在高 DPI 屏上偏小（已知取舍，未修）**：面板按面板物理像素建会话，1.75 缩放的屏上
  画面以约 57% 显示（本机 1726 物理像素 → 约 986 CSS px 栏宽），客座里的字号随之变小。
  要 1:1 就得让客座按逻辑像素渲染（sway output scale = dpr），但那会把"逻辑/物理"两条坐标
  语义拉开（sway IPC 用逻辑像素、grim 用物理像素），涉及会话记录、窗口几何、输入映射与工具
  文档，因此**故意留到单独一轮做**。这与面板自身 chrome 无关——chrome 已改为跟随宿主字号。
- **profile 的 pnpm bug**：profile 的 `pnpm-workspace.yaml` 若以 `%YAML 1.1` / `---` 开头，
  DSH 自带的 pnpm 11.27.0 会报 `ERR_PNPM_INVALID_WORKSPACE_CONFIGURATION: Missing or empty package`，
  导致**任何 bundle 都装不上**。删掉那两行即可（本机已修）；若 profile 由某个外部生成器管理，
  要留意它可能把这两行写回来。
- 改 profile patch 后 HMR 会就地挂载/卸载插件行，但**已安装的 bundle 行不会重新加载模块**：
  改了 `host.js` 又想让 bundle 行生效，只能重启 DSH（见 §3.5）。

---

## 11. 开发循环

1. 改 `plugin/host.js` / `plugin/client.js`。
2. 跑离线校验：`.probe/check-plugin.mjs`（工具 schema 改动必跑）、`.probe/check-identity.mjs`
   （改包名/`client.js` 的 id/patch 行名必跑）、`.probe/check-degraded.mjs`（改依赖表、
   探测逻辑或降级文案必跑）、`.probe/check-panel.mjs`（改面板 UI/文案/控件必跑）、
   `.probe/check-pointer.mjs`（改 `pointer.js` 或指针注入路径必跑）、`.probe/check-input.mjs`
   （改 `wayland_input` 的指令表/校验必跑）、`.probe/check-launch.mjs`（改 `wayland_launch` 的
   结果字段或渲染必跑）、`.probe/check-cursor.mjs`（改光标主题解析、生成的 sway.conf 或
   `wayland_check` 的 cursor 行必跑）、`.probe/check-overlay.mjs`（改 `overlay.js`、PNG 编解码、
   `pngjs` 版本或标尺绘制必跑；不需要工具链）、`.probe/check-screenshot.mjs`（改截图路径、`region`/`scale`/`grid`
   必跑；**需要工具链**，缺了就报 skipped）。
3. （只有开发这个插件时才做）在 profile 里加开发行并**换 id + 换 `?v=N`**，同时确认 bundle 行是
   `disabled: true`（否则开发行会被挡住，见 §3.5）。普通用户跳过这一步。
4. 重载会杀掉所有会话 → 重新建会话；若只改了 `client.js`，**重挂一次插件行再刷新页面**
   （组合会滞后，见 §3.5 第 2 条实测），不需要重启 DSH。
5. 若改了工具定义：跑 `.probe/render-tools.mjs` 重新生成 `docs/tool-definitions.md`。
6. 想验证"真能跑"：用工具真调一次，或 `/frame` + `read_image` 看图。

排错速查：面板 403 → 点 Refresh（会重取 token）；面板空白/没有 wayland tab → 刷新页面，
仍不行就先跑 `.probe/check-identity.mjs`（三处名字不一致时会这样）；工具报 unknown session →
会话被重载/close 干掉了；工具报缺二进制 → 按报告里的 install 行装，或配 `binDir`
（装完直接重调，不用重载插件）；改了代码却还是旧行为 → Host 模块缓存，见 §3.5。

**面板整块消失 + `wayland_*` 工具报 `unknown tool`**（两半同时没了）→ 插件不在 profile 的
`bundles` 列表里了（被禁用/移除，或移除后没装回来）。看 Plugin Manager 的 `installed/enabled`，
然后**先 `remove_bundle` 再 `install_bundle`**：依赖残留时直接 install 会报
`ambiguous-install`（见 §6）。重装后 Host 半边立刻回来，客户端半边由运行时重新挂载，
页面刷新一次最稳（实测 occupant 会自己回来，key 从 `@local/dsh-wayland` 变成 `dsh-wayland`）。
只消失**半边**（Host 工具在、tab 没有）→ client 半边没注册上，控制台那行 `[dsh-wayland] …`
就是判决书，三种已实测过的形态：
1. `Error: cannot get property "sidebarRightTabs" without inject` → 用属性访问拿了没有注入的服务
   （本次的根因，见 §3.7 第一条）；locale 同理会报 `… "locale" …`。
2. `Error: locale namespace "dsh-wayland" already has locale "en"` → 热重载后旧字典还在注册表，
   注册被拒（现在只降级英文，不再致命）。
3. 什么都没打印 → 大概率是 `ctx.get('sidebarRightTabs')` 那一刻为 undefined 且没有等待路径。
三种都已修掉；**刷新页面**后再看，仍不行就把控制台那一行发出来。

**app 直接起不来，弹「DeepSeek Harness 无法使用 / 应用无法启动或已意外停止」并写着
`web boot: 1 entry did not activate` + `dsh-wayland: failed`**（实测踩到过）→ 这是**渲染端**
的启动检查：某个 client entry 的 fiber 不是 `active`，前端就抛错并终止整个启动。诊断报告在
`~/.config/@deepseek-ai/dsh-desktop/logs/crash-<ts>-web-boot.log`（只有摘要，没有堆栈）。
恢复：对话框第三个按钮「**禁用第三方插件、备份 profile patch 并重启**」（会把第三方 bundle
从 profile `bundles` 里摘掉，并把当时的 patch 备份成 `cordis.patch.yml.bak-<ts>`，注意它也会
重写 patch，本机就被摘掉了 `permission`/`ui-theme` 等块）。修好后再按上面的 remove→install
装回来。本仓库已把 `apply()` 整体 guard，所以**这类崩溃不会再由本插件引起**；万一 tab 还是
没出现，看浏览器控制台的 `[dsh-wayland] panel registration failed …`，那里有真实堆栈。
验证"renderer 会加载的那份字节"是否健康：抓插件路由的 combo（`/plugins/??dsh-wayland/client.js&rev=<rev>`）
存成文件，然后 `DSH_WAYLAND_CLIENT=<该文件> node .probe/check-panel.mjs`。
