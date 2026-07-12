// Talk2PC Focused Window + Global Shortcut Bridge
//
// Derived from the original wdotool GNOME Shell bridge by cushycush.
// Provides:
//   1) focused-window identity / pointer / geometry (no generic external API on GNOME)
//   2) global shortcut grab via Meta.Display.grab_accelerator, exposed over D-Bus
//
// Shortcut path is the fallback when XDG GlobalShortcuts portal is unavailable
// (pre-GNOME 48). Prefer the portal when present.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.gnome.Shell.Extensions.Talk2PCFocusedWindow';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/Talk2PCFocusedWindow';

const IFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.Talk2PCFocusedWindow">
    <method name="GetActiveWindow">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="GetPointerPosition">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
    <method name="GetWindowGeometry">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="out" name="found"/>
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="width"/>
      <arg type="i" direction="out" name="height"/>
    </method>
    <method name="BindShortcut">
      <arg type="s" direction="in" name="id"/>
      <arg type="s" direction="in" name="accelerator"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="UnbindShortcut">
      <arg type="s" direction="in" name="id"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="UnbindAll"/>
    <method name="ListShortcuts">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="HasShortcutSupport">
      <arg type="b" direction="out" name="ok"/>
    </method>
    <signal name="ShortcutActivated">
      <arg type="s" name="id"/>
    </signal>
    <signal name="ShortcutDeactivated">
      <arg type="s" name="id"/>
    </signal>
  </interface>
</node>`;

function windowId(w) {
    return String(w.get_stable_sequence());
}

function windowJson(w) {
    const tracker = Shell.WindowTracker.get_default();
    const app = tracker.get_window_app(w);
    return {
        id: windowId(w),
        title: w.get_title() || '',
        app_id: app ? app.get_id() : null,
        pid: w.get_pid() || null,
    };
}

function findById(id) {
    for (const w of global.get_window_actors().map(a => a.meta_window)) {
        if (!w || w.is_override_redirect())
            continue;
        if (windowId(w) === id)
            return w;
    }
    return null;
}

/**
 * Normalize a few common non-GTK accelerator spellings into GTK form.
 * Accepts: "<Control>a", "CTRL+a", "Control_L", "CTRL+SHIFT+F8"
 */
function normalizeAccelerator(raw) {
    if (!raw || typeof raw !== 'string')
        return '';
    const trimmed = raw.trim();
    if (!trimmed)
        return '';
    if (trimmed.startsWith('<') || trimmed.includes('_'))
        return trimmed;

    const parts = trimmed.split('+').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0)
        return '';

    const mods = [];
    let key = '';
    for (const part of parts) {
        const upper = part.toUpperCase();
        if (upper === 'CTRL' || upper === 'CONTROL' || upper === 'PRIMARY') {
            mods.push('<Control>');
            continue;
        }
        if (upper === 'ALT' || upper === 'MOD1') {
            mods.push('<Alt>');
            continue;
        }
        if (upper === 'SHIFT') {
            mods.push('<Shift>');
            continue;
        }
        if (upper === 'LOGO' || upper === 'SUPER' || upper === 'META' ||
            upper === 'WIN' || upper === 'MOD4') {
            mods.push('<Super>');
            continue;
        }
        key = part;
    }

    if (!key) {
        // Modifier-only: grab left control / alt / shift / super by keysym name.
        if (mods.length === 1 && mods[0] === '<Control>')
            return 'Control_L';
        if (mods.length === 1 && mods[0] === '<Alt>')
            return 'Alt_L';
        if (mods.length === 1 && mods[0] === '<Shift>')
            return 'Shift_L';
        if (mods.length === 1 && mods[0] === '<Super>')
            return 'Super_L';
        return mods.join('');
    }

    // Single letter keys are case-sensitive in GTK accel (lowercase = letter).
    if (key.length === 1) {
        const code = key.charCodeAt(0);
        if (code >= 65 && code <= 90)
            key = key.toLowerCase();
    }
    return `${mods.join('')}${key}`;
}

function keysymNamesForAccelerator(accel) {
    // Best-effort set of keysym names used to detect KEY_RELEASE after grab.
    const names = new Set();
    if (!accel)
        return names;

    if (accel.includes('Control') || accel === 'Control_L' || accel === 'Control_R') {
        names.add('Control_L');
        names.add('Control_R');
        names.add('Control');
    }
    if (accel.includes('Alt') || accel === 'Alt_L' || accel === 'Alt_R') {
        names.add('Alt_L');
        names.add('Alt_R');
        names.add('Alt');
    }
    if (accel.includes('Shift') || accel === 'Shift_L' || accel === 'Shift_R') {
        names.add('Shift_L');
        names.add('Shift_R');
        names.add('Shift');
    }
    if (accel.includes('Super') || accel.includes('Meta') ||
        accel === 'Super_L' || accel === 'Super_R') {
        names.add('Super_L');
        names.add('Super_R');
        names.add('Meta_L');
        names.add('Meta_R');
        names.add('Super');
        names.add('Meta');
    }

    // Primary non-modifier key: strip GTK mod tags.
    const primary = accel.replace(/<[^>]+>/g, '').trim();
    if (primary && !primary.endsWith('_L') && !primary.endsWith('_R') &&
        !['Control', 'Alt', 'Shift', 'Super', 'Meta'].includes(primary)) {
        names.add(primary);
        if (primary.length === 1)
            names.add(primary.toLowerCase());
        if (primary.length === 1)
            names.add(primary.toUpperCase());
    } else if (primary) {
        names.add(primary);
    }
    return names;
}

function eventMatchesKeyNames(event, names) {
    if (!names || names.size === 0)
        return false;
    let keyval = 0;
    try {
        keyval = event.get_key_symbol();
    } catch (_) {
        return false;
    }
    // Compare against Clutter.KEY_* when present.
    for (const name of names) {
        const constName = `KEY_${name}`;
        if (Clutter[constName] !== undefined && Clutter[constName] === keyval)
            return true;
        // Also try common aliases.
        const alt = `KEY_${name.replace(/_/g, '')}`;
        if (Clutter[alt] !== undefined && Clutter[alt] === keyval)
            return true;
    }
    // Letter keys: Clutter.KEY_a etc.
    for (const name of names) {
        if (name.length === 1) {
            const lower = `KEY_${name.toLowerCase()}`;
            if (Clutter[lower] !== undefined && Clutter[lower] === keyval)
                return true;
        }
    }
    return false;
}

export default class WdotoolExtension extends Extension {
    enable() {
        this._bindings = new Map(); // id -> {action, accelerator, keyNames, held}
        this._actionToId = new Map(); // action number -> id
        this._accelHandlerId = 0;
        this._stageHandlerId = 0;

        this._impl = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);
        this._busOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null,
            null
        );

        this._accelHandlerId = global.display.connect(
            'accelerator-activated',
            (_display, action, _deviceId, _timestamp) => {
                this._onAcceleratorActivated(action);
            }
        );

        // Best-effort release detection for hold-to-talk. Works when the
        // shell still sees the KEY_RELEASE (common for grabbed accelerators).
        this._stageHandlerId = global.stage.connect(
            'captured-event',
            (_actor, event) => {
                return this._onStageEvent(event);
            }
        );
    }

    disable() {
        this.UnbindAll();

        if (this._stageHandlerId) {
            global.stage.disconnect(this._stageHandlerId);
            this._stageHandlerId = 0;
        }
        if (this._accelHandlerId) {
            global.display.disconnect(this._accelHandlerId);
            this._accelHandlerId = 0;
        }
        if (this._impl) {
            this._impl.unexport();
            this._impl = null;
        }
        if (this._busOwnerId) {
            Gio.bus_unown_name(this._busOwnerId);
            this._busOwnerId = 0;
        }
        this._bindings = null;
        this._actionToId = null;
    }

    GetActiveWindow() {
        const w = global.display.focus_window;
        return w ? JSON.stringify(windowJson(w)) : 'null';
    }

    GetPointerPosition() {
        const [x, y] = global.get_pointer();
        return [x | 0, y | 0];
    }

    GetWindowGeometry(id) {
        const w = findById(id);
        if (!w)
            return [false, 0, 0, 0, 0];
        const r = w.get_frame_rect();
        return [true, r.x | 0, r.y | 0, r.width | 0, r.height | 0];
    }

    HasShortcutSupport() {
        return typeof global.display.grab_accelerator === 'function';
    }

    BindShortcut(id, accelerator) {
        if (!id || typeof id !== 'string')
            return false;
        const accel = normalizeAccelerator(accelerator);
        if (!accel)
            return false;

        // Replace existing binding with the same id.
        this.UnbindShortcut(id);

        let action = Meta.KeyBindingAction.NONE;
        try {
            const flags = Meta.KeyBindingFlags
                ? Meta.KeyBindingFlags.NONE
                : 0;
            action = global.display.grab_accelerator(accel, flags);
        } catch (e) {
            log(`Talk2PC: grab_accelerator(${accel}) failed: ${e}`);
            return false;
        }

        if (action === Meta.KeyBindingAction.NONE)
            return false;

        try {
            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
        } catch (e) {
            log(`Talk2PC: allowKeybinding failed: ${e}`);
        }

        const keyNames = keysymNamesForAccelerator(accel);
        this._bindings.set(id, {
            action,
            accelerator: accel,
            keyNames,
            held: false,
        });
        this._actionToId.set(action, id);
        return true;
    }

    UnbindShortcut(id) {
        if (!this._bindings || !this._bindings.has(id))
            return false;
        const entry = this._bindings.get(id);
        if (entry.held)
            this._emitDeactivated(id);
        try {
            global.display.ungrab_accelerator(entry.action);
        } catch (_) {
            // ignore
        }
        try {
            const name = Meta.external_binding_name_for_action(entry.action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
        } catch (_) {
            // ignore
        }
        this._actionToId.delete(entry.action);
        this._bindings.delete(id);
        return true;
    }

    UnbindAll() {
        if (!this._bindings)
            return;
        const ids = [...this._bindings.keys()];
        for (const id of ids)
            this.UnbindShortcut(id);
    }

    ListShortcuts() {
        if (!this._bindings)
            return '[]';
        const out = [];
        for (const [id, entry] of this._bindings.entries()) {
            out.push({
                id,
                accelerator: entry.accelerator,
                held: !!entry.held,
            });
        }
        return JSON.stringify(out);
    }

    _onAcceleratorActivated(action) {
        if (!this._actionToId || !this._bindings)
            return;
        const id = this._actionToId.get(action);
        if (!id)
            return;
        const entry = this._bindings.get(id);
        if (!entry)
            return;
        if (entry.held) {
            // Second press while still marked held → force release first.
            this._emitDeactivated(id);
        }
        entry.held = true;
        this._emitActivated(id);
    }

    _onStageEvent(event) {
        if (!this._bindings)
            return Clutter.EVENT_PROPAGATE;
        let type;
        try {
            type = event.type();
        } catch (_) {
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.KEY_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        for (const [id, entry] of this._bindings.entries()) {
            if (!entry.held)
                continue;
            if (eventMatchesKeyNames(event, entry.keyNames)) {
                this._emitDeactivated(id);
                // Do not swallow: other grabs/handlers may need the release.
                return Clutter.EVENT_PROPAGATE;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _emitActivated(id) {
        this._emitSignal('ShortcutActivated', id);
    }

    _emitDeactivated(id) {
        const entry = this._bindings?.get(id);
        if (entry)
            entry.held = false;
        this._emitSignal('ShortcutDeactivated', id);
    }

    _emitSignal(name, id) {
        if (!this._impl)
            return;
        try {
            this._impl.emit_signal(name, GLib.Variant.new('(s)', [id]));
        } catch (e) {
            log(`Talk2PC: emit ${name} failed: ${e}`);
        }
    }
}
