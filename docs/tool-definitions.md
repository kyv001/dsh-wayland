# Model-facing tool definitions

This is the exact text the model reads for this plugin's tools (rendered from
the live definitions, not hand-copied). Descriptions carry the purpose, when to
use the tool, and what it returns; defaults, units and id provenance live on the
parameters they belong to.

8 tools, 10824 characters of schema in total.

## `wayland_session_create`

Start a private headless Wayland desktop (sway) that the user can watch live in the DSH right sidebar, and return the session id the other wayland_* tools take. Use it when a task needs a window. A session starts empty (wayland_launch starts programs), lives as long as DSH does, and only a few may exist at once.

| parameter | type | required | description |
|---|---|---|---|
| `name` | string | no | Label shown in the session list and in the sidebar panel. |
| `width` | integer | no | Screen width in pixels (default 1280). Positive integer. |
| `height` | integer | no | Screen height in pixels (default 800). Larger screens cost more CPU per live-view frame. |

## `wayland_session_list`

List the virtual desktops that exist right now — id, name, size, how many programs each has started, and whether its compositor is still alive. Call it first when earlier work may have left a desktop running instead of creating another one.

*No parameters.*

## `wayland_check`

Check this plugin's health: the toolchain, whether those binaries actually run, whether the session root is writable, whether a cursor theme was found, and a health line per live session. Run it once before you start using the wayland_* tools, and again when one reports missing dependencies or a session misbehaves. Always succeeds and changes nothing.

*No parameters.*

## `wayland_session_close`

Shut a virtual desktop down: every program started in it is terminated, its windows disappear, and its run directory is removed. Close desktops you have finished with rather than leaving them running. The id must name a live session — closing one twice, or an unknown id, is an error.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list or wayland_session_create. |

## `wayland_launch`

Run a program on a virtual desktop and return its pid plus what became of its window (`window`, `exited`, `timeout`, or `skipped` when wait was false). Its output goes to the session log, not this result. For shell syntax, use the bash tool — or a terminal inside the session: `command: "foot", args: ["-e", "bash", "-c", "…"]`, whose output stays on that screen (read it with wayland_screenshot) rather than in the session log. A GUI toolkit needs a second or two to draw, so give it a moment before screenshotting.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list or wayland_session_create. |
| `command` | string | yes | Executable to run: a name on PATH or an absolute path. |
| `args` | array of string | no | Command-line arguments; each entry becomes one argv entry, exactly as given. |
| `env` | object | no | Extra environment variables as an object of names to values, merged over the session's own environment (values are stringified). DISPLAY comes from the session and cannot be overridden here. |
| `cwd` | string | no | Working directory (default: the DSH process's home directory). |
| `wait` | boolean | no | Wait for a window before returning, up to waitMs (default true). Set false for programs that open no window. |
| `waitMs` | integer | no | How long to wait for that window, in milliseconds (default 8000; the call blocks meanwhile). Ignored when wait is false. |

## `wayland_windows`

List the windows currently mapped on a virtual desktop: window id, app id (or X11 class), title, pid, which one has keyboard focus, and each absolute rect in session pixels. These ids are what wayland_screenshot takes as window and wayland_input takes in a focus action. An empty list means nothing is mapped yet — a program still starting, or one that failed to open a window; pid is left out when the compositor does not know it.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list or wayland_session_create. |

## `wayland_screenshot`

Capture what a virtual desktop looks like and return it as an image you can see, grabbed during this call. Use it to read GUI state and check that earlier input took effect. At the default scale the image is session pixels, so what you see is where pointer actions land; `origin` and `scale` carry the mapping back to input coordinates. Capture one `region` instead of the whole screen to spend less on the image and read a small area at full resolution. Pass `grid` when you need to know *where* something is: it prints the session coordinates onto the picture. The pointer is drawn at its current position; wayland_check reports the cursor theme in use. Errors if window is not currently mapped.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list or wayland_session_create. |
| `window` | integer | no | Window id from wayland_windows; omit to capture the whole screen. |
| `region` | object | no | Area to capture, in absolute session pixels. Overrides `window`. A region running past the screen edge is clipped, not rejected. |
| `region.x` | integer | yes | Left edge in session pixels. |
| `region.y` | integer | yes | Top edge in session pixels. |
| `region.width` | integer | yes | Width in session pixels. |
| `region.height` | integer | yes | Height in session pixels. |
| `grid` | number | no | Draw a coordinate grid with a rule every N session pixels, each rule labelled with the session coordinate it sits on — x values along the top edge, y values down the left edge. Read the label and pass that number straight to wayland_input: no arithmetic, and no estimating a position from a picture. The label is always the coordinate wayland_input takes even when the capture is magnified, because the rules are drawn after scaling. Minimum 5; 50 or 100 is usually right. Forces a PNG capture. |
| `scale` | number | no | Size multiplier: 1 captures native pixels (one image pixel per session pixel), 2 doubles both dimensions so small text becomes legible, 0.5 halves them. The image is session pixels × scale. |

## `wayland_input`

Send input to a virtual desktop as an ordered list of directives; each entry is exactly one of ten — move, press, release, scroll, wait, raise, click, drag, type, key. Key and text events go to the focused window, so pass window to raise and focus one first; pointer events go to whatever is under the cursor. Directives run strictly in order, and pointer ones return once the compositor has applied them, so a screenshot straight after reflects them. press/release hold a mouse button across calls (long press, drag); a key is always pressed and released within its own directive.

| parameter | type | required | description |
|---|---|---|---|
| `session` | string | yes | Session id from wayland_session_list or wayland_session_create. |
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


