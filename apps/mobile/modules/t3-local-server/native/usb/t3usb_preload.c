/*
 * LD_PRELOAD library that lets adb and fastboot use USB devices the T3 app has been allowed to use.
 *
 * Paths under /sys/bus/usb, /sys/dev/char and /dev/bus/usb point at the app's fake tree, and
 * opening a device node asks the app for a usbfs fd. That covers fastboot and adb's default native
 * backend. With ADB_LIBUSB=1 adb uses libusb, which cannot enumerate here, so libusb hotplug
 * registration is replaced with devices from the app.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <time.h>

#include "t3usb.h"

#define EXPORT __attribute__((visibility("default")))

static int debug_enabled = -1;

static void debug(const char *format, ...) {
  if (debug_enabled < 0) debug_enabled = getenv("T3USB_DEBUG") != NULL;
  if (!debug_enabled) return;
  va_list args;
  va_start(args, format);
  fprintf(stderr, "t3-usb: ");
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  va_end(args);
}

static void *real(const char *name) {
  void *symbol = dlsym(RTLD_NEXT, name);
  if (!symbol) debug("missing %s", name);
  return symbol;
}

#define REAL(type, name) \
  static __typeof__(type) real_##name; \
  if (!real_##name) real_##name = (type)real(#name)

static int has_prefix(const char *path, const char *prefix) {
  size_t length = strlen(prefix);
  return strncmp(path, prefix, length) == 0 && (path[length] == 0 || path[length] == '/');
}

/*
 * Returns the path inside the fake tree, or the original path when it is not a USB path. adb's
 * native backend names a device by reading the /sys/dev/char link of the usbfs fd's major:minor.
 */
static const char *rewrite(const char *path, char *buffer, size_t size) {
  if (!path) return path;
  if (!has_prefix(path, "/sys/bus/usb") && !has_prefix(path, "/dev/bus/usb") && !has_prefix(path, "/sys/dev/char")) {
    return path;
  }
  snprintf(buffer, size, "%s%s", t3usb_root(), path);
  return buffer;
}

/* Matches /dev/bus/usb/BBB/DDD exactly. */
static int device_node(const char *path, int *bus, int *dev) {
  if (!path || strncmp(path, "/dev/bus/usb/", 13) != 0) return 0;
  char tail;
  return sscanf(path + 13, "%d/%d%c", bus, dev, &tail) == 2;
}

static int open_device(const char *path, int flags) {
  int bus, dev;
  device_node(path, &bus, &dev);
  char fake[512];
  rewrite(path, fake, sizeof(fake));
  if (syscall(SYS_faccessat, AT_FDCWD, fake, F_OK) != 0) {
    debug("%s is not an allowed device", path);
    errno = ENOENT;
    return -1;
  }
  char error[256];
  int fd = t3usb_open_device(bus, dev, (flags & O_CLOEXEC) != 0, error, sizeof(error));
  if (fd < 0) {
    int saved = errno;
    fprintf(stderr, "t3-usb: %s: %s\n", path, error);
    errno = saved;
    return -1;
  }
  /* Every holder of the device file shares its offset, and a read returns descriptors from it. */
  lseek(fd, 0, SEEK_SET);
  debug("opened %s as fd %d", path, fd);
  return fd;
}

static mode_t mode_argument(int flags, va_list args) {
  return (flags & (O_CREAT | O_TMPFILE)) ? (mode_t)va_arg(args, int) : 0;
}

#define DEFINE_OPEN(name) \
  EXPORT int name(const char *path, int flags, ...) { \
    va_list args; \
    va_start(args, flags); \
    mode_t mode = mode_argument(flags, args); \
    va_end(args); \
    if (device_node(path, &(int){0}, &(int){0})) return open_device(path, flags); \
    char buffer[512]; \
    REAL(int (*)(const char *, int, ...), name); \
    return real_##name(rewrite(path, buffer, sizeof(buffer)), flags, mode); \
  }

DEFINE_OPEN(open)
DEFINE_OPEN(open64)

#define DEFINE_OPEN_2(name) \
  EXPORT int name(const char *path, int flags) { \
    if (device_node(path, &(int){0}, &(int){0})) return open_device(path, flags); \
    char buffer[512]; \
    REAL(int (*)(const char *, int), name); \
    return real_##name(rewrite(path, buffer, sizeof(buffer)), flags); \
  }

DEFINE_OPEN_2(__open_2)
DEFINE_OPEN_2(__open64_2)

#define DEFINE_OPENAT(name) \
  EXPORT int name(int dirfd, const char *path, int flags, ...) { \
    va_list args; \
    va_start(args, flags); \
    mode_t mode = mode_argument(flags, args); \
    va_end(args); \
    if (device_node(path, &(int){0}, &(int){0})) return open_device(path, flags); \
    char buffer[512]; \
    REAL(int (*)(int, const char *, int, ...), name); \
    return real_##name(dirfd, rewrite(path, buffer, sizeof(buffer)), flags, mode); \
  }

DEFINE_OPENAT(openat)
DEFINE_OPENAT(openat64)

#define DEFINE_OPENAT_2(name) \
  EXPORT int name(int dirfd, const char *path, int flags) { \
    if (device_node(path, &(int){0}, &(int){0})) return open_device(path, flags); \
    char buffer[512]; \
    REAL(int (*)(int, const char *, int), name); \
    return real_##name(dirfd, rewrite(path, buffer, sizeof(buffer)), flags); \
  }

DEFINE_OPENAT_2(__openat_2)
DEFINE_OPENAT_2(__openat64_2)

#define DEFINE_FOPEN(name) \
  EXPORT FILE *name(const char *path, const char *mode) { \
    if (device_node(path, &(int){0}, &(int){0})) { \
      int fd = open_device(path, strchr(mode, 'e') ? O_CLOEXEC : 0); \
      return fd < 0 ? NULL : fdopen(fd, mode); \
    } \
    char buffer[512]; \
    REAL(FILE * (*)(const char *, const char *), name); \
    return real_##name(rewrite(path, buffer, sizeof(buffer)), mode); \
  }

DEFINE_FOPEN(fopen)
DEFINE_FOPEN(fopen64)

EXPORT DIR *opendir(const char *path) {
  char buffer[512];
  REAL(DIR * (*)(const char *), opendir);
  return real_opendir(rewrite(path, buffer, sizeof(buffer)));
}

#define DEFINE_STAT(name, type) \
  EXPORT int name(const char *path, type *result) { \
    char buffer[512]; \
    REAL(int (*)(const char *, type *), name); \
    return real_##name(rewrite(path, buffer, sizeof(buffer)), result); \
  }

DEFINE_STAT(stat, struct stat)
DEFINE_STAT(lstat, struct stat)
DEFINE_STAT(stat64, struct stat64)
DEFINE_STAT(lstat64, struct stat64)

#define DEFINE_FSTATAT(name, type) \
  EXPORT int name(int dirfd, const char *path, type *result, int flags) { \
    char buffer[512]; \
    REAL(int (*)(int, const char *, type *, int), name); \
    return real_##name(dirfd, rewrite(path, buffer, sizeof(buffer)), result, flags); \
  }

DEFINE_FSTATAT(fstatat, struct stat)
DEFINE_FSTATAT(fstatat64, struct stat64)

EXPORT int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *result) {
  char buffer[512];
  REAL(int (*)(int, const char *, int, unsigned int, struct statx *), statx);
  return real_statx(dirfd, rewrite(path, buffer, sizeof(buffer)), flags, mask, result);
}

EXPORT int access(const char *path, int mode) {
  char buffer[512];
  REAL(int (*)(const char *, int), access);
  return real_access(rewrite(path, buffer, sizeof(buffer)), mode);
}

EXPORT int faccessat(int dirfd, const char *path, int mode, int flags) {
  char buffer[512];
  REAL(int (*)(int, const char *, int, int), faccessat);
  return real_faccessat(dirfd, rewrite(path, buffer, sizeof(buffer)), mode, flags);
}

EXPORT ssize_t readlink(const char *path, char *target, size_t size) {
  char buffer[512];
  REAL(ssize_t (*)(const char *, char *, size_t), readlink);
  return real_readlink(rewrite(path, buffer, sizeof(buffer)), target, size);
}

EXPORT ssize_t readlinkat(int dirfd, const char *path, char *target, size_t size) {
  char buffer[512];
  REAL(ssize_t (*)(int, const char *, char *, size_t), readlinkat);
  return real_readlinkat(dirfd, rewrite(path, buffer, sizeof(buffer)), target, size);
}

EXPORT int inotify_add_watch(int fd, const char *path, uint32_t mask) {
  char buffer[512];
  REAL(int (*)(int, const char *, uint32_t), inotify_add_watch);
  return real_inotify_add_watch(fd, rewrite(path, buffer, sizeof(buffer)), mask);
}

/* libusb, declared here so the library loads into programs that do not use it. */

typedef struct libusb_context libusb_context;
typedef struct libusb_device libusb_device;
typedef struct libusb_device_handle libusb_device_handle;
typedef int (*hotplug_fn)(libusb_context *, libusb_device *, int, void *);

#define OPTION_NO_DEVICE_DISCOVERY 2
#define EVENT_ARRIVED 1
#define EVENT_LEFT 2
#define FLAG_ENUMERATE 1
#define MAX_CALLBACKS 8
#define MAX_DEVICES 32

struct callback {
  int handle;
  int events;
  hotplug_fn function;
  void *user_data;
};

struct device {
  int bus;
  int dev;
  libusb_device *device;
  int seen;
};

static pthread_mutex_t lock = PTHREAD_RECURSIVE_MUTEX_INITIALIZER_NP;
static struct callback callbacks[MAX_CALLBACKS];
static struct device devices[MAX_DEVICES];
static libusb_context *hotplug_context;
static int next_handle = 1;
static int watching;

static void disable_discovery(void) {
  REAL(int (*)(libusb_context *, int, ...), libusb_set_option);
  if (real_libusb_set_option) real_libusb_set_option(NULL, OPTION_NO_DEVICE_DISCOVERY);
}

/* Discovery needs udev and netlink, which Android does not give apps. */
EXPORT int libusb_init(libusb_context **context) {
  disable_discovery();
  REAL(int (*)(libusb_context **), libusb_init);
  int result = real_libusb_init(context);
  debug("libusb_init without device discovery: %d", result);
  return result;
}

EXPORT int libusb_init_context(libusb_context **context, const void *options, int count) {
  disable_discovery();
  REAL(int (*)(libusb_context **, const void *, int), libusb_init_context);
  return real_libusb_init_context(context, options, count);
}

static void notify(struct callback *callback, libusb_device *device, int event) {
  if (!callback->function || !(callback->events & event)) return;
  if (callback->function(hotplug_context, device, event, callback->user_data)) callback->function = NULL;
}

static void notify_all(libusb_device *device, int event) {
  for (int index = 0; index < MAX_CALLBACKS; index++) notify(&callbacks[index], device, event);
}

static struct device *find_device(int bus, int dev) {
  for (int index = 0; index < MAX_DEVICES; index++) {
    if (devices[index].device && devices[index].bus == bus && devices[index].dev == dev) return &devices[index];
  }
  return NULL;
}

static void add_device(int bus, int dev) {
  struct device *existing = find_device(bus, dev);
  if (existing) {
    existing->seen = 1;
    return;
  }
  struct device *slot = NULL;
  for (int index = 0; index < MAX_DEVICES && !slot; index++) {
    if (!devices[index].device) slot = &devices[index];
  }
  if (!slot) return;
  char error[256];
  int fd = t3usb_open_device(bus, dev, 1, error, sizeof(error));
  if (fd < 0) {
    fprintf(stderr, "t3-usb: device %03d/%03d: %s\n", bus, dev, error);
    return;
  }
  REAL(int (*)(libusb_context *, intptr_t, libusb_device_handle **), libusb_wrap_sys_device);
  REAL(libusb_device * (*)(libusb_device_handle *), libusb_get_device);
  REAL(libusb_device * (*)(libusb_device *), libusb_ref_device);
  REAL(void (*)(libusb_device_handle *), libusb_close);
  libusb_device_handle *handle = NULL;
  int result = real_libusb_wrap_sys_device(hotplug_context, fd, &handle);
  debug("device %03d/%03d: libusb_wrap_sys_device returned %d", bus, dev, result);
  if (result != 0) {
    fprintf(stderr, "t3-usb: device %03d/%03d: libusb could not use it (%d)\n", bus, dev, result);
    close(fd);
    return;
  }
  /* The device outlives this handle. libusb_open reopens it through open_device. */
  slot->device = real_libusb_ref_device(real_libusb_get_device(handle));
  real_libusb_close(handle);
  close(fd);
  slot->bus = bus;
  slot->dev = dev;
  slot->seen = 1;
  debug("device %03d/%03d arrived", bus, dev);
  notify_all(slot->device, EVENT_ARRIVED);
}

static void remove_device(struct device *device) {
  REAL(void (*)(libusb_device *), libusb_unref_device);
  libusb_device *gone = device->device;
  device->device = NULL;
  debug("device %03d/%03d left", device->bus, device->dev);
  notify_all(gone, EVENT_LEFT);
  real_libusb_unref_device(gone);
}

static void watch_once(void) {
  int sock = t3usb_connect();
  if (sock < 0) return;
  if (t3usb_send(sock, "watch\n") != 0) {
    close(sock);
    return;
  }
  char line[T3USB_LINE_MAX];
  int synced = 0;
  pthread_mutex_lock(&lock);
  for (int index = 0; index < MAX_DEVICES; index++) devices[index].seen = 0;
  pthread_mutex_unlock(&lock);
  while (t3usb_read_line(sock, line, sizeof(line), NULL, 1) >= 0) {
    char *fields[3];
    int count = t3usb_fields(line, fields, 3);
    pthread_mutex_lock(&lock);
    if (strcmp(fields[0], "ready") == 0 && !synced) {
      synced = 1;
      for (int index = 0; index < MAX_DEVICES; index++) {
        if (devices[index].device && !devices[index].seen) remove_device(&devices[index]);
      }
    } else if (count == 3 && strcmp(fields[0], "add") == 0) {
      add_device(atoi(fields[1]), atoi(fields[2]));
    } else if (count == 3 && strcmp(fields[0], "remove") == 0) {
      struct device *device = find_device(atoi(fields[1]), atoi(fields[2]));
      if (device) remove_device(device);
    }
    pthread_mutex_unlock(&lock);
  }
  close(sock);
}

/* Reconnects while the app restarts. Devices stay listed until a fresh list says otherwise. */
static void *watch_thread(void *unused) {
  (void)unused;
  for (;;) {
    watch_once();
    struct timespec delay = {.tv_sec = 2};
    nanosleep(&delay, NULL);
  }
  return NULL;
}

EXPORT int libusb_hotplug_register_callback(libusb_context *context, int events, int flags, int vendor_id,
                                            int product_id, int dev_class, hotplug_fn function, void *user_data,
                                            int *handle) {
  (void)vendor_id;
  (void)product_id;
  (void)dev_class;
  pthread_mutex_lock(&lock);
  struct callback *slot = NULL;
  for (int index = 0; index < MAX_CALLBACKS && !slot; index++) {
    if (!callbacks[index].function) slot = &callbacks[index];
  }
  if (!slot) {
    pthread_mutex_unlock(&lock);
    return -11; /* LIBUSB_ERROR_NO_MEM */
  }
  debug("hotplug callback registered (events %d, flags %d)", events, flags);
  hotplug_context = context;
  *slot = (struct callback){.handle = next_handle++, .events = events, .function = function, .user_data = user_data};
  if (handle) *handle = slot->handle;
  if (flags & FLAG_ENUMERATE) {
    for (int index = 0; index < MAX_DEVICES; index++) {
      if (devices[index].device) notify(slot, devices[index].device, EVENT_ARRIVED);
    }
  }
  if (!watching) {
    pthread_t thread;
    watching = pthread_create(&thread, NULL, watch_thread, NULL) == 0;
    if (watching) pthread_detach(thread);
  }
  pthread_mutex_unlock(&lock);
  return 0;
}

EXPORT void libusb_hotplug_deregister_callback(libusb_context *context, int handle) {
  (void)context;
  pthread_mutex_lock(&lock);
  for (int index = 0; index < MAX_CALLBACKS; index++) {
    if (callbacks[index].handle == handle) callbacks[index].function = NULL;
  }
  pthread_mutex_unlock(&lock);
}

/* Wrapped devices have no sysfs path, so the port is the device number, matching the fake tree. */
EXPORT int libusb_get_port_numbers(libusb_device *device, uint8_t *ports, int length) {
  pthread_mutex_lock(&lock);
  for (int index = 0; index < MAX_DEVICES; index++) {
    if (devices[index].device == device && length > 0) {
      ports[0] = (uint8_t)devices[index].dev;
      pthread_mutex_unlock(&lock);
      return 1;
    }
  }
  pthread_mutex_unlock(&lock);
  REAL(int (*)(libusb_device *, uint8_t *, int), libusb_get_port_numbers);
  return real_libusb_get_port_numbers(device, ports, length);
}
