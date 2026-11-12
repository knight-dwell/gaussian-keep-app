#!/usr/bin/env python3
"""gaussian_keep: notes (Markdown / LaTeX / text / PDF), planner, organizer,
research journal, reminders and a git center, in one window.

The UI is HTML/CSS/JS (web/) shown in a WebKit view; backend.py serves it and
the data API on 127.0.0.1 with a random per-session token.
Running it again while it is open just brings the window to the front.
"""
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit2  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import backend  # noqa: E402


class KeepWindow(Gtk.ApplicationWindow):
    def __init__(self, app, url):
        super().__init__(application=app, title="gaussian_keep")
        self.set_wmclass("gaussian-keep", "GaussianKeep")
        self.set_default_size(1400, 860)
        self.set_icon_from_file(os.path.join(backend.WEB, "icon.svg")) if os.path.exists(
            os.path.join(backend.WEB, "icon.svg")) else None
        self.fullscreened = False

        # WebKit's own browser data goes to the cache (by default it would land in
        # ~/.local/share/gaussian-keep, i.e. next to this code)
        cache = os.path.join(GLib.get_user_cache_dir(), "gaussian-keep")
        data = WebKit2.WebsiteDataManager(base_data_directory=os.path.join(cache, "webkit-data"),
                                          base_cache_directory=os.path.join(cache, "webkit-cache"))
        context = WebKit2.WebContext.new_with_website_data_manager(data)
        manager = WebKit2.UserContentManager()
        manager.register_script_message_handler("keep")
        manager.connect("script-message-received::keep", self.on_message)
        self.view = WebKit2.WebView(web_context=context, user_content_manager=manager)
        s = self.view.get_settings()
        s.set_enable_developer_extras(bool(os.environ.get("KEEP_DEBUG")))
        s.set_javascript_can_access_clipboard(True)
        s.set_enable_write_console_messages_to_stdout(bool(os.environ.get("KEEP_DEBUG")))
        # links to the outside world open in the normal browser, not in here
        self.view.connect("decide-policy", self.on_policy)
        self.view.set_background_color(Gdk.RGBA(0.06, 0.09, 0.14, 1))
        self.add(self.view)
        self.view.load_uri(url)
        self.connect("window-state-event", self.on_state)

    def on_state(self, _w, ev):
        self.fullscreened = bool(ev.new_window_state & Gdk.WindowState.FULLSCREEN)

    def on_message(self, _manager, result):
        try:
            msg = result.get_js_value().to_string()
        except Exception:
            return
        if msg == "fullscreen":
            self.unfullscreen() if self.fullscreened else self.fullscreen()
        elif msg == "exit-fullscreen" and self.fullscreened:
            self.unfullscreen()
        elif msg.startswith("open:"):
            # open a file from the data folder (e.g. an exported PDF) in its default app
            full = os.path.realpath(os.path.join(backend.ROOT, msg[5:]))
            if full.startswith(os.path.realpath(backend.ROOT) + os.sep) and os.path.isfile(full):
                Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(full).get_uri(), None)

    def on_policy(self, view, decision, kind):
        if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            if not uri.startswith("http://127.0.0.1"):
                decision.ignore()
                Gio.AppInfo.launch_default_for_uri(uri, None)
                return True
        if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            decision.ignore()
            Gio.AppInfo.launch_default_for_uri(uri, None)
            return True
        return False


class KeepApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="dev.rice.GaussianKeep", flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.win = None

    def do_activate(self):
        if self.win:
            self.win.present()
            return
        port, token = backend.serve()
        self.win = KeepWindow(self, f"http://127.0.0.1:{port}/?token={token}")
        self.win.show_all()


if __name__ == "__main__":
    GLib.set_prgname("gaussian-keep")
    sys.exit(KeepApp().run(sys.argv[:1]))
