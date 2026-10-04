# Model-facing tool definitions

This is the exact text the model reads for this plugin's tools (rendered from
the live definitions, not hand-copied). Descriptions carry the purpose, when to
use the tool, and what it returns; defaults, units and id provenance live on the
parameters they belong to.

Seven tools, 9644 characters of schema in total.

## `wayland_session_create`

Start a private headless Wayland desktop (sway) that the user can watch live in the DSH right sidebar, and return the session id the other wayland_* tools take. Use it when a task needs a window. A session starts empty (wayland_launch starts programs), lives as long as DSH does, and only a few may exist at once. Fails with the dependency report if the toolchain is missing.

| parameter | type | required | description |
|---|---|---|---|
| `name` | string | no | Label shown in the session list and in the sidebar panel. |
| `width` | integer | no | Screen width in pixels (default 1280). Positive integer. |
| `height` | integer | no | Screen height in pixels (default 800). Larger screens cost more CPU per live-view frame. |

## `wayland_session_list`

List the virtual desktops that exist right now — id, name, size, how many programs each has started, and whether its compositor is still alive — and report the toolchain this plugin runs on. Call it first when earlier work may have left a desktop running instead of creating another one, and whenever another wayland_* tool reports missing dependencies: that report names each missing binary, what it is for, and how to install it or point config.binDir at it. It always succeeds, even with nothing installed.

*No parameters.*

## `wayland_session_close`

Shut a virtual desktop down: every program started in it is terminated, its windows disappear, and its run directory is removed. Close desktops you have finished with rather than leaving them running. The id must name a live session — closing one twice, or an unknown id, is an error.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list (or the id returned by wayland_session_create). |

## `wayland_launch`

Run a program on a virtual desktop and return its pid. No shell is involved — command and args are executed literally, so pipes, redirection, globbing and `&&` do not work; use the bash tool for shell commands. The program inherits that desktop's screen, clipboard and input, so it appears only there, and its output goes to a log file in the session directory, not this result. With wait (the default) the call also polls, up to waitMs, for a window owned by that pid and returns its id; no window, an immediate exit, or a slower draw returns without one. A GUI toolkit needs a second or two to draw, so wait before screenshotting.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list (or the id returned by wayland_session_create). |
| `command` | string | yes | Executable to run: a name on PATH or an absolute path, e.g. "foot", "konsole", "firefox". |
| `args` | array of string | no | Command-line arguments; each entry becomes one argument, exactly as given. |
| `env` | object | no | Extra environment variables for the program, merged over the session's own (string values). |
| `cwd` | string | no | Working directory (default: the DSH process's home directory). |
| `wait` | boolean | no | Wait for a window before returning, up to waitMs (default true). Set false for programs that open no window. |
| `waitMs` | integer | no | How long to wait for that window, in milliseconds (default 8000; the call blocks meanwhile). Ignored when wait is false. |

## `wayland_windows`

List the windows currently mapped on a virtual desktop: window id, app id (or X11 class), title, pid, which one has keyboard focus, and each absolute rect in session pixels. These ids are what wayland_screenshot takes as window and wayland_input takes in a focus action. An empty list means nothing is mapped yet — a program still starting, or one that failed to open a window; pid is left out when the compositor does not know it.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list (or the id returned by wayland_session_create). |

## `wayland_screenshot`

Capture what a virtual desktop looks like and return it as an image you can see, grabbed during this call. Use it to read GUI state and check that earlier input took effect. At the default scale the image is session pixels, so what you see is where pointer actions land. Errors if window is not currently mapped.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list (or the id returned by wayland_session_create). |
| `window` | integer | no | Window id from wayland_windows; omit to capture the whole screen. |
| `scale` | number | no | Size multiplier: 1 captures native pixels, 0.5 halves both dimensions. Coordinates in the returned image are session pixels divided by scale, so multiply by 1/scale to get the x/y wayland_input wants. |

## `wayland_input`

Send input to a virtual desktop as an ordered list of directives; each entry is exactly one of ten — move, press, release, scroll, wait, raise, click, drag, type, key. Key and text events go to the focused window, so pass window to raise and focus one first; pointer events go to whatever is under the cursor. The whole list is validated before anything is sent: a rejected call names the action and field to fix and leaves the session untouched, and a directive that fails mid-run reports how many earlier ones were applied. Directives run strictly in order, and pointer ones return once the compositor has applied them, so a screenshot straight after reflects them. press/release hold a mouse button across calls (long press, drag); a key is always pressed and released within its own directive.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list (or the id returned by wayland_session_create). |
| `window` | integer | no | Window to raise and focus before the directives, so keyboard input lands in it. Window id from wayland_windows; omit to type into whatever already has focus. Pointer directives ignore it. |
| `actions` | array of object | yes | Ordered directives; each one finishes before the next starts. |

Each `actions[]` entry is exactly one of these directives:

#### `actions[]` — `do: "move"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(move) | yes |  |
| `to` | array of number | yes | Where to move to, as [x, y] in session pixels |


#### `actions[]` — `do: "press"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(press) | yes |  |
| `button` | enum(left, middle, right) | yes | Which button to hold down |


#### `actions[]` — `do: "release"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(release) | yes |  |
| `button` | enum(left, middle, right) | yes | Which button to release |


#### `actions[]` — `do: "scroll"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(scroll) | yes |  |
| `by` | array of number | yes | Wheel steps as [dx, dy]; positive y scrolls down |


#### `actions[]` — `do: "wait"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(wait) | yes |  |
| `ms` | integer | yes | How long to wait, in milliseconds (0-60000) |


#### `actions[]` — `do: "raise"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(raise) | yes |  |
| `window` | integer | yes | Window id from wayland_windows |


#### `actions[]` — `do: "click"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(click) | yes |  |
| `at` | array of number | no | Where to click, as [x, y]; omit to click where the cursor already is |
| `button` | enum(left, middle, right) | no | Which button (default left) |
| `times` | integer | no | How many clicks in a row, 1-20 (default 1) |


#### `actions[]` — `do: "drag"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(drag) | yes |  |
| `from` | array of number | no | Where to start, as [x, y]; omit to start where the cursor is |
| `to` | array of number | yes | Where to drop, as [x, y] |
| `button` | enum(left, middle, right) | no | Which button to drag with (default left) |


#### `actions[]` — `do: "type"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(type) | yes |  |
| `text` | string | yes | Characters to type; ASCII is typed key by key, anything else is pasted with Ctrl+V |


#### `actions[]` — `do: "key"`

| field | type | required | description |
|---|---|---|---|
| `do` | enum(key) | yes |  |
| `keys` | string | yes | A chord such as "Return", "ctrl+shift+t" or "a" |
| `times` | integer | no | How many times to press it, 1-20 (default 1) |


