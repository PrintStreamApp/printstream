/**
 * Linux tray provider: a Python GTK script using AppIndicator (Ayatana or
 * legacy) with a Gtk.StatusIcon fallback. It reads status from the app's
 * world-readable status file (the control socket is owned by the root service
 * and unreachable from this user process) and treats a live PID as "running".
 * The menu mirrors the Windows tray item-for-item, revealing items
 * from the status fields present (an "Open <app>" item when an `appUrl` is set).
 * Desktop Linux tray
 * support is best-effort — the script exits with code 3 when GTK bindings are
 * missing and the runner explains the CLI remains available.
 */
export function generateLinuxTrayScript(input: {
  iconPath: string
  appName: string
  statusFile: string
  logsDir: string
  exePath: string
}): string {
  return `#!/usr/bin/env python3
import json
import os
import subprocess
import sys

STATUS_FILE = ${pyQuote(input.statusFile)}
LOGS_DIR = ${pyQuote(input.logsDir)}
ICON_PATH = ${pyQuote(input.iconPath)}
APP_NAME = ${pyQuote(input.appName)}
EXE_PATH = ${pyQuote(input.exePath)}

try:
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, GLib, Gdk
except (ImportError, ValueError):
    sys.stderr.write("GTK introspection bindings (python3-gi) are not available.\\n")
    sys.exit(3)

AppIndicator3 = None
try:
    gi.require_version("AyatanaAppIndicator3", "0.1")
    from gi.repository import AyatanaAppIndicator3 as AppIndicator3
except (ImportError, ValueError):
    try:
        gi.require_version("AppIndicator3", "0.1")
        from gi.repository import AppIndicator3
    except (ImportError, ValueError):
        AppIndicator3 = None


def bridge_status():
    try:
        with open(STATUS_FILE) as handle:
            status = json.load(handle)
    except Exception:
        return None
    pid = status.get("pid")
    if not pid:
        return None
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass  # exists but owned by the service account — still alive
    except Exception:
        return None
    return status


class Tray:
    def __init__(self):
        self.connect_url = ""
        self.connect_code = ""
        self.app_url = ""
        self.menu = Gtk.Menu()
        self.open_item = Gtk.MenuItem(label="Open " + APP_NAME)
        self.open_item.connect("activate", self.open_app)
        self.menu.append(self.open_item)
        self.status_item = Gtk.MenuItem(label="Starting...")
        self.status_item.set_sensitive(False)
        self.menu.append(self.status_item)
        self.version_item = Gtk.MenuItem(label="")
        self.version_item.set_sensitive(False)
        self.menu.append(self.version_item)
        self.code_item = Gtk.MenuItem(label="")
        self.code_item.set_sensitive(False)
        self.menu.append(self.code_item)
        self.connect_item = Gtk.MenuItem(label="Open connect page")
        self.connect_item.connect("activate", self.open_connect_page)
        self.menu.append(self.connect_item)
        self.copy_code_item = Gtk.MenuItem(label="Copy connect code")
        self.copy_code_item.connect("activate", self.copy_connect_code)
        self.menu.append(self.copy_code_item)
        self.menu.append(Gtk.SeparatorMenuItem())
        self.start_service_item = Gtk.MenuItem(label="Start service")
        self.start_service_item.connect("activate", self.start_service)
        self.menu.append(self.start_service_item)
        self.stop_service_item = Gtk.MenuItem(label="Stop service")
        self.stop_service_item.connect("activate", self.stop_service)
        self.menu.append(self.stop_service_item)
        self.restart_service_item = Gtk.MenuItem(label="Restart service")
        self.restart_service_item.connect("activate", self.restart_service)
        self.menu.append(self.restart_service_item)
        self.update_item = Gtk.MenuItem(label="Update bridge")
        self.update_item.connect("activate", self.update_bridge)
        self.menu.append(self.update_item)
        logs_item = Gtk.MenuItem(label="View logs")
        logs_item.connect("activate", self.view_logs)
        self.menu.append(logs_item)
        uninstall_item = Gtk.MenuItem(label="Uninstall " + APP_NAME)
        uninstall_item.connect("activate", self.uninstall_bridge)
        self.menu.append(uninstall_item)
        quit_item = Gtk.MenuItem(label="Quit tray")
        quit_item.connect("activate", Gtk.main_quit)
        self.menu.append(quit_item)
        self.menu.show_all()
        self.open_item.hide()
        self.version_item.hide()
        self.code_item.hide()
        self.connect_item.hide()
        self.copy_code_item.hide()
        self.update_item.hide()
        self.start_service_item.hide()
        self.stop_service_item.hide()
        self.restart_service_item.hide()

        if AppIndicator3 is not None:
            self.indicator = AppIndicator3.Indicator.new(
                "printstream-bridge-tray", ICON_PATH,
                AppIndicator3.IndicatorCategory.APPLICATION_STATUS)
            self.indicator.set_status(AppIndicator3.IndicatorStatus.ACTIVE)
            self.indicator.set_title(APP_NAME)
            self.indicator.set_menu(self.menu)
            self.status_icon = None
        else:
            self.indicator = None
            self.status_icon = Gtk.StatusIcon.new_from_file(ICON_PATH)
            self.status_icon.set_tooltip_text(APP_NAME)
            self.status_icon.connect("popup-menu", self.on_popup)

        GLib.timeout_add_seconds(5, self.refresh)
        self.refresh()

    def on_popup(self, icon, button, activate_time):
        self.menu.popup(None, None, Gtk.StatusIcon.position_menu, icon, button, activate_time)

    def open_app(self, *_args):
        if self.app_url:
            try:
                subprocess.Popen(["xdg-open", self.app_url])
            except Exception:
                pass

    def view_logs(self, *_args):
        try:
            subprocess.Popen(["xdg-open", LOGS_DIR])
        except Exception:
            pass

    def open_connect_page(self, *_args):
        if self.connect_url:
            try:
                subprocess.Popen(["xdg-open", self.connect_url])
            except Exception:
                pass

    def copy_connect_code(self, *_args):
        if self.connect_code:
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clipboard.set_text(self.connect_code, -1)
            clipboard.store()

    def update_bridge(self, *_args):
        # pkexec prompts for elevation so the install can reach the root service
        # and replace the binary.
        try:
            subprocess.Popen(["pkexec", EXE_PATH, "update", "apply"])
        except Exception:
            pass

    def start_service(self, *_args):
        try:
            subprocess.Popen(["pkexec", EXE_PATH, "service", "start"])
        except Exception:
            pass

    def stop_service(self, *_args):
        try:
            subprocess.Popen(["pkexec", EXE_PATH, "service", "stop"])
        except Exception:
            pass

    def restart_service(self, *_args):
        try:
            subprocess.Popen(["pkexec", EXE_PATH, "service", "restart"])
        except Exception:
            pass

    def uninstall_bridge(self, *_args):
        dialog = Gtk.MessageDialog(
            transient_for=None, flags=0, message_type=Gtk.MessageType.WARNING,
            text="Remove " + APP_NAME + "?")
        dialog.format_secondary_text(
            "\\"Delete everything\\" also deletes all data, including your library files (cannot be undone).")
        dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
        dialog.add_button("Keep data", Gtk.ResponseType.NO)
        dialog.add_button("Delete everything", Gtk.ResponseType.YES)
        response = dialog.run()
        dialog.destroy()
        if response == Gtk.ResponseType.CANCEL:
            return
        args = ["pkexec", EXE_PATH, "uninstall"]
        if response == Gtk.ResponseType.YES:
            args.append("--purge")
        try:
            subprocess.Popen(args)
        except Exception:
            pass
        Gtk.main_quit()

    def refresh(self):
        status = bridge_status()
        if status is None:
            self.status_item.set_label(APP_NAME + " not running")
            self.app_url = ""
            self.open_item.hide()
            self.version_item.hide()
            self.code_item.hide()
            self.connect_item.hide()
            self.copy_code_item.hide()
            self.update_item.hide()
            self.start_service_item.show()
            self.stop_service_item.hide()
            self.restart_service_item.hide()
            return True
        lifecycle = status.get("lifecycle", "unknown")
        self.status_item.set_label("Status: " + lifecycle)
        self.app_url = status.get("appUrl") or ""
        if self.app_url:
            self.open_item.show()
        else:
            self.open_item.hide()
        self.start_service_item.hide()
        self.stop_service_item.show()
        self.restart_service_item.show()
        build = status.get("build") or {}
        version = build.get("buildRevision") or build.get("releaseFingerprint")
        if version:
            self.version_item.set_label("Version: " + str(version)[:12])
            self.version_item.show()
        else:
            self.version_item.hide()
        code = status.get("connectCode")
        if code:
            self.connect_code = str(code)
            self.connect_url = status.get("connectUrl") or ""
            self.code_item.set_label("Connect code: " + str(code))
            self.code_item.show()
            if self.connect_url:
                self.connect_item.show()
            else:
                self.connect_item.hide()
            self.copy_code_item.show()
        else:
            self.connect_code = ""
            self.connect_url = ""
            self.code_item.hide()
            self.connect_item.hide()
            self.copy_code_item.hide()
        if status.get("updateAvailable"):
            self.update_item.show()
        else:
            self.update_item.hide()
        tooltip = APP_NAME + " - " + lifecycle
        if self.status_icon is not None:
            self.status_icon.set_tooltip_text(tooltip)
        return True


Tray()
Gtk.main()
`
}

function pyQuote(value: string): string {
  return JSON.stringify(value)
}
