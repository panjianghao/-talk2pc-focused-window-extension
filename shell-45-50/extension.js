// Talk2PC Focused Window Bridge — GNOME Shell 45–50 (ES modules)
//
// Derived from the original wdotool GNOME Shell bridge by cushycush.
// Provides focused-window geometry, virtual-keyboard injection, and pointer
// injection so Talk2PC can paste/type/click on GNOME 43–50 without the
// RemoteDesktop portal or /dev/uinput.
//
// D-Bus interface matches the 43–44 legacy package exactly so clients can
// use one probe path for the whole 43–50 range.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.gnome.Shell.Extensions.Talk2PCFocusedWindow';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/Talk2PCFocusedWindow';
/**
 * Bump when D-Bus surface changes.
 * 4 = geometry + PressKey + pointer + ScreenshotArea.
 */
const API_VERSION = 4;
/** Client scroll deltas: 40 units == one wheel notch (same as X11 path). */
const SCROLL_UNITS_PER_NOTCH = 40;

const IFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.Talk2PCFocusedWindow">
    <method name="GetApiVersion">
      <arg type="u" direction="out" name="version"/>
    </method>
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
    <method name="PressKey">
      <arg type="s" direction="in" name="keysym"/>
      <arg type="s" direction="in" name="direction"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MovePointerRelative">
      <arg type="i" direction="in" name="dx"/>
      <arg type="i" direction="in" name="dy"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MovePointerAbsolute">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MouseButton">
      <arg type="u" direction="in" name="button"/>
      <arg type="s" direction="in" name="direction"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="MouseScroll">
      <arg type="d" direction="in" name="dx"/>
      <arg type="d" direction="in" name="dy"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ScreenshotArea">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
      <arg type="s" direction="in" name="filename"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
  </interface>
</node>`;

const KEY_ALIASES = {
    ctrl: 'Control_L',
    control: 'Control_L',
    control_l: 'Control_L',
    control_r: 'Control_R',
    alt: 'Alt_L',
    meta: 'Alt_L',
    alt_l: 'Alt_L',
    alt_r: 'Alt_R',
    shift: 'Shift_L',
    shift_l: 'Shift_L',
    shift_r: 'Shift_R',
    super: 'Super_L',
    win: 'Super_L',
    logo: 'Super_L',
    super_l: 'Super_L',
    super_r: 'Super_R',
    enter: 'Return',
    return: 'Return',
    esc: 'Escape',
    escape: 'Escape',
    space: 'space',
    backspace: 'BackSpace',
    delete: 'Delete',
    del: 'Delete',
    tab: 'Tab',
    insert: 'Insert',
    pageup: 'Page_Up',
    pagedown: 'Page_Down',
};

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
    for (const w of global.get_window_actors().map((a) => a.meta_window)) {
        if (!w || w.is_override_redirect())
            continue;
        if (windowId(w) === id)
            return w;
    }
    return null;
}

/**
 * Resolve X11-style keysym names to keyvals without Gdk/Gtk/Adw.
 * EGO-I-002 forbids GTK libraries in shell-process extension files.
 * Clutter.KEY_* constants match the same keyval namespace as Gdk.
 */
function keyvalFromName(name) {
    if (!name)
        return 0;
    // X11 keysym names for media/browser keys keep the XF86 prefix
    // (XF86AudioRaiseVolume), while Clutter's KEY_* constants drop it
    // (KEY_AudioRaiseVolume). Try both so every Shell version resolves them.
    const candidates = [`KEY_${name}`];
    if (name.startsWith('XF86'))
        candidates.push(`KEY_${name.slice(4)}`);
    for (const prop of candidates) {
        if (!(prop in Clutter))
            continue;
        const keyval = Clutter[prop];
        if (typeof keyval === 'number' && keyval)
            return keyval;
    }
    return 0;
}

/** Minimal Gdk.unicode_to_keyval-compatible mapping for BMP code points. */
function unicodeToKeyval(code) {
    if (code < 0x100)
        return code;
    return 0x01000000 | code;
}

function resolveKeyval(keysym) {
    if (!keysym)
        return 0;
    const raw = String(keysym).trim();
    if (!raw)
        return 0;

    const lower = raw.toLowerCase();
    const canonical = KEY_ALIASES[lower] || raw;

    let keyval = keyvalFromName(canonical);
    if (keyval)
        return keyval;

    if (canonical.length === 1)
        return unicodeToKeyval(canonical.charCodeAt(0));

    // F-keys often arrive as "f1" / "F1".
    if (/^f\d{1,2}$/i.test(canonical)) {
        keyval = keyvalFromName(canonical.toUpperCase());
        if (keyval)
            return keyval;
    }

    return 0;
}

export default class WdotoolExtension extends Extension {
    enable() {
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
        this._virtualKeyboard = null;
        this._virtualPointer = null;
        this._scrollAccumX = 0;
        this._scrollAccumY = 0;
    }

    disable() {
        if (this._impl) {
            this._impl.unexport();
            this._impl = null;
        }
        if (this._busOwnerId) {
            Gio.bus_unown_name(this._busOwnerId);
            this._busOwnerId = 0;
        }
        this._virtualKeyboard = null;
        this._virtualPointer = null;
        this._scrollAccumX = 0;
        this._scrollAccumY = 0;
    }

    _keyboard() {
        if (!this._virtualKeyboard) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._virtualKeyboard = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE
            );
        }
        return this._virtualKeyboard;
    }

    _pointer() {
        if (!this._virtualPointer) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._virtualPointer = seat.create_virtual_device(
                Clutter.InputDeviceType.POINTER_DEVICE
            );
        }
        return this._virtualPointer;
    }

    GetApiVersion() {
        return API_VERSION;
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

    /**
     * Grab an area of the screen into a PNG file.
     *
     * Coordinates are **stage (logical) coordinates** — the same space
     * GetPointerPosition / GetWindowGeometry report. Shell.Screenshot scales
     * to the monitor's device resolution itself, so a HiDPI capture comes out
     * at native pixels.
     *
     * `wrapJSObject` replies as soon as the method returns (it does not await
     * Promises), so the async capture is waited on with a nested main loop:
     * the D-Bus caller then sees `true` only after the file is complete. The
     * watchdog bounds the wait if the compositor never calls back.
     */
    ScreenshotArea(x, y, width, height, filename) {
        const areaX = Math.round(Number(x)) || 0;
        const areaY = Math.round(Number(y)) || 0;
        const areaWidth = Math.round(Number(width)) || 0;
        const areaHeight = Math.round(Number(height)) || 0;
        const path = String(filename || '');
        if (areaWidth <= 0 || areaHeight <= 0 || !path)
            return false;

        let stream;
        try {
            const file = Gio.File.new_for_path(path);
            stream = file.replace(
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (_e) {
            return false;
        }

        const loop = new GLib.MainLoop(null, false);
        let done = false;
        let ok = false;
        let timedOut = false;
        const watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            timedOut = true;
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });

        try {
            const shooter = new Shell.Screenshot();
            shooter.screenshot_area(
                areaX,
                areaY,
                areaWidth,
                areaHeight,
                stream,
                (source, result) => {
                    try {
                        source.screenshot_area_finish(result);
                        ok = true;
                    } catch (e) {
                        logError(e, 'Talk2PC: screenshot_area failed');
                    } finally {
                        done = true;
                        loop.quit();
                    }
                }
            );
            // A synchronous callback (not expected) must not hang the loop.
            if (!done)
                loop.run();
        } catch (e) {
            logError(e, 'Talk2PC: screenshot_area failed');
        } finally {
            if (!timedOut)
                GLib.source_remove(watchdog);
            try {
                stream.close(null);
            } catch (_e) {
                // Already closed / failed: the file check below decides.
            }
        }

        if (!done || !ok || timedOut) {
            try {
                Gio.File.new_for_path(path).delete(null);
            } catch (_e) {
                // A leftover temp file is not worth failing the call over.
            }
            return false;
        }
        return true;
    }

    /**
     * Inject a key via Clutter virtual keyboard.
     * @param {string} keysym X11-style keysym (Control_L, v, Return, …)
     * @param {string} direction "press" | "release" | "click" (default click)
     */
    PressKey(keysym, direction) {
        const keyval = resolveKeyval(keysym);
        if (!keyval)
            return false;

        const dir = String(direction || 'click').toLowerCase();
        const kb = this._keyboard();
        const time = global.get_current_time();

        try {
            if (dir === 'press' || dir === 'click' || dir === 'pressrelease')
                kb.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
            if (dir === 'release' || dir === 'click' || dir === 'pressrelease')
                kb.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
            return true;
        } catch (_e) {
            return false;
        }
    }

    /** Microsecond timestamp expected by Clutter virtual input devices. */
    _pointerTime() {
        return global.get_current_time() * 1000;
    }

    /**
     * Inject relative pointer motion.
     * @param {number} dx horizontal delta in stage pixels
     * @param {number} dy vertical delta in stage pixels
     */
    MovePointerRelative(dx, dy) {
        try {
            this._pointer().notify_relative_motion(
                this._pointerTime(),
                Number(dx) || 0,
                Number(dy) || 0
            );
            return true;
        } catch (_e) {
            return false;
        }
    }

    /** Warp the pointer to absolute stage coordinates. */
    MovePointerAbsolute(x, y) {
        try {
            this._pointer().notify_absolute_motion(
                this._pointerTime(),
                Number(x) || 0,
                Number(y) || 0
            );
            return true;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Inject a pointer button event.
     * @param {number} button xdotool index: 1 left, 2 middle, 3 right, 8/9 back/forward
     * @param {string} direction "press" | "release" | "click" (default click)
     */
    MouseButton(button, direction) {
        const btn = Number(button) || 1;
        const dir = String(direction || 'click').toLowerCase();
        try {
            const pointer = this._pointer();
            const time = this._pointerTime();
            if (dir === 'press' || dir === 'click' || dir === 'pressrelease')
                pointer.notify_button(time, btn, Clutter.ButtonState.PRESSED);
            if (dir === 'release' || dir === 'click' || dir === 'pressrelease')
                pointer.notify_button(time, btn, Clutter.ButtonState.RELEASED);
            return true;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Inject scroll wheel notches. Deltas accumulate across calls: 40 units
     * are one notch, matching the X11 fallback's convention.
     * @param {number} dx positive scrolls right
     * @param {number} dy positive scrolls down
     */
    MouseScroll(dx, dy) {
        this._scrollAccumX += Number(dx) || 0;
        this._scrollAccumY += Number(dy) || 0;

        let notchesX = Math.trunc(this._scrollAccumX / SCROLL_UNITS_PER_NOTCH);
        let notchesY = Math.trunc(this._scrollAccumY / SCROLL_UNITS_PER_NOTCH);
        // Guard against a malformed burst locking up the shell.
        notchesX = Math.max(-8, Math.min(8, notchesX));
        notchesY = Math.max(-8, Math.min(8, notchesY));
        this._scrollAccumX -= notchesX * SCROLL_UNITS_PER_NOTCH;
        this._scrollAccumY -= notchesY * SCROLL_UNITS_PER_NOTCH;

        try {
            const pointer = this._pointer();
            const time = this._pointerTime();
            while (notchesX > 0) {
                pointer.notify_discrete_scroll(
                    time,
                    Clutter.ScrollDirection.RIGHT,
                    Clutter.ScrollSource.WHEEL
                );
                notchesX--;
            }
            while (notchesX < 0) {
                pointer.notify_discrete_scroll(
                    time,
                    Clutter.ScrollDirection.LEFT,
                    Clutter.ScrollSource.WHEEL
                );
                notchesX++;
            }
            while (notchesY > 0) {
                pointer.notify_discrete_scroll(
                    time,
                    Clutter.ScrollDirection.DOWN,
                    Clutter.ScrollSource.WHEEL
                );
                notchesY--;
            }
            while (notchesY < 0) {
                pointer.notify_discrete_scroll(
                    time,
                    Clutter.ScrollDirection.UP,
                    Clutter.ScrollSource.WHEEL
                );
                notchesY++;
            }
            return true;
        } catch (_e) {
            return false;
        }
    }
}
