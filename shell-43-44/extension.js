// Talk2PC Focused Window Bridge — GNOME Shell 43–44 (legacy imports)
//
// Derived from the original wdotool GNOME Shell bridge by cushycush.
// Provides focused-window geometry, virtual-keyboard injection, and pointer
// injection so Talk2PC can paste/type/click on GNOME 43–44 without the
// RemoteDesktop portal or /dev/uinput.
//
// D-Bus interface matches the 45–51 ES-module package exactly so clients can
// use one probe path for the whole 43–51 range.
const { Gio, GLib, Shell, Clutter, St } = imports.gi;
const Main = imports.ui.main;
// Cairo's GI namespace is lowercase.
const Cairo = imports.gi.cairo;

const BUS_NAME = 'org.gnome.Shell.Extensions.Talk2PCFocusedWindow';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/Talk2PCFocusedWindow';
/**
 * Bump when the D-Bus surface changes.
 * 8 = geometry + PressKey + pointer + ScreenshotArea + presentation pointer.
 */
const API_VERSION = 8;
/** Pointer poll interval in milliseconds. */
const POINTER_POLL_INTERVAL_MS = 16;
/** Client scroll deltas: 40 units == one wheel notch. */
const SCROLL_UNITS_PER_NOTCH = 40;
/** Notches emitted per MouseScroll call. */
const MAX_NOTCHES_PER_CALL = 8;
/** Upper bound for overlay sizes. */
const POINTER_MAX_SIZE = 4096;
/** Valid Clutter pointer buttons are 1–12. */
const MAX_MOUSE_BUTTON = 12;
/** Screenshot timeout in milliseconds. */
const SCREENSHOT_TIMEOUT_MS = 3000;
/** Screenshot area cap in stage pixels; also bounds the captured surface. */
const MAX_SCREENSHOT_PIXELS = 16 * 1024 * 1024;
/** Maximum length of a SetPresentationPointer JSON payload. */
const POINTER_JSON_MAX = 8192;

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
    <!-- Presentation pointer: the extension draws it inside the Shell. The
         JSON string carries the appearance only; the Shell reads the pointer
         position itself. -->
    <method name="SetPresentationPointer">
      <arg type="s" direction="in" name="json"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="HidePresentationPointer">
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
 * Monitor rect containing the pointer, in stage coordinates.
 */
function pointerMonitorRect(pointerX, pointerY) {
    const display = global.display;
    for (let index = 0; index < display.get_n_monitors(); index++) {
        const rect = display.get_monitor_geometry(index);
        if (pointerX >= rect.x && pointerX < rect.x + rect.width &&
            pointerY >= rect.y && pointerY < rect.y + rect.height)
            return rect;
    }
    return display.get_monitor_geometry(display.get_primary_monitor());
}

/** Log each failure site only once. */
const LOGGED_FAILURES = new Set();
function logFailureOnce(key, error, message) {
    if (LOGGED_FAILURES.has(key))
        return;
    LOGGED_FAILURES.add(key);
    logError(error, message);
}

/**
 * Shared press/release dispatch for PressKey and MouseButton.
 *
 * @param {string} direction "press" | "release" | "click"/"pressrelease"
 *   (default click); anything else emits nothing.
 * @param {() => void} press down-transition emitter
 * @param {() => void} release up-transition emitter
 * @returns {boolean} whether anything was emitted
 */
function dispatchByDirection(direction, press, release) {
    const dir = String(direction || 'click').toLowerCase();
    let emitted = false;
    if (dir === 'press' || dir === 'click' || dir === 'pressrelease') {
        press();
        emitted = true;
    }
    if (dir === 'release' || dir === 'click' || dir === 'pressrelease') {
        release();
        emitted = true;
    }
    return emitted;
}

/**
 * Resolve X11-style keysym names to keyvals.
 * Clutter.KEY_* constants use the same keyval namespace as Gdk.
 */
function keyvalFromName(name) {
    if (!name)
        return 0;
    // X11 media/browser keysyms keep the XF86 prefix, Clutter's KEY_*
    // constants drop it; try both.
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
    // Guard prototype names such as "__proto__" and "constructor".
    const canonical = Object.hasOwn(KEY_ALIASES, lower)
        ? KEY_ALIASES[lower] : raw;

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

/**
 * Clamp an appearance payload into the values the painter uses.
 * Missing or malformed fields fall back to their defaults.
 */
function normalizePointerState(raw) {
    const number = (value, fallback) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const bounded = (value, min, max) =>
        Math.min(max, Math.max(min, value));
    return {
        mode: raw.mode === 'spotlight' ? 'spotlight' : 'largeCursor',
        style: String(raw.style || 'softGlow'),
        // 0xRRGGBB; alpha is a separate opacity value.
        color: number(raw.color, 0xffffff),
        opacity: bounded(number(raw.opacity, 0.9), 0, 1),
        diameter: bounded(number(raw.diameter, 48), 8, POINTER_MAX_SIZE),
        width: bounded(number(raw.width, 200), 2, POINTER_MAX_SIZE),
        height: bounded(number(raw.height, 200), 2, POINTER_MAX_SIZE),
        shape: raw.shape === 'roundedRect' ? 'roundedRect' : 'circle',
        cornerRadius: bounded(number(raw.cornerRadius, 0), 0, POINTER_MAX_SIZE),
        dimOpacity: bounded(number(raw.dimOpacity, 0.55), 0, 1),
    };
}

function rgbComponents(color) {
    return [
        ((color >> 16) & 0xff) / 255,
        ((color >> 8) & 0xff) / 255,
        (color & 0xff) / 255,
    ];
}

/** Dim the whole monitor except a hole around the pointer. */
function paintSpotlight(cr, state, x, y, width, height) {
    const halfWidth = state.width / 2;
    const halfHeight = state.height / 2;
    cr.save();
    cr.setSourceRGBA(0, 0, 0, state.dimOpacity);
    // One path, even-odd: the monitor rectangle minus the hole is dimmed.
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    cr.rectangle(0, 0, width, height);
    if (state.shape === 'circle') {
        cr.arc(x, y, Math.min(halfWidth, halfHeight), 0, 2 * Math.PI);
    } else {
        const left = x - halfWidth;
        const top = y - halfHeight;
        const radius = Math.min(state.cornerRadius, halfWidth, halfHeight);
        if (radius <= 0.5) {
            cr.rectangle(left, top, state.width, state.height);
        } else {
            cr.newSubPath();
            cr.arc(left + radius, top + radius, radius, Math.PI, 1.5 * Math.PI);
            cr.arc(left + state.width - radius, top + radius, radius,
                1.5 * Math.PI, 2 * Math.PI);
            cr.arc(left + state.width - radius, top + state.height - radius,
                radius, 0, 0.5 * Math.PI);
            cr.arc(left + radius, top + state.height - radius, radius,
                0.5 * Math.PI, Math.PI);
            cr.closePath();
        }
    }
    cr.fill();
    cr.restore();
}

/**
 * Draw a ring, laser dot or soft glow around the origin.
 * A dark backing, a stacked-disc halo, the accent ring or disc, a white
 * outline and a bright centre pin.
 */
function paintLargeCursor(cr, state, centerX, centerY) {
    const radius = state.diameter / 2;
    const alpha = state.opacity;
    const [red, green, blue] = rgbComponents(state.color);
    cr.save();
    cr.translate(centerX, centerY);

    const circle = (r) => {
        cr.newPath();
        cr.arc(0, 0, Math.max(0, r), 0, 2 * Math.PI);
        cr.closePath();
    };
    const strokeCircle = (r, lineWidth, a) => {
        circle(r);
        cr.setSourceRGBA(red, green, blue, a);
        cr.setLineWidth(lineWidth);
        cr.stroke();
    };
    const strokeWhite = (r, lineWidth, a) => {
        circle(r);
        cr.setSourceRGBA(1, 1, 1, a);
        cr.setLineWidth(lineWidth);
        cr.stroke();
    };
    const fillWhite = (r, a) => {
        circle(r);
        cr.setSourceRGBA(1, 1, 1, a);
        cr.fill();
    };
    // Stacked translucent discs; alpha rises towards the core.
    const halo = (outerScale, peakAlpha, steps, hollow) => {
        const lineWidth = Math.max(1, radius * 0.08);
        for (let index = 0; index < steps; index++) {
            const t = index / steps;
            const stepRadius = radius * (outerScale + (1 - outerScale) * t);
            const stepAlpha = Math.min(1,
                Math.max(0, (peakAlpha * (0.35 + 0.65 * t)) / steps));
            circle(stepRadius);
            cr.setSourceRGBA(red, green, blue, stepAlpha);
            if (hollow) {
                cr.setLineWidth(lineWidth);
                cr.stroke();
            } else {
                cr.fill();
            }
        }
    };
    // Dark backing for contrast on light backgrounds.
    const shadow = (r, offsetY, a) => {
        cr.newPath();
        cr.arc(0, offsetY, Math.max(0, r), 0, 2 * Math.PI);
        cr.closePath();
        cr.setSourceRGBA(0, 0, 0, Math.min(1, Math.max(0, a)));
        cr.fill();
    };

    if (state.style === 'ring') {
        // Hollow ring: only the circle marks the point.
        halo(1.18, alpha * 0.5, 3, true);
        shadow(radius * 1.10, 0, alpha * 0.32);
        strokeCircle(radius, Math.max(2.5, radius * 0.1), alpha);
        strokeWhite(radius - 1, 1, Math.min(1, alpha * 0.85));
        fillWhite(1.5, alpha);
    } else if (state.style === 'laserDot') {
        // Solid accent disc with an outline and a specular pin.
        shadow(radius * 1.14, radius * 0.10, 0.30);
        halo(1.35, alpha * 0.55, 4, false);
        circle(radius);
        cr.setSourceRGBA(red, green, blue, alpha);
        cr.fill();
        strokeWhite(radius, Math.max(1.5, radius * 0.12),
            Math.min(1, alpha * 1.05));
        fillWhite(Math.max(1.5, radius * 0.3), alpha * 0.85);
    } else {
        // Soft diffused halo with a translucent core.
        shadow(radius * 1.02, radius * 0.12, 0.196);
        halo(1.5, alpha * 0.6, 5, false);
        circle(radius);
        cr.setSourceRGBA(red, green, blue, alpha * 0.30);
        cr.fill();
        // Dark vignette keeps the centre see-through.
        const core = new Cairo.RadialGradient(0, 0, 0, 0, 0,
            Math.max(0.01, radius * 0.95));
        core.addColorStopRGBA(0, 0, 0, 0, alpha * 0.34);
        core.addColorStopRGBA(0.62, 0, 0, 0, alpha * 0.34 * 0.55);
        core.addColorStopRGBA(1, 0, 0, 0, 0);
        circle(radius * 0.95);
        cr.setSource(core);
        cr.fill();
        strokeCircle(radius, Math.max(2.0, radius * 0.06), alpha * 0.85);
        fillWhite(1.5, alpha);
    }
    cr.restore();
}

class Talk2PCExtension {
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
        // Presentation pointer state (null while hidden).
        this._pointerOverlay = null;
        this._pointerFullScreen = false;
        this._pointerSize = 0;
        this._pointerState = null;
        this._pointerLastX = -1;
        this._pointerLastY = -1;
        LOGGED_FAILURES.clear();
        this._pointerTickId = 0;
        // Abort hooks for captures still waiting on the compositor.
        this._pendingCaptures = new Set();
    }

    disable() {
        // Close out in-flight captures while the D-Bus object can still reply.
        const aborts = this._pendingCaptures ? [...this._pendingCaptures] : [];
        this._pendingCaptures = new Set();
        for (const abort of aborts)
            abort();
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
        this._clearPointer();
    }

    _keyboard() {
        if (!this._virtualKeyboard) {
            this._virtualKeyboard = this._seat().create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE
            );
        }
        return this._virtualKeyboard;
    }

    _pointer() {
        if (!this._virtualPointer) {
            this._virtualPointer = this._seat().create_virtual_device(
                Clutter.InputDeviceType.POINTER_DEVICE
            );
        }
        return this._virtualPointer;
    }

    /** The Shell's seat, which owns the pointer and keyboard. */
    _seat() {
        return Clutter.get_default_backend().get_default_seat();
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
     * Coordinates are stage (logical) coordinates, the same space as
     * GetPointerPosition and GetWindowGeometry. HiDPI captures come out at
     * native pixels. The reply is sent from the capture callback, so the
     * Shell's own iteration keeps running; the caller sees `true` only after
     * the PNG is renamed into place. A timeout bounds the wait.
     */
    ScreenshotAreaAsync(params, invocation) {
        // Answer exactly once no matter what; _captureArea() owns the
        // success path.
        let replied = false;
        const reply = (ok) => {
            if (replied)
                return;
            replied = true;
            try {
                invocation.return_value(new GLib.Variant('(b)', [ok]));
            } catch (e) {
                logError(e, 'Talk2PC: ScreenshotArea could not send its reply');
            }
        };
        try {
            this._captureArea(params, reply);
        } catch (e) {
            logError(e, 'Talk2PC: ScreenshotArea failed');
            reply(false);
        }
    }

    /**
     * Start the area capture and report through `reply`.
     * @param {Array} params the five D-Bus arguments
     * @param {function(boolean)} reply called exactly once
     */
    _captureArea(params, reply) {
        const [x, y, width, height, filename] = params;
        const areaX = Math.round(Number(x)) || 0;
        const areaY = Math.round(Number(y)) || 0;
        const areaWidth = Math.round(Number(width)) || 0;
        const areaHeight = Math.round(Number(height)) || 0;
        const path = String(filename || '');
        if (areaWidth <= 0 || areaHeight <= 0 || !path)
            return reply(false);

        // The capture surface matches the request, so clamp the request that
        // is passed to screenshot_area() itself.
        const stageWidth = Math.floor(global.stage.width);
        const stageHeight = Math.floor(global.stage.height);
        const grabX = Math.max(0, Math.min(areaX, Math.max(0, stageWidth - 1)));
        const grabY = Math.max(0, Math.min(areaY, Math.max(0, stageHeight - 1)));
        // Never ask for more than what is left of the stage from that origin.
        const grabWidth = Math.min(areaWidth, stageWidth - grabX);
        const grabHeight = Math.min(areaHeight, stageHeight - grabY);
        if (grabWidth <= 0 || grabHeight <= 0)
            return reply(false);
        if (grabWidth * grabHeight > MAX_SCREENSHOT_PIXELS)
            return reply(false);

        // Capture into a temporary file next to the target, then rename it
        // over the target, so a failed capture cannot damage an existing file.
        const target = Gio.File.new_for_path(path);
        const tmp = Gio.File.new_for_path(path + '.talk2pc-tmp');
        let stream;
        try {
            stream = tmp.replace(
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            logFailureOnce('screenshot-open', e,
                'Talk2PC: ScreenshotArea could not open a temporary file');
            return reply(false);
        }

        // Set once the invocation has an answer; the capture callback must not
        // touch the stream or the file after that point.
        let settled = false;
        let watchdog = 0;

        /** The target was never touched; drop the temporary file. */
        const removeTmp = () => {
            try {
                tmp.delete(null);
            } catch (_e) {
                // Nothing to clean up.
            }
        };

        /** Answer the caller exactly once and stop the watchdog. */
        let abort = null;
        const finish = (ok) => {
            if (settled)
                return;
            settled = true;
            if (abort)
                this._pendingCaptures.delete(abort);
            if (watchdog) {
                GLib.source_remove(watchdog);
                watchdog = 0;
            }
            reply(ok);
        };

        // Lets disable() answer a capture that is still in flight.
        abort = () => {
            removeTmp();
            finish(false);
        };
        this._pendingCaptures.add(abort);

        try {
            const shooter = new Shell.Screenshot();
            // Registered before the capture starts so a synchronous callback
            // still finds a source to remove.
            watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                SCREENSHOT_TIMEOUT_MS, () => {
                    // The source is spent; clear the id so finish() does not
                    // remove it again.
                    watchdog = 0;
                    // The compositor may still be writing, so drop the
                    // temporary file instead of renaming it.
                    removeTmp();
                    finish(false);
                    return GLib.SOURCE_REMOVE;
                });
            shooter.screenshot_area(
                grabX,
                grabY,
                grabWidth,
                grabHeight,
                stream,
                (source, result) => {
                    // Consume the GIO result even after a timeout, so GLib
                    // does not log an unhandled async result.
                    let ok = false;
                    try {
                        source.screenshot_area_finish(result);
                        ok = !settled;
                    } catch (e) {
                        if (!settled)
                            logError(e, 'Talk2PC: screenshot_area failed');
                    }
                    // The caller was already answered (timeout or disable); the
                    // writer still owns the stream, so leave it alone.
                    if (settled)
                        return;

                    try {
                        stream.close(null);
                    } catch (_e) {
                        // Already closed or failed.
                    }

                    // Rename only once the bytes are on disk, so a successful
                    // reply always means a complete file.
                    if (ok) {
                        try {
                            tmp.move(target, Gio.FileCopyFlags.OVERWRITE,
                                null, null);
                        } catch (e) {
                            logFailureOnce('screenshot-rename', e,
                                'Talk2PC: ScreenshotArea could not replace the target file');
                            ok = false;
                        }
                    }
                    if (!ok)
                        removeTmp();
                    finish(ok);
                }
            );
        } catch (e) {
            logError(e, 'Talk2PC: screenshot_area failed');
            try {
                stream.close(null);
            } catch (_e) {
                // Already closed or failed.
            }
            removeTmp();
            finish(false);
        }
    }

    /**
     * Inject a key via Clutter virtual keyboard.
     * @param {string} keysym X11-style keysym (Control_L, v, Return, …)
     * @param {string} direction "press" | "release" | "click" (default click)
     * @returns {boolean} false for an unknown keysym or direction
     */
    PressKey(keysym, direction) {
        const keyval = resolveKeyval(keysym);
        if (!keyval)
            return false;

        try {
            const kb = this._keyboard();
            const time = this._inputTimeUs();
            const emitted = dispatchByDirection(direction,
                () => kb.notify_keyval(time, keyval, Clutter.KeyState.PRESSED),
                () => kb.notify_keyval(time, keyval, Clutter.KeyState.RELEASED)
            );
            return emitted;
        } catch (e) {
            logFailureOnce('press-key', e, 'Talk2PC: PressKey injection failed');
            return false;
        }
    }

    /** Microsecond timestamp for Clutter virtual input devices. */
    _inputTimeUs() {
        return global.get_current_time() * 1000;
    }

    /**
     * Inject relative pointer motion.
     * @param {number} dx horizontal delta in stage pixels
     * @param {number} dy vertical delta in stage pixels
     * @returns {boolean} false for non-finite deltas
     */
    MovePointerRelative(dx, dy) {
        const stepX = Number(dx);
        const stepY = Number(dy);
        // Drop non-finite deltas.
        if (!Number.isFinite(stepX) || !Number.isFinite(stepY))
            return false;
        try {
            this._pointer().notify_relative_motion(
                this._inputTimeUs(),
                stepX,
                stepY
            );
            return true;
        } catch (e) {
            logFailureOnce('pointer-relative', e,
                'Talk2PC: relative pointer injection failed');
            return false;
        }
    }

    /** Warp the pointer to absolute stage coordinates. */
    MovePointerAbsolute(x, y) {
        const absX = Number(x);
        const absY = Number(y);
        // Drop non-finite coordinates.
        if (!Number.isFinite(absX) || !Number.isFinite(absY))
            return false;
        try {
            this._pointer().notify_absolute_motion(
                this._inputTimeUs(),
                absX,
                absY
            );
            return true;
        } catch (e) {
            logFailureOnce('pointer-absolute', e,
                'Talk2PC: absolute pointer injection failed');
            return false;
        }
    }

    /**
     * Inject a pointer button event.
     * @param {number} button xdotool index: 1 left, 2 middle, 3 right, 8/9 back/forward
     * @param {string} direction "press" | "release" | "click" (default click)
     * @returns {boolean} false for an out-of-range button or direction
     */
    MouseButton(button, direction) {
        const btn = Math.trunc(Number(button));
        // Only buttons 1–12 are valid.
        if (!Number.isInteger(btn) || btn < 1 || btn > MAX_MOUSE_BUTTON)
            return false;
        try {
            const pointer = this._pointer();
            const time = this._inputTimeUs();
            const emitted = dispatchByDirection(direction,
                () => pointer.notify_button(time, btn, Clutter.ButtonState.PRESSED),
                () => pointer.notify_button(time, btn, Clutter.ButtonState.RELEASED)
            );
            return emitted;
        } catch (e) {
            logFailureOnce('mouse-button', e,
                'Talk2PC: MouseButton injection failed');
            return false;
        }
    }

    /**
     * Inject scroll wheel notches. Deltas accumulate across calls: 40 units
     * are one notch. Only notches that were emitted are consumed, so a
     * failed call can be retried.
     * @param {number} dx positive scrolls right
     * @param {number} dy positive scrolls down
     */
    MouseScroll(dx, dy) {
        const stepX = Number(dx) || 0;
        const stepY = Number(dy) || 0;
        // Drop non-finite deltas: they would poison the accumulator.
        if (!Number.isFinite(stepX) || !Number.isFinite(stepY))
            return false;

        // Cap the backlog so a client sending large deltas cannot queue
        // unbounded work.
        const maxBacklog = MAX_NOTCHES_PER_CALL * SCROLL_UNITS_PER_NOTCH;
        this._scrollAccumX = Math.max(-maxBacklog,
            Math.min(maxBacklog, this._scrollAccumX + stepX));
        this._scrollAccumY = Math.max(-maxBacklog,
            Math.min(maxBacklog, this._scrollAccumY + stepY));

        const notchesX = Math.trunc(this._scrollAccumX / SCROLL_UNITS_PER_NOTCH);
        const notchesY = Math.trunc(this._scrollAccumY / SCROLL_UNITS_PER_NOTCH);

        try {
            const pointer = this._pointer();
            const time = this._inputTimeUs();
            const emitNotches = (notches, forward, backward) => {
                while (notches > 0) {
                    pointer.notify_discrete_scroll(
                        time, forward, Clutter.ScrollSource.WHEEL);
                    notches--;
                }
                while (notches < 0) {
                    pointer.notify_discrete_scroll(
                        time, backward, Clutter.ScrollSource.WHEEL);
                    notches++;
                }
            };
            emitNotches(notchesX,
                Clutter.ScrollDirection.RIGHT, Clutter.ScrollDirection.LEFT);
            emitNotches(notchesY,
                Clutter.ScrollDirection.DOWN, Clutter.ScrollDirection.UP);
        } catch (e) {
            logFailureOnce('mouse-scroll', e,
                'Talk2PC: MouseScroll injection failed');
            return false;
        }

        this._scrollAccumX -= notchesX * SCROLL_UNITS_PER_NOTCH;
        this._scrollAccumY -= notchesY * SCROLL_UNITS_PER_NOTCH;
        return true;
    }

    // ---- presentation pointer overlay -------------------------------------
    //
    // The overlay is a non-reactive St actor, so clicks always reach the
    // window underneath. Its position follows the compositor pointer.

    /**
     * Show or update the overlay.
     * @param {string} json appearance only:
     *   {mode:"largeCursor"|"spotlight", diameter, style, color, opacity,
     *    width, height, shape, cornerRadius, dimOpacity}
     */
    SetPresentationPointer(json) {
        const text = String(json || '{}');
        // Reject oversized payloads before parsing.
        if (text.length > POINTER_JSON_MAX)
            return false;
        let raw;
        try {
            raw = JSON.parse(text);
        } catch (_e) {
            return false;
        }
        // Only accept a plain object.
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return false;
        this._pointerState = normalizePointerState(raw);
        this._syncPointerOverlay();
        // Colour or style can change without resizing the box; repaint once
        // so the change shows while the pointer stands still.
        this._pointerOverlay.queue_repaint();
        this._startPointerTick();
        return true;
    }

    HidePresentationPointer() {
        this._clearPointer();
        return true;
    }

    /**
     * Size the overlay for the current mode. The large cursor paints a small
     * box around the pointer; the spotlight covers the whole monitor.
     */
    _syncPointerOverlay() {
        const state = this._pointerState;
        const full = state.mode === 'spotlight';
        const [pointerX, pointerY] = global.get_pointer();
        const monitor = pointerMonitorRect(pointerX, pointerY);
        const box = Math.ceil(state.diameter * 1.6) + 16;
        // The box never exceeds the monitor it lives on.
        const size = full ? 0
            : Math.min(box, Math.max(monitor.width, monitor.height));
        if (!this._pointerOverlay || this._pointerFullScreen !== full ||
            this._pointerSize !== size) {
            this._destroyPointerOverlay();
            const area = new St.DrawingArea({ reactive: false });
            area.connect('repaint', (actor) => this._paintPointer(actor));
            // Paints above windows and below the Shell's own chrome.
            Main.uiGroup.add_child(area);
            this._pointerOverlay = area;
            this._pointerFullScreen = full;
            this._pointerSize = size;
        }
        this._pointerOverlay.show();
        this._placePointerOverlay();
    }

    /** Move the overlay to the pointer, clamped inside its monitor. */
    _placePointerOverlay() {
        const area = this._pointerOverlay;
        if (!area)
            return;
        const [pointerX, pointerY] = global.get_pointer();
        const monitor = pointerMonitorRect(pointerX, pointerY);
        if (this._pointerFullScreen) {
            area.set_position(monitor.x, monitor.y);
            area.set_size(monitor.width, monitor.height);
            return;
        }
        const size = this._pointerSize;
        const offset = size / 2;
        area.set_size(size, size);
        // Keep the box within a single monitor.
        area.set_position(
            Math.min(Math.max(pointerX - offset, monitor.x),
                Math.max(monitor.x, monitor.x + monitor.width - size)),
            Math.min(Math.max(pointerY - offset, monitor.y),
                Math.max(monitor.y, monitor.y + monitor.height - size)));
    }

    /** Tear down the overlay actor; the appearance state is kept. */
    _destroyPointerOverlay() {
        this._stopPointerTick();
        if (this._pointerOverlay) {
            this._pointerOverlay.destroy();
            this._pointerOverlay = null;
        }
        this._pointerFullScreen = false;
        this._pointerSize = 0;
        this._pointerLastX = -1;
        this._pointerLastY = -1;
    }

    /** Drop everything, including the appearance the app asked for. */
    _clearPointer() {
        this._destroyPointerOverlay();
        this._pointerState = null;
    }

    /** Start following the pointer. */
    _startPointerTick() {
        if (this._pointerTickId)
            return;
        this._pointerTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            POINTER_POLL_INTERVAL_MS, () => this._onPointerTick());
    }

    _stopPointerTick() {
        if (this._pointerTickId) {
            GLib.source_remove(this._pointerTickId);
            this._pointerTickId = 0;
        }
    }

    /** Move or repaint the overlay when the pointer position changed. */
    _onPointerTick() {
        if (!this._pointerOverlay) {
            this._pointerTickId = 0;
            return GLib.SOURCE_REMOVE;
        }
        const [pointerX, pointerY] = global.get_pointer();
        if (pointerX === this._pointerLastX &&
            pointerY === this._pointerLastY)
            return GLib.SOURCE_CONTINUE;
        this._pointerLastX = pointerX;
        this._pointerLastY = pointerY;
        this._placePointerOverlay();
        if (this._pointerFullScreen)
            this._pointerOverlay.queue_repaint();
        return GLib.SOURCE_CONTINUE;
    }

    _paintPointer(area) {
        const state = this._pointerState;
        if (!state)
            return;
        const [pointerX, pointerY] = global.get_pointer();
        const [width, height] = area.get_surface_size();
        const cr = area.get_context();
        if (!cr)
            return;
        try {
            // Paint in surface coordinates.
            const [boxX, boxY] = area.get_position();
            const localX = pointerX - boxX;
            const localY = pointerY - boxY;
            if (state.mode === 'spotlight')
                paintSpotlight(cr, state, localX, localY, width, height);
            else
                paintLargeCursor(cr, state, localX, localY);
        } finally {
            // Required by St.DrawingArea: the context belongs to the repaint.
            cr.$dispose();
        }
    }
}

function init() {
    return new Talk2PCExtension();
}
