#include <stddef.h>
#include <stdint.h>
int nc_secure_sudo(uint32_t uid, const char *cwd, const char *executable, const char *const *arguments, size_t count, const unsigned char *password, size_t password_len);
int nc_secure_listen(const char *path, unsigned int mode);
int nc_secure_accept(int fd, uint32_t *uid);
