#include <stddef.h>
#include <stdint.h>
// Call before loading any key or secret. This is irreversible for the process.
int nc_secure_disable_core_dumps(void);
int nc_secure_sudo(uint32_t uid, const char *cwd, const char *executable, const char *const *arguments, size_t count, const unsigned char *password, size_t password_len);
int nc_secure_listen(const char *path, unsigned int mode);
int nc_secure_accept(int fd, uint32_t *uid);
