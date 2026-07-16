# Talk2PC Focused Window Bridge

Minimal GNOME Shell extension for Talk2PC (and wdotool geometry).

## Purpose

Expose focused window identity, pointer position, and frame geometry over the
session bus so Talk2PC can place its desktop overlay on GNOME Wayland.

**Global shortcuts are not handled by this extension.** On GNOME:

- GNOME 48+ uses the XDG GlobalShortcuts portal
- Older GNOME uses system custom keybindings (`gsettings`) registered by the app

## D-Bus Interface

- Service: `org.gnome.Shell.Extensions.Talk2PCFocusedWindow`
- Object path: `/org/gnome/Shell/Extensions/Talk2PCFocusedWindow`
- Methods:
  - `GetActiveWindow` → JSON string
  - `GetPointerPosition` → (x, y)
  - `GetWindowGeometry(id)` → (found, x, y, width, height)

## Install

```bash
gnome-extensions pack
# or copy into ~/.local/share/gnome-shell/extensions/talk2pc-focused-window@talk2pc.github.io/
gnome-extensions enable talk2pc-focused-window@talk2pc.github.io
```

Log out and back in on Wayland after install/update.
