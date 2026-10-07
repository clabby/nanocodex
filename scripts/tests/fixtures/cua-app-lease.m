// Synthetic background app for the real LaunchServices cancellation journey.
#import <AppKit/AppKit.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
static void record(const char *name, pid_t pid) {
    char path[4096]; snprintf(path, sizeof(path), "%s/%s", getenv("NANOCODEX_CUA_FIXTURE_DIRECTORY"), name);
    FILE *file = fopen(path, "w"); if (!file) exit(2);
    fprintf(file, "%d", pid); fclose(file);
}
int main(void) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        char marker[4096]; snprintf(marker, sizeof(marker), "%s/with-grandchild", getenv("NANOCODEX_CUA_FIXTURE_DIRECTORY"));
        if (access(marker, F_OK) == 0) {
            pid_t child = fork();
            if (child == 0) { signal(SIGTERM, SIG_IGN); record("grandchild", getpid()); for (;;) pause(); }
        }
        record("helper", getpid());
        const char *path = getenv("SKY_CUA_SERVICE_NATIVE_PIPE_PATH");
        if (!path || strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) return 3;
        int server = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = { .sun_family = AF_UNIX };
        strcpy(address.sun_path, path);
        if (bind(server, (struct sockaddr *)&address, sizeof(address)) || listen(server, 1)) return 4;
        [NSApp run];
    }
}
