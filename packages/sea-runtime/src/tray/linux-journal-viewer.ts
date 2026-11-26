/**
 * Embedded GTK journal viewer for the Linux tray. systemd captures stdout, so
 * the Windows file-log directory is not a Linux log source. Reads stay
 * unelevated and independent of service status; warnings must remain visible
 * even when journalctl returns success with only partial journal access.
 * Counterpart linux-journal-viewer.test.ts executes the generated callbacks.
 */
export const linuxJournalViewerScript = String.raw`
def read_service_logs():
    """Return a bounded journal snapshot or a visible diagnostic, never elevate."""
    command = ["journalctl", "--system", "--unit=" + SERVICE_UNIT,
               "--lines=500", "--no-pager", "--output=short-iso"]
    guidance = ("System journal access may require an administrator. "
                "Ask an administrator to read the journal for " + SERVICE_UNIT + ".")
    try:
        result = subprocess.run(command, capture_output=True, text=True,
                                errors="replace", timeout=15)
    except FileNotFoundError:
        return "Cannot view logs: journalctl is not installed or is not on PATH.\n" + guidance
    except subprocess.TimeoutExpired:
        return "Reading the system journal timed out. Try View logs again."
    except OSError as error:
        return "Cannot read the system journal: " + str(error) + "\n" + guidance

    output = result.stdout.strip()
    warning = result.stderr.strip()
    if result.returncode != 0:
        return "Cannot read the system journal.\n" + guidance + "\n\n" + warning + "\n" + output
    if not output or output == "-- No entries --":
        output = "No journal entries are available for " + SERVICE_UNIT + ".\n" + guidance
    if warning:
        output = "Journal warning (entries may be incomplete):\n" + warning + "\n\n" + output
    return output


def show_service_logs():
    """Show selectable diagnostics; query off the GTK thread to keep the tray usable."""
    import threading

    dialog = Gtk.Dialog(title=APP_NAME + " logs (latest 500 entries)")
    dialog.set_default_size(850, 500)
    dialog.add_button("Close", Gtk.ResponseType.CLOSE)
    view = Gtk.TextView()
    view.set_editable(False)
    view.set_cursor_visible(False)
    view.set_monospace(True)
    buffer = view.get_buffer()
    buffer.set_text("Reading system journal for " + SERVICE_UNIT + "...")
    scroll = Gtk.ScrolledWindow()
    scroll.set_hexpand(True)
    scroll.set_vexpand(True)
    scroll.add(view)
    dialog.get_content_area().pack_start(scroll, True, True, 0)

    # A worker may finish after Close; never touch a destroyed GTK buffer.
    closed = threading.Event()
    dialog.connect("destroy", lambda *_args: closed.set())
    dialog.connect("response", lambda current, *_args: current.destroy())

    def display_logs(text):
        if not closed.is_set():
            buffer.set_text(text)
        return False

    def load_logs():
        GLib.idle_add(display_logs, read_service_logs())

    dialog.show_all()
    threading.Thread(target=load_logs, daemon=True).start()
`
