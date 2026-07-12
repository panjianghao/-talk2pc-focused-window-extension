# Talk2PC Focused Window Bridge

Minimal GNOME Shell extension for Talk2PC (and wdotool geometry).

## Purpose

1. Expose focused window identity / pointer / frame geometry over the session bus
   so Talk2PC can place its desktop overlay on GNOME Wayland.
2. Provide **global shortcut grab** (`grab_accelerator`) when the XDG
   GlobalShortcuts portal is not available (typical GNOME &lt; 48).

## D-Bus Interface

- Service: `org.gnome.Shell.Extensions.Talk2PCFocusedWindow`
- Object path: `/org/gnome/Shell/Extensions/Talk2PCFocusedWindow`
- Methods:
  - `GetActiveWindow`
  - `GetPointerPosition`
  - `GetWindowGeometry`
  - `BindShortcut(id, accelerator) → bool`
  - `UnbindShortcut(id) → bool`
  - `UnbindAll()`
  - `ListShortcuts() → json`
  - `HasShortcutSupport() → bool`
- Signals:
  - `ShortcutActivated(id)`
  - `ShortcutDeactivated(id)` (best-effort hold release)

Accelerators accept GTK form (`<Control>a`) or portal-like form (`CTRL+a`).

## Files

- `extension.js`: GNOME Shell extension entry point
- `metadata.json`: GNOME extension manifest

## Local install

```bash
EXT="$HOME/.local/share/gnome-shell/extensions/talk2pc-focused-window@talk2pc.github.io"
mkdir -p "$EXT"
cp extension.js metadata.json "$EXT/"
# Wayland: log out/in. X11: Alt+F2 → r
gnome-extensions enable talk2pc-focused-window@talk2pc.github.io
```

## Publish (extensions.gnome.org)

See `../wdotool/publish/gnome-geometry-extension/README.md`.

## Attribution

Derived from the original wdotool GNOME Shell bridge by cushycush:
https://github.com/cushycush/wdotool
