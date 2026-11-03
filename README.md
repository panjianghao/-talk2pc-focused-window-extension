# Talk2PC Focused Window Bridge

Your laptop microphone sounds bad, the system input method covers too few
languages, and typing is slow. Talk2PC routes input through your phone instead:
dictate, handwrite, or enter special characters on the phone, and the text is
written straight into the focused window. Phone microphones are usually better
and phone keyboards cover more languages and characters, so voice input,
handwriting, and write-as-you-translate work the way you are used to.

The phone also works as a wireless mouse and keyboard — tilt or swipe to move
the pointer while standing or walking. Send files to the computer, and keep the
clipboard in sync in both directions.

For teachers: photograph student work with the phone, then zoom, annotate and
explain it on the projector while controlling the slides. The presentation
pointer and spotlight overlay are drawn directly by this extension.

> ### Get the Talk2PC desktop app
>
> **[Download at talk2pc.lycheenow.com](https://talk2pc.lycheenow.com)**
>
> Install the app first. The extension has no visible interface on its own.

This extension is the GNOME Shell bridge for Talk2PC, not a standalone
application — installing it alone produces no visible interface. After you
install and run the Talk2PC desktop app from
[talk2pc.lycheenow.com](https://talk2pc.lycheenow.com), the interface and all
features are provided by the desktop and phone apps. The extension itself only
exposes interfaces on the session bus for focused-window identity, pointer
position, virtual keyboard and pointer injection, and area screenshots. It
opens no network ports and collects no telemetry.

---

GNOME Shell extension for Talk2PC (and wdotool) — supports **GNOME Shell 43–51**.

## Purpose

Expose over the session bus:

1. **Geometry** — focused window identity, pointer position, and frame rect so
   Talk2PC can place its desktop overlay on GNOME Wayland.
2. **Key inject (API ≥ 2)** — Clutter virtual-keyboard `PressKey` so Talk2PC can
   send paste chords (`Ctrl+V` / `Ctrl+Shift+V`) and remote key events **without**
   the XDG RemoteDesktop portal on Shell 43–51.
3. **Pointer inject (API ≥ 3)** — Clutter virtual pointer `MovePointerRelative` /
   `MovePointerAbsolute` / `MouseButton` / `MouseScroll` so Talk2PC can move the
   cursor, click and scroll **without** the XDG RemoteDesktop portal or
   `/dev/uinput` on Shell 43–51.
4. **Screen capture (API ≥ 4)** — `ScreenshotArea(x, y, width, height, path)`
   grabs the exact stage rect through `Shell.Screenshot`, so the canvas `shot`
   flow needs no portal and no permission prompt.
5. **Presentation pointer (API ≥ 7)** — `SetPresentationPointer` draws a large
   cursor or spotlight highlight as a non-reactive Shell actor, so it never
   blocks clicks.

**Global shortcuts are not handled by this extension.** On GNOME:

- GNOME 48+ uses the XDG GlobalShortcuts portal
- Older GNOME uses system custom keybindings (`gsettings`) registered by the app

## Two packages (same UUID)

GNOME 45 switched to ES modules. Pre-45 and post-45 cannot share one
`extension.js`, so this repo ships two directories:

| Directory | Shell versions | Format |
| --- | --- | --- |
| `shell-43-44/` | 43, 44 | legacy `imports.gi` |
| `shell-45-51/` | 45, 46, 47, 48, 49, 50, 51 | ES modules |

Both use UUID `talk2pc-focused-window@talk2pc.github.io` and the same D-Bus
interface. On [extensions.gnome.org](https://extensions.gnome.org/), upload
both zips; the site serves the matching one per Shell version.

## D-Bus Interface

- Service: `org.gnome.Shell.Extensions.Talk2PCFocusedWindow`
- Object path: `/org/gnome/Shell/Extensions/Talk2PCFocusedWindow`
- Methods:
  - `GetApiVersion` → `u` (currently **8**)
  - `GetActiveWindow` → JSON string
  - `GetPointerPosition` → (x, y)
  - `GetWindowGeometry(id)` → (found, x, y, width, height)
  - `PressKey(keysym, direction)` → bool  
    `direction`: `press` | `release` | `click` (press+release)
  - `MovePointerRelative(dx, dy)` → bool
  - `MovePointerAbsolute(x, y)` → bool
  - `MouseButton(button, direction)` → bool  
    `button`: xdotool index (`1` left, `2` middle, `3` right, `8`/`9` back/forward);
    `direction`: `press` | `release` | `click`
  - `MouseScroll(dx, dy)` → bool  
    Deltas accumulate; `40` units = one wheel notch, positive `dy` scrolls down,
    positive `dx` scrolls right (same convention as the X11 path).
  - `ScreenshotArea(x, y, width, height, path)` → bool  
    Captures a stage/logical rect to `path` through `Shell.Screenshot`; HiDPI
    scaling is handled by Mutter.
  - `SetPresentationPointer(json)` / `HidePresentationPointer()` → bool  
    `json` carries appearance only
    (`mode`, `diameter`, `style`, `color`, `opacity`, `shape`, `width`,
    `height`, `cornerRadius`, `dimOpacity`).

## Install

```bash
# Example: GNOME 46
SRC=shell-45-51
# Example: GNOME 44
# SRC=shell-43-44

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/talk2pc-focused-window@talk2pc.github.io"
mkdir -p "$EXT_DIR"
cp "$SRC"/* "$EXT_DIR/"
gnome-extensions enable talk2pc-focused-window@talk2pc.github.io
```

Or pack for e.g.o:

```bash
(cd shell-45-51 && zip -r ../talk2pc-focused-window-45-51.shell-extension.zip extension.js metadata.json)
(cd shell-43-44 && zip -r ../talk2pc-focused-window-43-44.shell-extension.zip extension.js metadata.json)
```

Log out and back in on Wayland after install/update.

## Attribution

Derived from the original wdotool GNOME Shell bridge by cushycush
(https://github.com/cushycush/wdotool).
