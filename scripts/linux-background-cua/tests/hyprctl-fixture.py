# Isolated fixture only. Never point this verifier at a human desktop.
#!/usr/bin/env python3
import json,os,pathlib,sys
e=json.loads((pathlib.Path(__file__).parent/'fixture-env.json').read_text()); os.environ.update(e)
os.execv('/usr/bin/hyprctl',['hyprctl','-i',e['HYPRLAND_INSTANCE_SIGNATURE'],*sys.argv[1:]])
