#define _GNU_SOURCE
/* Dedicated disposable-root test only; includes unchanged release runner. */
#include "../c/runner.c"
static int limits(void){struct rlimit r;return !getrlimit(RLIMIT_CORE,&r)&&r.rlim_cur==0&&r.rlim_max==0&&prctl(PR_GET_DUMPABLE,0,0,0,0)==0;}
int main(int argc,char **argv){
    if(argc==2&&!strcmp(argv[1],"setuid")){if(getuid()!=1000||geteuid()!=0||!limits())return 20;return 0;}
    if(argc==2&&!strcmp(argv[1],"crash")){if(!limits())return 21;raise(SIGSEGV);return 22;}
    if(getuid()!=0||geteuid()!=0||!limits())return 1;
    pid_t child=fork();if(child<0)return 2;
    if(!child){
        if(setgroups(0,NULL)||setresgid(1000,1000,1000)||setresuid(1000,1000,1000))_exit(3);
        /* Test BEFORE another harden() call: Linux transition reset must be 0. */
        if(!limits())_exit(4);
        sleep(10);_exit(0);
    }
    usleep(200000);
    pid_t observer=fork();if(observer<0)return 5;
    if(!observer){
        if(setgroups(0,NULL)||setresgid(1000,1000,1000)||setresuid(1000,1000,1000))_exit(6);
        char path[80];snprintf(path,sizeof(path),"/proc/%d/mem",child);
        int fd=open(path,O_RDONLY);if(fd>=0){close(fd);_exit(7);}if(errno!=EACCES&&errno!=EPERM)_exit(8);_exit(0);
    }
    int status;if(waitpid(observer,&status,0)!=observer||!WIFEXITED(status)||WEXITSTATUS(status))return 9;
    kill(child,SIGKILL);waitpid(child,NULL,0);
    /* Constructor sees real setuid exec, not a simulated euid flag. */
    child=fork();if(child<0)return 10;
    if(!child){if(setgroups(0,NULL)||setresgid(1000,1000,1000)||setresuid(1000,1000,1000))_exit(11);execl(argv[0],argv[0],"setuid",NULL);_exit(12);}
    if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status))return 13;
    child=fork();if(child<0)return 14;
    if(!child){execl(argv[0],argv[0],"crash",NULL);_exit(15);}
    if(waitpid(child,&status,0)!=child||!WIFSIGNALED(status)||WTERMSIG(status)!=SIGSEGV||WCOREDUMP(status))return 16;
    /* Installed root askpass with correct real UID but a non-sudo parent must
       be rejected by the release peer predicate, even for root SO_PEERCRED. */
    char path[108];snprintf(path,sizeof(path),ROOTDIR "/askpass-%u",(unsigned)getpid());
    int fd=listener(path);if(fd<0)return 17;int pipefd[2];if(pipe(pipefd))return 18;
    child=fork();if(child<0)return 19;
    if(!child){close(fd);close(pipefd[0]);if(dup2(pipefd[1],1)<0)_exit(23);close(pipefd[1]);if(setgroups(0,NULL)||setresgid(1000,1000,1000)||setresuid(1000,1000,1000))_exit(24);execl(ASKPASS,ASKPASS,NULL);_exit(25);}
    close(pipefd[1]);struct pollfd event={fd,POLLIN,0};if(poll(&event,1,4000)<=0)return 26;
    int peer=accept4(fd,NULL,NULL,SOCK_CLOEXEC);if(peer<0)return 27;
    if(askpass_peer(peer,getpid(),1000))return 28;
    close(peer);close(fd);unlink(path);
    if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status)==0)return 29;
    char byte;if(read(pipefd[0],&byte,1)!=0)return 30;close(pipefd[0]);return 0;
}
