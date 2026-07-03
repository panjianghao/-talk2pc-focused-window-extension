# Talk2PC Focused Window Bridge

Minimal GNOME Shell extension for Talk2PC.

## Purpose

This extension exposes the currently focused window identity and frame geometry
over the GNOME session bus so Talk2PC can place its desktop overlay correctly
on GNOME Wayland.

## D-Bus Interface

- Service: `org.gnome.Shell.Extensions.Talk2PCFocusedWindow`
- Object path: `/org/gnome/Shell/Extensions/Talk2PCFocusedWindow`
- Methods:
  - `GetActiveWindow`
  - `GetWindowGeometry`

## Files

- `extension.js`: GNOME Shell extension entry point
- `metadata.json`: GNOME extension manifest

## Attribution

Derived from the original wdotool GNOME Shell bridge by cushycush:
https://github.com/cushycush/wdotool
