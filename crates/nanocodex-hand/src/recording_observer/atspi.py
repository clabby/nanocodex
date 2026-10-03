# Read-only AT-SPI probe, invoked by the native observer with a numeric PID.
# Never request names, text, descriptions, attributes, values, or clipboard data.
import json
import os
import sys
import time

result = {"state": "unknown"}
try:
    import dbus
    pid = int(sys.argv[1])
    deadline = time.monotonic() + 0.35
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise RuntimeError()
    session = dbus.SessionBus()
    # Do not auto-launch a new accessibility service or enable accessibility.
    if not session.name_has_owner("org.a11y.Bus"):
        raise RuntimeError()
    address = session.get_object("org.a11y.Bus", "/org/a11y/bus", introspect=False).get_dbus_method("GetAddress", "org.a11y.Bus")(timeout=0.05)
    bus = dbus.bus.BusConnection(address)
    def call(owner, path, method, interface="org.a11y.atspi.Accessible", *args):
        if time.monotonic() >= deadline:
            raise RuntimeError()
        return bus.get_object(owner, path, introspect=False).get_dbus_method(method, interface)(*args, timeout=0.05)
    apps = call("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root", "GetChildren")
    if len(apps) > 64:
        raise RuntimeError()
    matching = []
    for owner, path in apps:
        owner_pid = call("org.freedesktop.DBus", "/org/freedesktop/DBus", "GetConnectionUnixProcessID", "org.freedesktop.DBus", str(owner))
        if int(owner_pid) == pid:
            matching.append((str(owner), str(path)))
    if len(matching) != 1:
        raise RuntimeError()
    owner, root = matching[0]
    pending = [root]
    seen = set()
    focused_role = None
    password = False
    # Native AT-SPI roles: password text=40; check box=7, push button=43,
    # radio button=44, slider=51, toggle button=62. All other focus remains unknown.
    while pending:
        path = pending.pop()
        if path in seen:
            continue
        seen.add(path)
        if len(seen) > 128:
            raise RuntimeError()
        state = call(owner, path, "GetState")
        if len(state) != 2:
            raise RuntimeError()
        bits = int(state[0]) | (int(state[1]) << 32)
        if bits & (1 << 6):  # defunct
            raise RuntimeError()
        role = int(call(owner, path, "GetRole"))
        if role == 40 and bits & (1 << 25):  # password visible anywhere in app
            password = True
        if bits & (1 << 12):
            if focused_role is not None:
                raise RuntimeError()
            focused_role = role
        children = call(owner, path, "GetChildren")
        if len(children) + len(pending) > 128:
            raise RuntimeError()
        for child_owner, child_path in children:
            # Embedded out-of-process UI cannot be attested by this PID.
            if str(child_owner) != owner:
                raise RuntimeError()
            pending.append(str(child_path))
    if password:
        result = {"state": "sensitive"}
    elif focused_role in (7, 43, 44, 51, 62):
        result = {"state": "clear", "role": "atspi_control"}
except Exception:
    pass
print(json.dumps(result, separators=(",", ":")))
