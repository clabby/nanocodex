#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
static int harden(void){struct rlimit zero={0,0};return setrlimit(RLIMIT_CORE,&zero)||prctl(PR_SET_DUMPABLE,0,0,0,0);}
__attribute__((constructor)) static void startup(void){if(harden())_exit(1);}
static int exact(int fd,void *b,size_t n){unsigned char*p=b;while(n){ssize_t k=read(fd,p,n);if(k<=0)return -1;p+=k;n-=k;}return 0;}
int main(int argc,char **argv){
    (void)argv;alarm(5);signal(SIGPIPE,SIG_IGN);
    /* sudo supplies one prompt argument; ignore it, never reflect it. */
    if((argc!=1&&argc!=2)||geteuid()!=0||getuid()==0||harden())return 1;
    struct stat st;if(fstat(STDOUT_FILENO,&st)||!S_ISFIFO(st.st_mode))return 1;
    char path[108];snprintf(path,sizeof(path),"/run/nanocodex-secure-input/askpass-%u",(unsigned)getppid());
    struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,path);
    int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0);if(fd<0)return 1;
    if(connect(fd,(struct sockaddr*)&address,sizeof(address)))return 1;
    struct ucred cred;socklen_t len=sizeof(cred);if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&cred,&len)||len!=sizeof(cred)||cred.uid!=0)return 1;
    uint32_t request[2]={(uint32_t)getppid(),(uint32_t)getuid()};if(write(fd,request,sizeof(request))!=sizeof(request))return 1;
    uint32_t size;if(exact(fd,&size,sizeof(size))||!size||size>4096)return 1;
    unsigned char password[4097]={0};if(exact(fd,password,size)){explicit_bzero(password,sizeof(password));return 1;}close(fd);
    password[size]='\n';size_t remaining=size+1;unsigned char*p=password;
    while(remaining){ssize_t n=write(STDOUT_FILENO,p,remaining);if(n<=0)break;p+=n;remaining-=n;}
    explicit_bzero(password,sizeof(password));return remaining?1:0;
}
