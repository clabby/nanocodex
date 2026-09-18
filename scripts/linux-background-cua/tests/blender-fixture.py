import bpy,json,os,time
bpy.context.preferences.view.show_splash=False
started=time.monotonic()
def observe():
    try:
        obj=bpy.data.objects.get('Cube')
        areas=[{'type':a.type,'width':a.width,'height':a.height,'x':a.x,'y':a.y} for a in bpy.context.screen.areas]
        views=[list(a.spaces.active.region_3d.view_rotation) for a in bpy.context.screen.areas if a.type=='VIEW_3D']
        p=os.environ['NANOCODEX_FIXTURE_RECEIPT'];tmp=p+'.new'
        with open(tmp,'w') as f: json.dump({'pid':os.getpid(),'elapsed':time.monotonic()-started,'cube':list(obj.location) if obj else None,'areas':areas,'views':views,'view_locations':[list(a.spaces.active.region_3d.view_location) for a in bpy.context.screen.areas if a.type=='VIEW_3D']},f)
        os.replace(tmp,p)
    except Exception as e: print(e,flush=True)
    return .05
bpy.app.timers.register(observe,first_interval=.3,persistent=True)
