#define _GNU_SOURCE
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "virtual-keyboard.h"
#include "virtual-pointer.h"
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static struct wl_seat *seat;
static struct zwp_virtual_keyboard_manager_v1 *manager;
static void add(void*d,struct wl_registry*r,uint32_t id,const char*iface,uint32_t v){
 if(!strcmp(iface,"zwlr_virtual_pointer_manager_v1"))pointer_manager=wl_registry_bind(r,id,&zwlr_virtual_pointer_manager_v1_interface,1);
 if(!strcmp(iface,"wl_seat")&&!seat)seat=wl_registry_bind(r,id,&wl_seat_interface,1);
 if(!strcmp(iface,"zwp_virtual_keyboard_manager_v1"))manager=wl_registry_bind(r,id,&zwp_virtual_keyboard_manager_v1_interface,1);
}
static void rem(void*d,struct wl_registry*r,uint32_t id){}
static const struct wl_registry_listener listener={add,rem};
int main(){
 struct wl_display*d=wl_display_connect(NULL);if(!d)return 1;
 struct wl_registry*r=wl_display_get_registry(d);wl_registry_add_listener(r,&listener,NULL);wl_display_roundtrip(d);if(!seat||!manager)return 2;
 if(!pointer_manager)return 4;
 struct zwlr_virtual_pointer_v1 *pointer=zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager,seat);wl_display_roundtrip(d);
 struct xkb_context*c=xkb_context_new(0);struct xkb_rule_names n={"evdev","pc105","us","",""};struct xkb_keymap*k=xkb_keymap_new_from_names(c,&n,0);char*s=xkb_keymap_get_as_string(k,XKB_KEYMAP_FORMAT_TEXT_V1);
 int fd=memfd_create("fixture-keymap",0);size_t len=strlen(s)+1; if(write(fd,s,len)!=len)return 3;
 struct zwp_virtual_keyboard_v1*v=zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager,seat);zwp_virtual_keyboard_v1_keymap(v,1,fd,len);wl_display_roundtrip(d);close(fd);free(s);
 fprintf(stderr,"primary fixture keyboard ready\n");
 char line[64];while(fgets(line,sizeof line,stdin)){unsigned key;if(sscanf(line,"%u",&key)==1){zwp_virtual_keyboard_v1_key(v,0,key,1);zwp_virtual_keyboard_v1_key(v,1,key,0);if(wl_display_roundtrip(d)<0)return 5;}}
 return 0;
}
