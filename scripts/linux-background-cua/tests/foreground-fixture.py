import gi,json,os
from pathlib import Path
gi.require_version('Gtk','3.0')
from gi.repository import Gtk
path=Path(os.environ['NANOCODEX_FOREGROUND_RECEIPT'])
w=Gtk.Window(title='Nanocodex foreground input fixture');w.set_default_size(500,250)
e=Gtk.Entry();e.set_placeholder_text('Primary seat typing receiver');w.add(e)
def save(*args): path.write_text(json.dumps({'pid':os.getpid(),'text':e.get_text(),'focus':e.has_focus()}))
e.connect('changed',save);w.connect('destroy',Gtk.main_quit);w.show_all();e.grab_focus();save();Gtk.main()
