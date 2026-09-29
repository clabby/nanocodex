// Installed root:wheel 4755 by an explicitly approved signed installer.
// Never accepts a supplied PID, password, command, or output destination.
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/ptrace.h>
#include <unistd.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <signal.h>
static int read_exact(int fd, void *buffer, size_t count) {
    unsigned char *p = buffer;
    while (count) { ssize_t n = read(fd, p, count); if (n <= 0) return -1; p += n; count -= n; }
    return 0;
}
static void wipe(void *pointer, size_t size) { volatile unsigned char *p = pointer; while (size--) *p++ = 0; }
int main(void) {
    alarm(10);
    if (geteuid() != 0 || getuid() == 0) return 1;
    struct rlimit no_core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &no_core) || ptrace(PT_DENY_ATTACH, 0, 0, 0)) return 1;
    struct stat output;
    if (fstat(STDOUT_FILENO, &output) || !S_ISFIFO(output.st_mode)) return 1;
    char path[104];
    snprintf(path, sizeof(path), "/var/run/nanocodex-secure-input/askpass-%u", (unsigned int)getppid());
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(address.sun_path)) return 1;
    strcpy(address.sun_path, path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return 1;
    if (connect(fd, (struct sockaddr *)&address, sizeof(address))) return 1;
    uid_t peer; gid_t group;
    if (getpeereid(fd, &peer, &group) || peer != 0) return 1;
    uint32_t request[2] = {(uint32_t)getppid(), (uint32_t)getuid()};
    if (write(fd, request, sizeof(request)) != sizeof(request)) return 1;
    uint32_t size = 0;
    if (read_exact(fd, &size, sizeof(size)) || !size || size > 4096) return 1;
    unsigned char password[4097] = {0};
    if (read_exact(fd, password, size)) { wipe(password, sizeof(password)); return 1; }
    close(fd); password[size] = '\n';
    size_t remaining = size + 1; unsigned char *p = password;
    while (remaining) { ssize_t n = write(STDOUT_FILENO, p, remaining); if (n <= 0) break; p += n; remaining -= n; }
    wipe(password, sizeof(password)); return remaining ? 1 : 0;
}
