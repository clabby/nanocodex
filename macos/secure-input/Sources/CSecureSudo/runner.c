#include "CSecureSudo.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/ptrace.h>
#include <poll.h>
#include <fcntl.h>
#include <pwd.h>
#include <grp.h>
#include <unistd.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <time.h>

#define ASKPASS "/Library/PrivilegedHelperTools/xyz.paradigm.nanocodex.secure-askpass"
#define ROOTDIR "/var/run/nanocodex-secure-input"
int nc_secure_listen(const char *path, unsigned int mode) {
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    if (strlen(path) >= sizeof(address.sun_path)) return -1;
    strcpy(address.sun_path, path);
    struct stat st;
    if (lstat(path, &st) == 0) {
        if (!S_ISSOCK(st.st_mode) || st.st_uid != 0 || unlink(path)) return -1;
    } else if (errno != ENOENT) return -1;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) || chmod(path, mode) || listen(fd, 8)) { close(fd); return -1; }
    return fd;
}
int nc_secure_accept(int fd, uint32_t *uid) {
    int peer = accept(fd, NULL, NULL); if (peer < 0) return -1;
    fcntl(peer, F_SETFD, FD_CLOEXEC);
    uid_t user; gid_t group;
    if (getpeereid(peer, &user, &group)) { close(peer); return -1; }
    *uid = user;
    struct timeval timeout = {5, 0};
    setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(peer, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    return peer;
}
static int exact_io(int fd, void *buffer, size_t count, int writing) {
    unsigned char *p = buffer;
    while (count) { ssize_t n = writing ? write(fd, p, count) : read(fd, p, count); if (n <= 0) return -1; p += n; count -= n; }
    return 0;
}
// Reject mutable executable aliases. Approvals still trust interpreter arguments
// and everything the approved privileged program itself chooses to load.
static int protected_executable(const char *path) {
    char component[4096]; size_t length = strlen(path);
    if (!length || path[0] != '/' || length >= sizeof(component)) return 0;
    memcpy(component, path, length + 1);
    for (size_t i = 1; i <= length; ++i) {
        if (component[i] != '/' && component[i] != '\0') continue;
        char saved = component[i]; component[i] = '\0';
        struct stat item;
        if (lstat(component, &item) || item.st_uid != 0 || (item.st_mode & 022) ||
            (i == length ? !S_ISREG(item.st_mode) : !S_ISDIR(item.st_mode))) return 0;
        component[i] = saved;
    }
    return 1;
}
int nc_secure_sudo(uint32_t uid, const char *cwd, const char *executable, const char *const *arguments, size_t count, const unsigned char *password, size_t password_len) {
    if (getuid() != 0 || geteuid() != 0 || uid == 0 || count > 128 || password_len < 1 || password_len > 4096) return -1;
    if (!protected_executable(executable)) return -1;
    if (!arguments && count) return -1;
    for (size_t i = 0; i < count; ++i) if (!arguments[i]) return -1;
    struct stat st;
    if (lstat(ASKPASS, &st) || !S_ISREG(st.st_mode) || st.st_uid != 0 || (st.st_mode & 07777) != 04755) return -1;
    if (lstat(ROOTDIR, &st) || !S_ISDIR(st.st_mode) || st.st_uid != 0 || (st.st_mode & 0777) != 0700) return -1;
    struct passwd *account = getpwuid(uid); if (!account || account->pw_uid != uid) return -1;
    char username[256]; if (strlen(account->pw_name) >= sizeof(username)) return -1;
    strcpy(username, account->pw_name); gid_t gid = account->pw_gid;
    char socket_path[104];
    int gate[2]; if (pipe(gate)) return -1;
    char **argv = calloc(count + 7, sizeof(char *));
    if (!argv) { close(gate[0]); close(gate[1]); return -1; }
    argv[0] = "/usr/bin/sudo"; argv[1] = "-A"; argv[2] = "-k"; argv[3] = "--"; argv[4] = (char *)executable;
    for (size_t i = 0; i < count; ++i) argv[5+i] = (char *)arguments[i];
    char *environment[] = {"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C", "SUDO_ASKPASS=" ASKPASS, NULL};
    int descriptor_limit = getdtablesize();
    pid_t child = fork();
    if (child == 0) {
        // Prevent same-user tracing in the short interval before setuid sudo exec.
        if (ptrace(PT_DENY_ATTACH, 0, 0, 0)) _exit(126);
        setpgid(0, 0);
        close(gate[1]);
        unsigned char ready;
        if (read(gate[0], &ready, 1) != 1) _exit(126);
        close(gate[0]);
        int nullfd = open("/dev/null", O_RDWR);
        if (nullfd < 0) _exit(126);
        for (int fd = 0; fd < 3; ++fd) if (dup2(nullfd, fd) < 0) _exit(126);
        for (int fd = 3; fd < descriptor_limit; ++fd) close(fd);
        if (initgroups(username, gid) || setgid(gid) || setuid(uid) || chdir(cwd)) _exit(126);
        execve("/usr/bin/sudo", argv, environment); _exit(126);
    }
    free(argv);
    close(gate[0]);
    if (child < 0) { close(gate[1]); return -1; }
    snprintf(socket_path, sizeof(socket_path), ROOTDIR "/askpass-%u", (unsigned int)child);
    int listener = nc_secure_listen(socket_path, 0600);
    unsigned char ready = 1;
    if (listener < 0 || write(gate[1], &ready, 1) != 1) {
        close(gate[1]); if (listener >= 0) close(listener);
        kill(child, SIGKILL); waitpid(child, NULL, 0); unlink(socket_path); return -1;
    }
    close(gate[1]);
    int result = -1, used = 0, status = 0, reaped = 0;
    if (child > 0) {
        struct timespec started, current;
        clock_gettime(CLOCK_MONOTONIC, &started);
        while (clock_gettime(CLOCK_MONOTONIC, &current) == 0 && current.tv_sec - started.tv_sec < 120) {
            pid_t done = waitpid(child, &status, WNOHANG);
            if (done == child) { reaped = 1; result = WIFEXITED(status) ? WEXITSTATUS(status) : -1; break; }
            if (done < 0) { if (errno == EINTR) continue; reaped = 1; break; }
            struct pollfd event = {listener, POLLIN, 0};
            if (poll(&event, 1, 100) > 0 && (event.revents & POLLIN)) {
                uint32_t peer_uid = 0; int peer = nc_secure_accept(listener, &peer_uid);
                if (peer >= 0) {
                    uint32_t request[2];
                    if (!used && peer_uid == 0 && !exact_io(peer, request, sizeof(request), 0) && request[0] == (uint32_t)child && request[1] == uid) {
                        used = 1; // Consume before any possibly partial delivery.
                        uint32_t length = (uint32_t)password_len;
                        if (!exact_io(peer, &length, sizeof(length), 1)) exact_io(peer, (void *)password, password_len, 1);
                    }
                    close(peer);
                }
            }
        }
        if (!reaped) { kill(-child, SIGKILL); kill(child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
    }
    close(listener); unlink(socket_path); return result;
}
