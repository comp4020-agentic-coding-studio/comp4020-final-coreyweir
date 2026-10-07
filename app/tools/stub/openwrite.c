#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>

int main(int argc, char **argv) {
  const char *path = argv[1];
  if (argc < 2) path = "/mounted/bridge";
  int fd = open(path, O_RDWR);
  fprintf(stderr, "open(%s)=%d errno=%s\n", path, fd, fd < 0 ? strerror(errno) : "(ok)");
  if (fd < 0) return 1;
  const char *msg = "hello-from-wasm\n";
  ssize_t n = write(fd, msg, strlen(msg));
  fprintf(stderr, "write=%zd errno=%s\n", n, n < 0 ? strerror(errno) : "(ok)");
  return 0;
}
