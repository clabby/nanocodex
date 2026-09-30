#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <poll.h>
#include <fcntl.h>
#include <pwd.h>
#include <grp.h>
#include <unistd.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#define ASKPASS "/usr/libexec/nanocodex-secure-askpass"
#define ROOTDIR "/run/nanocodex-secure-input"

int nc_harden(void) {
    struct rlimit zero = {0,0};
    return setrlimit(RLIMIT_CORE, &zero) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) ? -1 : 0;
}
/* Before main, including the test executable. No keys are loaded before this. */
__attribute__((constructor)) static void startup(void) { if (nc_harden()) _exit(78); }
static void wipe(void *p, size_t n) { explicit_bzero(p, n); }
int nc_protected(const char *path, int directory) {
    if (!path || path[0] != '/' || strlen(path) >= 4096) return 0;
    int fd = open("/", O_PATH|O_DIRECTORY|O_CLOEXEC); if (fd < 0) return 0;
    char copy[4096]; strcpy(copy,path+1); char *save, *part=strtok_r(copy,"/",&save);
    if (!part) { struct stat st; int ok=directory && !fstat(fd,&st) && st.st_uid==0 && !(st.st_mode&022); close(fd); return ok; }
    while (part) {
        if (!strcmp(part,".") || !strcmp(part,"..")) { close(fd); return 0; }
        char *next=strtok_r(NULL,"/",&save);
        int item=openat(fd,part,O_PATH|O_NOFOLLOW|O_CLOEXEC); close(fd); if(item<0)return 0;
        struct stat st;
        int dir=next!=NULL || directory;
        if(fstat(item,&st) || st.st_uid!=0 || (st.st_mode&022) || (dir?!S_ISDIR(st.st_mode):!S_ISREG(st.st_mode))) {close(item);return 0;}
        fd=item; part=next;
    }
    close(fd);return 1;
}
static int listener(const char *path) {
    struct sockaddr_un a={.sun_family=AF_UNIX};
    if(strlen(path)>=sizeof(a.sun_path))return -1;
    strcpy(a.sun_path,path);
    /* PID-named endpoints never replace an existing endpoint. */
    int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);if(fd<0)return -1;
    mode_t old=umask(077);
    int bad=bind(fd,(struct sockaddr*)&a,sizeof(a)) || chmod(path,0600) || listen(fd,4);
    umask(old); if(bad){close(fd);return -1;}return fd;
}
static int io_exact(int fd,void *buffer,size_t count,int writing,struct timespec deadline) {
    unsigned char *p=buffer;
    while(count){struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);
        long ms=(deadline.tv_sec-now.tv_sec)*1000+(deadline.tv_nsec-now.tv_nsec)/1000000;
        if(ms<=0)return -1;
        struct pollfd event={fd,writing?POLLOUT:POLLIN,0};
        if(poll(&event,1,(int)ms)<=0)return -1;
        ssize_t n=writing?send(fd,p,count,MSG_NOSIGNAL):recv(fd,p,count,0);
        if(n<=0)return -1;
        p+=n;count-=n;
    }return 0;
}
/* The endpoint is root-only; also bind SO_PEERCRED PID to a live setuid askpass
   with the expected real UID and actual sudo parent. Requests cannot supply this. */
static int askpass_peer(int fd,pid_t parent,uid_t uid) {
    struct ucred cred; socklen_t len=sizeof(cred);
    if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&cred,&len)||len!=sizeof(cred)||cred.uid!=0)return 0;
    char path[64],line[256];snprintf(path,sizeof(path),"/proc/%d/status",cred.pid);
    FILE *f=fopen(path,"re");if(!f)return 0;
    unsigned real=0,effective=0;int ppid=-1;
    while(fgets(line,sizeof(line),f)){if(!strncmp(line,"PPid:",5))sscanf(line+5,"%d",&ppid);if(!strncmp(line,"Uid:",4))sscanf(line+4,"%u %u",&real,&effective);}
    fclose(f);if(ppid!=parent||real!=uid||effective!=0)return 0;
    /* Also inspect the actual live parent, not merely a claimed PPid number. */
    snprintf(path,sizeof(path),"/proc/%d/exe",parent);
    struct stat sudo_actual,sudo_expected;
    if(stat(path,&sudo_actual)||stat("/usr/bin/sudo",&sudo_expected)||
       sudo_actual.st_dev!=sudo_expected.st_dev||sudo_actual.st_ino!=sudo_expected.st_ino)return 0;
    snprintf(path,sizeof(path),"/proc/%d/status",parent);
    f=fopen(path,"re");if(!f)return 0;
    real=0;effective=0;
    while(fgets(line,sizeof(line),f))if(!strncmp(line,"Uid:",4))sscanf(line+4,"%u %u",&real,&effective);
    fclose(f);if(real!=uid||effective!=0)return 0;
    snprintf(path,sizeof(path),"/proc/%d/exe",cred.pid);
    struct stat actual,expected;
    return !stat(path,&actual)&&!stat(ASKPASS,&expected)&&actual.st_dev==expected.st_dev&&actual.st_ino==expected.st_ino;
}
int nc_secure_sudo(uint32_t uid,const char *cwd,const char *exe,const char *const *args,size_t count,const unsigned char *password,size_t size) {
    if(getuid()!=0||geteuid()!=0||!uid||count>128||size<1||size>4096||nc_harden())return -1;
    struct stat st;
    if(!nc_protected(exe,0)||!nc_protected("/usr/bin/sudo",0)||!nc_protected(ASKPASS,0)||!nc_protected(ROOTDIR,1))return -1;
    if(stat("/usr/bin/sudo",&st)||(st.st_mode&07777)!=04755||stat(ASKPASS,&st)||(st.st_mode&07777)!=04755||stat(ROOTDIR,&st)||(st.st_mode&07777)!=0700)return -1;
    struct passwd *account=getpwuid(uid);if(!account||account->pw_uid!=uid||strlen(account->pw_name)>=256)return -1;
    char username[256];strcpy(username,account->pw_name);gid_t gid=account->pw_gid;
    char **argv=calloc(count+6,sizeof(char*));if(!argv)return -1;
    argv[0]="/usr/bin/sudo";argv[1]="-A";argv[2]="-k";argv[3]="--";argv[4]=(char*)exe;
    for(size_t i=0;i<count;i++){if(!args||!args[i]){free(argv);return -1;}argv[5+i]=(char*)args[i];}
    char *env[]={"PATH=/usr/bin:/bin","LANG=C","SUDO_ASKPASS=" ASKPASS,NULL};
    int gate[2];if(pipe2(gate,O_CLOEXEC)){free(argv);return -1;}
    long limit=sysconf(_SC_OPEN_MAX);if(limit<0||limit>1048576)limit=1048576;
    pid_t child=fork();
    if(child==0){
        /* Forked root memory must never become dumpable. suid_dumpable=0 is a
           startup prerequisite: setresuid resets dumpability before next prctl. */
        if(nc_harden()||setpgid(0,0))_exit(126);
        wipe((void*)password,size);
        close(gate[1]);unsigned char ready;if(read(gate[0],&ready,1)!=1)_exit(126);close(gate[0]);
        int nullfd=open("/dev/null",O_RDWR|O_NOFOLLOW);if(nullfd<0)_exit(126);
        for(int fd=0;fd<3;fd++)if(dup2(nullfd,fd)<0)_exit(126);
        for(int fd=3;fd<limit;fd++)close(fd);
        if(initgroups(username,gid)||setresgid(gid,gid,gid)||nc_harden()||setresuid(uid,uid,uid)||nc_harden()||chdir(cwd))_exit(126);
        execve("/usr/bin/sudo",argv,env);_exit(126);
    }
    free(argv);close(gate[0]);if(child<0){close(gate[1]);return -1;}
    char path[108];snprintf(path,sizeof(path),ROOTDIR "/askpass-%u",(unsigned)child);
    int fd=listener(path);unsigned char ready=1;
    if(fd<0||write(gate[1],&ready,1)!=1){close(gate[1]);if(fd>=0){close(fd);unlink(path);}kill(child,SIGKILL);waitpid(child,NULL,0);return -1;}
    close(gate[1]);int used=0,status=0,result=-1,reaped=0;struct timespec start,now;clock_gettime(CLOCK_MONOTONIC,&start);
    while(!clock_gettime(CLOCK_MONOTONIC,&now)&&now.tv_sec-start.tv_sec<120){
        pid_t done=waitpid(child,&status,WNOHANG);if(done==child){reaped=1;result=WIFEXITED(status)?WEXITSTATUS(status):-1;break;}
        if(done<0&&errno!=EINTR){reaped=1;break;}
        struct pollfd event={fd,POLLIN,0};if(poll(&event,1,100)<=0)continue;
        int peer=accept4(fd,NULL,NULL,SOCK_CLOEXEC|SOCK_NONBLOCK);if(peer<0)continue;
        struct timespec deadline;clock_gettime(CLOCK_MONOTONIC,&deadline);deadline.tv_sec+=2;
        uint32_t request[2];
        if(!used&&askpass_peer(peer,child,uid)&&!io_exact(peer,request,sizeof(request),0,deadline)&&request[0]==(uint32_t)child&&request[1]==uid){
            used=1; /* Consume before partial delivery. */
            uint32_t n=(uint32_t)size;if(!io_exact(peer,&n,sizeof(n),1,deadline))io_exact(peer,(void*)password,size,1,deadline);
        }close(peer);
    }
    if(!reaped){kill(-child,SIGKILL);kill(child,SIGKILL);while(waitpid(child,&status,0)<0&&errno==EINTR){}}
    close(fd);unlink(path);return result;
}
