# Talk2PC Focused Window Bridge

Minimal GNOME Shell extension for Talk2PC (and wdotool geometry).

Supports **GNOME Shell 43–50**.

## Purpose

Expose focused window identity, pointer position, and frame geometry over the
session bus so Talk2PC can place its desktop overlay on GNOME Wayland.

**Global shortcuts are not handled by this extension.** On GNOME:

- GNOME 48+ uses the XDG GlobalShortcuts portal
- Older GNOME uses system custom keybindings (`gsettings`) registered by the app

## Two packages (same UUID)

GNOME 45 switched to ES modules. Pre-45 and post-45 cannot share one
`extension.js`, so this repo ships two directories:

| Directory | Shell versions | Format |
| --- | --- | --- |
| `shell-43-44/` | 43, 44 | legacy `imports.gi` |
| `shell-45-50/` | 45, 46, 47, 48, 49, 50 | ES modules |

Both use UUID `talk2pc-focused-window@talk2pc.github.io` and the same D-Bus
interface. On [extensions.gnome.org](https://extensions.gnome.org/), upload
both zips; the site serves the matching one per Shell version.

## D-Bus Interface

- Service: `org.gnome.Shell.Extensions.Talk2PCFocusedWindow`
- Object path: `/org/gnome/Shell/Extensions/Talk2PCFocusedWindow`
- Methods:
  - `GetActiveWindow` → JSON string
  - `GetPointerPosition` → (x, y)
  - `GetWindowGeometry(id)` → (found, x, y, width, height)

## Install

```bash
# Example: GNOME 46
SRC=shell-45-50
# Example: GNOME 44
# SRC=shell-43-44

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/talk2pc-focused-window@talk2pc.github.io"
mkdir -p "$EXT_DIR"
cp "$SRC"/* "$EXT_DIR/"
gnome-extensions enable talk2pc-focused-window@talk2pc.github.io
```

Or pack for e.g.o:

```bash
(cd shell-45-50 && zip -r ../talk2pc-focused-window-45-50.shell-extension.zip extension.js metadata.json)
(cd shell-43-44 && zip -r ../talk2pc-focused-window-43-44.shell-extension.zip extension.js metadata.json)
```

Log out and back in on Wayland after install/update.

## Attribution

Derived from the original wdotool GNOME Shell bridge by cushycush
(https://github.com/cushycush/wdotool).
