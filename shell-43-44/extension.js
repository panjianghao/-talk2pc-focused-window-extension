// Talk2PC Focused Window Bridge — GNOME Shell 43–44 (legacy imports)
//
// Same D-Bus surface as the 45–50 ES-module package. GNOME 45 switched
// extensions to ESM, so pre-45 Shell cannot load that file format; this
// package is the matching implementation for 43–44 only.
//
// Geometry + virtual-keyboard injection (API version 2). Derived from the
// original wdotool GNOME Shell bridge by cushycush.

const { Gio, Shell, Clutter } = imports.gi;

const BUS_NAME = 'org.gnome.Shell.Extensions.Talk2PCFocusedWindow';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/Talk2PCFocusedWindow';
/** Bump when D-Bus surface changes. 2 = geometry + PressKey. */
const API_VERSION = 2;

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
    const prop = `KEY_${name}`;
    if (!(prop in Clutter))
        return 0;
    const keyval = Clutter[prop];
    return typeof keyval === 'number' && keyval ? keyval : 0;
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

function eventTime() {
    try {
        const t = Clutter.get_current_event_time();
        if (t)
            return t;
    } catch (_e) {
        // ignore
    }
    try {
        return global.get_current_time();
    } catch (_e) {
        return 0;
    }
}

class Extension {
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

    PressKey(keysym, direction) {
        const keyval = resolveKeyval(keysym);
        if (!keyval)
            return false;

        const dir = String(direction || 'click').toLowerCase();
        const kb = this._keyboard();
        const time = eventTime();

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
}

function init() {
    return new Extension();
}
