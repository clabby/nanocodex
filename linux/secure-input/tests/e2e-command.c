#define _GNU_SOURCE
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
int main(int argc,char **argv){
    if(getuid()!=0||geteuid()!=0||argc!=2)return 90;
    char byte;if(read(0,&byte,1)!=0)return 91;
    if(!strcmp(argv[1],"timeout")){sleep(130);return 92;}
    if(strcmp(argv[1],"success"))return 93;
    /* Both output streams are intentionally noisy, but never contain a secret. */
    puts("approved-root-command-stdout");fputs("approved-root-command-stderr\n",stderr);
    return 0;
}
