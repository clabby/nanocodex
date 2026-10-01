#!/usr/bin/env python3
"""Real GTK/AT-SPI selected-window frame and password suppression journey.

Usage: python3 scripts/tests/hand-recording-gtk-e2e.py /path/to/nanocodex2
Requires Xvfb, openbox, dbus-daemon, GTK3 introspection, python3-dbus and AT-SPI2.
Optional --sysroot and --bus-launcher support locally extracted GTK packages.
Never connects to the ambient display or session bus. Evidence is in output/.
"""
import argparse
import base64
import json
import os
import pathlib
import secrets
import signal
import struct
import subprocess
import sys
import tempfile
import time


def fixture(directory):
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('GdkX11', '3.0')
    from gi.repository import Gtk, GLib
    root = pathlib.Path(directory)
    window = Gtk.Window(title='SYNTHETIC_PRIVATE_WINDOW_TITLE')
    window.set_default_size(360, 240)
    window.set_resizable(False)
    window.move(40, 40)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16)
    box.set_border_width(20)
    window.add(box)
    box.pack_start(Gtk.Label(label='Scoped safe workflow'), False, False, 0)
    button = Gtk.Button(label='Safe action')
    box.pack_start(button, False, False, 0)
    entry = Gtk.Entry()
    entry.set_visibility(False)
    entry.set_text('SYNTHETIC_PASSWORD_DO_NOT_RETAIN')
    box.pack_start(entry, False, False, 0)
    overlay = Gtk.Window(type=Gtk.WindowType.POPUP)
    overlay.set_accept_focus(False)
    overlay.move(70, 80)
    overlay.add(Gtk.Label(label='SYNTHETIC_EXCLUDED_OVERLAY_SECRET'))
    window.connect('destroy', Gtk.main_quit)
    window.show_all()
    entry.hide()
    current = None
    def poll():
        nonlocal current
        mode = (root / 'mode').read_text()
        if mode != current:
            current = mode
            overlay.hide()
            if mode == 'password':
                entry.show()
                entry.grab_focus()
            else:
                entry.hide()
                button.set_label('Recovered safe action' if mode == 'safe-again' else 'Safe action')
                button.grab_focus()
            window.present()
            if mode == 'overlay':
                GLib.timeout_add(50, lambda: (overlay.show_all(), False)[1])
            def report():
                (root / 'fixture.json').write_text(json.dumps({'mode': mode, 'window': window.get_window().get_xid(), 'size': list(window.get_size())}))
                return False
            GLib.timeout_add(100, report)
        return True
    GLib.timeout_add(50, poll)
    Gtk.main()


def wait_for(fn, timeout=15):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            value = fn()
            if value:
                return value
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            last = str(error)
        time.sleep(.1)
    raise AssertionError('Timed out waiting for native state: ' + str(last))


def journey(args):
    binary = str(pathlib.Path(args.binary).resolve())
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    for name in ('result.json', 'scoped-safe.jpg', 'atspi-safe.json', 'atspi-password.json', 'recording.json'):
        (output / name).unlink(missing_ok=True)
    trace, children, logs = [], [], []
    env = dict(os.environ)
    for key in ('DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'NO_AT_BRIDGE'):
        env.pop(key, None)
    if args.sysroot:
        prefix = pathlib.Path(args.sysroot).resolve()
        env['LD_LIBRARY_PATH'] = str(prefix / 'usr/lib/x86_64-linux-gnu')
        env['GI_TYPELIB_PATH'] = str(prefix / 'usr/lib/x86_64-linux-gnu/girepository-1.0')
        env['XDG_DATA_DIRS'] = str(prefix / 'usr/share') + ':/usr/share'
    env['GSETTINGS_BACKEND'] = 'memory'
    env['GTK_A11Y'] = 'always'
    def launch(command, name, pipe=False):
        log = open(output / (name + '.log'), 'w')
        logs.append(log)
        proc = subprocess.Popen(command, env=env, stdout=subprocess.PIPE if pipe else log, stderr=log, start_new_session=True)
        children.append(proc)
        return proc
    with tempfile.TemporaryDirectory(prefix='nc-gtk-recording-') as temp:
        root = pathlib.Path(temp)
        desktop = root / 'desktop'
        desktop.mkdir(mode=0o700)
        recordings = root / 'recordings'
        env['XDG_RUNTIME_DIR'] = str(root)
        cookie = secrets.token_bytes(16)
        record = struct.pack('>H', 65535) + b''.join(struct.pack('>H', len(v)) + v for v in (b'', b'', b'MIT-MAGIC-COOKIE-1', cookie))
        (desktop / 'Xauthority').write_bytes(record)
        (desktop / 'Xauthority').chmod(0o600)
        (root / 'mode').write_text('safe')
        def control(request):
            result = subprocess.run([binary, 'hand-recording', '--state-dir', str(recordings), json.dumps(request)], env=env, capture_output=True, text=True, timeout=12, check=True)
            value = json.loads(result.stdout)
            trace.append({'request': request, 'response': value})
            assert value['status'] == 'ok', value
            return value
        def export(rid):
            return control({'operation': 'export', 'id': rid, 'limit': 200})
        def frames(value):
            return [event for event in value['events'] if event['evidence']['kind'] == 'frame']
        try:
            xvfb = launch(['Xvfb', '-displayfd', '1', '-screen', '0', '800x600x24', '-nolisten', 'tcp', '-nolisten', 'local', '-noreset', '-auth', str(desktop / 'Xauthority')], 'xvfb', True)
            display = ':' + xvfb.stdout.readline().decode().strip()
            assert display[1:].isdigit()
            (desktop / 'display').write_text(display)
            (desktop / 'display').chmod(0o600)
            env.update(DISPLAY=display, XAUTHORITY=str(desktop / 'Xauthority'))
            bus = launch(['dbus-daemon', '--session', '--nofork', '--print-address=1'], 'session-bus', True)
            env['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.readline().decode().strip()
            assert env['DBUS_SESSION_BUS_ADDRESS'].startswith('unix:')
            launch(['openbox', '--sm-disable'], 'openbox')
            launcher = args.bus_launcher or '/usr/libexec/at-spi-bus-launcher'
            launch([str(pathlib.Path(launcher).resolve()), '--launch-immediately', '--a11y=1'], 'accessibility-bus')
            wait_for(lambda: subprocess.run([sys.executable, '-c', 'import dbus; raise SystemExit(0 if dbus.SessionBus().name_has_owner("org.a11y.Bus") else 1)'], env=env, capture_output=True, timeout=2).returncode == 0)
            # GTK itself publishes real accessibility objects to the real registry.
            gtk = launch([sys.executable, str(pathlib.Path(__file__).resolve()), '--fixture', str(root)], 'gtk')
            info = wait_for(lambda: json.loads((root / 'fixture.json').read_text()))
            probe = pathlib.Path(__file__).resolve().parents[2] / 'crates/nanocodex-hand/src/recording_observer/atspi.py'
            def sensitivity():
                return json.loads(subprocess.check_output([sys.executable, '-I', str(probe), str(gtk.pid)], env=env, text=True, timeout=2))
            safe = wait_for(lambda: (value if (value := sensitivity())['state'] == 'clear' else None))
            (output / 'atspi-safe.json').write_text(json.dumps(safe))
            launch([binary, 'hand-recording', '--serve', '--state-dir', str(recordings), '--desktop-runtime', str(desktop)], 'recorder')
            wait_for(lambda: (recordings / 'control.sock').exists())
            sources = control({'operation': 'sources'})
            context = sources['sources'][0]
            assert context['window_id'] == 'x11:' + str(info['window']), (context, info)
            assert context['process_id'] == gtk.pid
            rid = control({'operation': 'start', 'scope': {'windows': [context['window_id']], 'capture_frames': True}})['id']
            positive = wait_for(lambda: (value if frames(value := export(rid)) else None))
            frame = frames(positive)[0]['evidence']
            assert [frame['width'], frame['height']] == info['size'], (frame, info)
            assert frame['width'] < 800 and frame['height'] < 600
            data = control({'operation': 'frame', 'id': rid, 'sha256': frame['sha256']})
            jpeg = base64.b64decode(data['data_base64'], validate=True)
            assert jpeg.startswith(b'\xff\xd8') and len(jpeg) == frame['bytes']
            (output / 'scoped-safe.jpg').write_bytes(jpeg)
            control({'operation': 'pause', 'id': rid})
            before = len(frames(export(rid)))
            (root / 'mode').write_text('overlay')
            wait_for(lambda: json.loads((root / 'fixture.json').read_text())['mode'] == 'overlay')
            wait_for(lambda: sensitivity()['state'] == 'clear')
            control({'operation': 'resume', 'id': rid})
            wait_for(lambda: any(e['evidence'].get('event', {}).get('reason') == 'capture_suppressed' for e in export(rid)['events']))
            time.sleep(.8)
            overlapped = export(rid)
            assert len(frames(overlapped)) == before
            control({'operation': 'pause', 'id': rid})
            (root / 'mode').write_text('password')
            wait_for(lambda: json.loads((root / 'fixture.json').read_text())['mode'] == 'password')
            secret = wait_for(lambda: (value if (value := sensitivity())['state'] == 'sensitive' else None))
            (output / 'atspi-password.json').write_text(json.dumps(secret))
            secret_boundary = len(export(rid)['events'])
            control({'operation': 'resume', 'id': rid})
            wait_for(lambda: any(e['evidence'].get('event', {}).get('reason') == 'capture_suppressed' for e in export(rid)['events'][secret_boundary:]))
            time.sleep(1.2)
            suppressed = export(rid)
            assert len(frames(suppressed)) == before, suppressed
            assert any(e['evidence'].get('event', {}).get('kind') == 'suppressed' for e in suppressed['events'])
            control({'operation': 'pause', 'id': rid})
            (root / 'mode').write_text('safe-again')
            wait_for(lambda: json.loads((root / 'fixture.json').read_text())['mode'] == 'safe-again')
            wait_for(lambda: sensitivity()['state'] == 'clear')
            control({'operation': 'resume', 'id': rid})
            wait_for(lambda: len(frames(export(rid))) > before)
            control({'operation': 'stop', 'id': rid})
            final = export(rid)
            serialized = json.dumps(final)
            assert 'SYNTHETIC_PASSWORD_DO_NOT_RETAIN' not in serialized
            assert 'SYNTHETIC_PRIVATE_WINDOW_TITLE' not in serialized
            assert 'SYNTHETIC_EXCLUDED_OVERLAY_SECRET' not in serialized
            (output / 'recording.json').write_text(json.dumps(final, indent=2))
            result = {'passed': True, 'binary': binary, 'journeys': ['real_gtk_atspi_clear', 'selected_window_jpeg', 'overlap_suppresses_pixels', 'real_password_role_sensitive', 'zero_password_frames', 'capture_resumes_after_safe_focus'], 'frame_dimensions': [frame['width'], frame['height']], 'desktop_dimensions': [800, 600], 'frames_before_password': before, 'frames_during_password': len(frames(suppressed)), 'final_frame_count': len(frames(final))}
            (output / 'result.json').write_text(json.dumps(result, indent=2))
            print(json.dumps(result))
        finally:
            (output / 'control-trace.json').write_text(json.dumps(trace, indent=2))
            for child in reversed(children):
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=3)
            for log in logs:
                log.close()


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--fixture':
        fixture(sys.argv[2])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('binary')
        parser.add_argument('--sysroot')
        parser.add_argument('--bus-launcher')
        parser.add_argument('--output', default='output/observer-gtk-e2e')
        journey(parser.parse_args())
