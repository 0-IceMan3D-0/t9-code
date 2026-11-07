/*
 * Talks to the app's USB broker (UsbBridge.kt) from inside the Linux environment.
 *
 * Android lets an app open a USB device only through UsbManager, so the app opens it and passes
 * the file descriptor over an abstract unix socket with SCM_RIGHTS. Requests and replies are
 * single lines with tab-separated fields:
 *
 *   open <bus> <dev>   -> "ok" with the usbfs fd attached, or "error <message>"
 *   list               -> "device <bus> <dev> <vid> <pid> <allowed> <maker> <product> <serial>"..., "end"
 *   allow <bus> <dev>  -> per device "asking <bus> <dev>", then "granted|denied|error <bus> <dev>", "end" (or "allow all")
 *   watch              -> "add <bus> <dev>"..., "ready", then "add"/"remove" lines as they happen
 *   selftest           -> "ok" with a pipe fd attached that reads "fd passing works"
 *
 * The app also keeps a fake sysfs and devfs tree for allowed devices under T3USB_ROOT, which the
 * preload library points /sys/bus/usb, /sys/dev/char and /dev/bus/usb at.
 */
#ifndef T3USB_H
#define T3USB_H

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

#define T3USB_DEFAULT_ROOT "/run/t3-usb"
#define T3USB_LINE_MAX 1024

static const char *t3usb_root(void) {
  const char *root = getenv("T3USB_ROOT");
  return root && *root ? root : T3USB_DEFAULT_ROOT;
}

/* The app passes the socket name in the environment; the file covers shells that dropped it. */
static int t3usb_socket_name(char *name, size_t size) {
  const char *env = getenv("T3USB_SOCKET");
  if (env && *env) {
    snprintf(name, size, "%s", env);
    return 0;
  }
  char path[256];
  snprintf(path, sizeof(path), "%s/socket", t3usb_root());
  int fd = (int)syscall(SYS_openat, AT_FDCWD, path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t count = read(fd, name, size - 1);
  close(fd);
  if (count <= 0) return -1;
  name[count] = 0;
  name[strcspn(name, "\r\n")] = 0;
  return name[0] ? 0 : -1;
}

static int t3usb_connect(void) {
  char name[108];
  if (t3usb_socket_name(name, sizeof(name)) != 0) {
    errno = ENOENT;
    return -1;
  }
  int sock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (sock < 0) return -1;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  size_t length = strlen(name);
  if (length > sizeof(address.sun_path) - 1) length = sizeof(address.sun_path) - 1;
  memcpy(address.sun_path + 1, name, length);
  socklen_t size = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + length);
  if (connect(sock, (struct sockaddr *)&address, size) != 0) {
    int saved = errno;
    close(sock);
    errno = saved;
    return -1;
  }
  return sock;
}

static int t3usb_send(int sock, const char *line) {
  size_t length = strlen(line);
  while (length > 0) {
    ssize_t written = send(sock, line, length, MSG_NOSIGNAL);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    line += written;
    length -= (size_t)written;
  }
  return 0;
}

/*
 * Reads one line a byte at a time, because a passed fd arrives with the first byte of the write
 * that carried it, and a larger read could run into the next message. Returns the line length, or
 * -1 at end of stream. *fd receives a passed descriptor, or stays -1.
 */
static ssize_t t3usb_read_line(int sock, char *line, size_t size, int *fd, int cloexec) {
  size_t used = 0;
  if (fd) *fd = -1;
  for (;;) {
    char byte;
    union {
      struct cmsghdr header;
      char space[CMSG_SPACE(sizeof(int) * 4)];
    } control;
    struct iovec vector = {.iov_base = &byte, .iov_len = 1};
    struct msghdr message;
    memset(&message, 0, sizeof(message));
    message.msg_iov = &vector;
    message.msg_iovlen = 1;
    message.msg_control = control.space;
    message.msg_controllen = sizeof(control.space);
    ssize_t count = recvmsg(sock, &message, cloexec ? MSG_CMSG_CLOEXEC : 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      if (fd && *fd >= 0) close(*fd);
      if (fd) *fd = -1;
      return -1;
    }
    for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header; header = CMSG_NXTHDR(&message, header)) {
      if (header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS) continue;
      int passed = (int)((header->cmsg_len - CMSG_LEN(0)) / sizeof(int));
      int *fds = (int *)CMSG_DATA(header);
      for (int index = 0; index < passed; index++) {
        if (fd && *fd < 0) *fd = fds[index];
        else close(fds[index]);
      }
    }
    if (byte == '\n') break;
    if (used + 1 < size) line[used++] = byte;
  }
  line[used] = 0;
  return (ssize_t)used;
}

/* Splits a line on tabs in place. Returns the number of fields. */
static int t3usb_fields(char *line, char **fields, int max) {
  int count = 0;
  char *cursor = line;
  while (count < max) {
    fields[count++] = cursor;
    char *tab = strchr(cursor, '\t');
    if (!tab) break;
    *tab = 0;
    cursor = tab + 1;
  }
  return count;
}

/* Asks the app for a fresh fd of an allowed device. Sets errno and returns -1 on failure. */
static int t3usb_open_device(int bus, int dev, int cloexec, char *error, size_t error_size) {
  int sock = t3usb_connect();
  if (sock < 0) {
    if (error) snprintf(error, error_size, "cannot reach the T3 app (%s)", strerror(errno));
    errno = EACCES;
    return -1;
  }
  char request[64];
  snprintf(request, sizeof(request), "open\t%d\t%d\n", bus, dev);
  char line[T3USB_LINE_MAX];
  int fd = -1;
  if (t3usb_send(sock, request) != 0 || t3usb_read_line(sock, line, sizeof(line), &fd, cloexec) < 0) {
    close(sock);
    if (error) snprintf(error, error_size, "the T3 app closed the connection");
    errno = EIO;
    return -1;
  }
  close(sock);
  if (strcmp(line, "ok") == 0 && fd >= 0) return fd;
  if (fd >= 0) close(fd);
  if (error) snprintf(error, error_size, "%s", strncmp(line, "error\t", 6) == 0 ? line + 6 : line);
  errno = strstr(line, "not attached") ? ENODEV : EACCES;
  return -1;
}

#endif
