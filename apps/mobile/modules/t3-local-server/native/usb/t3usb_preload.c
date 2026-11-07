/*
 * Preloaded into every glibc program in the Linux environment (/etc/ld.so.preload), so any USB
 * tool can use devices the T3 app has been allowed to use.
 *
 * 1. Paths under /sys/bus/usb and /dev/bus/usb, and /sys/dev/char links the app wrote, point at its fake tree,
 *    and opening a device node asks the app for a usbfs fd. That covers programs that read sysfs
 *    and usbfs themselves, such as adb's and fastboot's native backends.
 * 2. Android gives apps no uevent netlink socket, so libudev cannot monitor devices, and its sysfs
 *    walk does not see the fake tree. When netlink is unavailable, udev monitors and "usb"
 *    enumerations are answered here from the fake tree and the app's watch stream. libusb then
 *    enumerates and hotplugs through its normal code path, however it was loaded (pyusb's ctypes,
 *    a dlopen with RTLD_LOCAL, or a plain link), because its calls into libudev go through the PLT.
 *
 * Everything else passes straight to glibc: a prefix check is the whole cost of an unrelated call.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <linux/netlink.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <time.h>

#include "t3usb.h"

#define EXPORT __attribute__((visibility("default")))

static int debug_enabled = -1;

static void debug(const char *format, ...) {
  if (debug_enabled < 0) debug_enabled = secure_getenv("T3USB_DEBUG") != NULL;
  if (!debug_enabled) return;
  va_list args;
  va_start(args, format);
  fprintf(stderr, "t3-usb: ");
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  va_end(args);
}

/* Lets t3-usb selftest see that the library is loaded into it. */
EXPORT const char t3usb_preloaded[] = "t3-usb";

/* ---- Path redirection ---------------------------------------------------------------------- */

static int has_prefix(const char *path, const char *prefix) {
  size_t length = strlen(prefix);
  return strncmp(path, prefix, length) == 0 && (path[length] == 0 || path[length] == '/');
}

/*
 * Returns the path inside the fake tree, or the original path when it is not a USB path. adb's
 * native backend names a device by reading the /sys/dev/char link of the usbfs fd's major:minor,
 * so a link there is redirected only when the fake tree has it, and other devices keep their own.
 */
static const char *rewrite(const char *path, char *buffer, size_t size) {
  if (!path || path[0] != '/') return path;
  if (strncmp(path, "/sys/dev/char/", 14) == 0) {
    struct stat info;
    snprintf(buffer, size, "%s%s", t3usb_root(), path);
    return syscall(SYS_newfstatat, AT_FDCWD, buffer, &info, AT_SYMLINK_NOFOLLOW) == 0 ? buffer : path;
  }
  if (!has_prefix(path, "/sys/bus/usb") && !has_prefix(path, "/dev/bus/usb")) return path;
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

/*
 * The real functions, resolved once when the library loads. A malloc that opens files during its
 * own start (jemalloc reads /proc) can call in while dlsym is still running; until a symbol is
 * resolved, those calls go to the kernel directly instead of recursing into dlsym.
 */
static int (*real_open)(const char *, int, ...);
static int (*real_open64)(const char *, int, ...);
static int (*real___open_2)(const char *, int);
static int (*real___open64_2)(const char *, int);
static int (*real_openat)(int, const char *, int, ...);
static int (*real_openat64)(int, const char *, int, ...);
static int (*real___openat_2)(int, const char *, int);
static int (*real___openat64_2)(int, const char *, int);
static FILE *(*real_fopen)(const char *, const char *);
static FILE *(*real_fopen64)(const char *, const char *);
static DIR *(*real_opendir)(const char *);
static int (*real_stat)(const char *, struct stat *);
static int (*real_lstat)(const char *, struct stat *);
static int (*real_stat64)(const char *, struct stat64 *);
static int (*real_lstat64)(const char *, struct stat64 *);
static int (*real_fstatat)(int, const char *, struct stat *, int);
static int (*real_fstatat64)(int, const char *, struct stat64 *, int);
static int (*real_statx)(int, const char *, int, unsigned int, struct statx *);
static int (*real_access)(const char *, int);
static int (*real_faccessat)(int, const char *, int, int);
static ssize_t (*real_readlink)(const char *, char *, size_t);
static ssize_t (*real_readlinkat)(int, const char *, char *, size_t);
static int (*real_inotify_add_watch)(int, const char *, uint32_t);

#define RESOLVE(name) real_##name = (__typeof__(real_##name))dlsym(RTLD_NEXT, #name)

__attribute__((constructor)) static void resolve_all(void) {
  RESOLVE(open);
  RESOLVE(open64);
  RESOLVE(__open_2);
  RESOLVE(__open64_2);
  RESOLVE(openat);
  RESOLVE(openat64);
  RESOLVE(__openat_2);
  RESOLVE(__openat64_2);
  RESOLVE(fopen);
  RESOLVE(fopen64);
  RESOLVE(opendir);
  RESOLVE(stat);
  RESOLVE(lstat);
  RESOLVE(stat64);
  RESOLVE(lstat64);
  RESOLVE(fstatat);
  RESOLVE(fstatat64);
  RESOLVE(statx);
  RESOLVE(access);
  RESOLVE(faccessat);
  RESOLVE(readlink);
  RESOLVE(readlinkat);
  RESOLVE(inotify_add_watch);
}

static mode_t mode_argument(int flags, va_list args) {
  return (flags & (O_CREAT | O_TMPFILE)) ? (mode_t)va_arg(args, int) : 0;
}

static int open_path(int dirfd, const char *path, int flags, mode_t mode,
                     int (*real)(int, const char *, int, mode_t)) {
  if (device_node(path, &(int){0}, &(int){0})) return open_device(path, flags);
  char buffer[512];
  const char *target = rewrite(path, buffer, sizeof(buffer));
  if (real) return real(dirfd, target, flags, mode);
  return (int)syscall(SYS_openat, dirfd, target, flags, mode);
}

static int call_open(int dirfd, const char *path, int flags, mode_t mode) {
  (void)dirfd;
  return real_open(path, flags, mode);
}
static int call_open64(int dirfd, const char *path, int flags, mode_t mode) {
  (void)dirfd;
  return real_open64(path, flags, mode);
}
static int call_open_2(int dirfd, const char *path, int flags, mode_t mode) {
  (void)dirfd;
  (void)mode;
  return real___open_2(path, flags);
}
static int call_open64_2(int dirfd, const char *path, int flags, mode_t mode) {
  (void)dirfd;
  (void)mode;
  return real___open64_2(path, flags);
}
static int call_openat(int dirfd, const char *path, int flags, mode_t mode) {
  return real_openat(dirfd, path, flags, mode);
}
static int call_openat64(int dirfd, const char *path, int flags, mode_t mode) {
  return real_openat64(dirfd, path, flags, mode);
}
static int call_openat_2(int dirfd, const char *path, int flags, mode_t mode) {
  (void)mode;
  return real___openat_2(dirfd, path, flags);
}
static int call_openat64_2(int dirfd, const char *path, int flags, mode_t mode) {
  (void)mode;
  return real___openat64_2(dirfd, path, flags);
}

EXPORT int open(const char *path, int flags, ...) {
  va_list args;
  va_start(args, flags);
  mode_t mode = mode_argument(flags, args);
  va_end(args);
  return open_path(AT_FDCWD, path, flags, mode, real_open ? call_open : NULL);
}

EXPORT int open64(const char *path, int flags, ...) {
  va_list args;
  va_start(args, flags);
  mode_t mode = mode_argument(flags, args);
  va_end(args);
  return open_path(AT_FDCWD, path, flags, mode, real_open64 ? call_open64 : NULL);
}

EXPORT int __open_2(const char *path, int flags) {
  return open_path(AT_FDCWD, path, flags, 0, real___open_2 ? call_open_2 : NULL);
}

EXPORT int __open64_2(const char *path, int flags) {
  return open_path(AT_FDCWD, path, flags, 0, real___open64_2 ? call_open64_2 : NULL);
}

EXPORT int openat(int dirfd, const char *path, int flags, ...) {
  va_list args;
  va_start(args, flags);
  mode_t mode = mode_argument(flags, args);
  va_end(args);
  return open_path(dirfd, path, flags, mode, real_openat ? call_openat : NULL);
}

EXPORT int openat64(int dirfd, const char *path, int flags, ...) {
  va_list args;
  va_start(args, flags);
  mode_t mode = mode_argument(flags, args);
  va_end(args);
  return open_path(dirfd, path, flags, mode, real_openat64 ? call_openat64 : NULL);
}

EXPORT int __openat_2(int dirfd, const char *path, int flags) {
  return open_path(dirfd, path, flags, 0, real___openat_2 ? call_openat_2 : NULL);
}

EXPORT int __openat64_2(int dirfd, const char *path, int flags) {
  return open_path(dirfd, path, flags, 0, real___openat64_2 ? call_openat64_2 : NULL);
}

static FILE *fopen_path(const char *path, const char *mode, FILE *(*real)(const char *, const char *)) {
  if (device_node(path, &(int){0}, &(int){0})) {
    int fd = open_device(path, strchr(mode, 'e') ? O_CLOEXEC : 0);
    return fd < 0 ? NULL : fdopen(fd, mode);
  }
  if (!real) {
    errno = EAGAIN;
    return NULL;
  }
  char buffer[512];
  return real(rewrite(path, buffer, sizeof(buffer)), mode);
}

EXPORT FILE *fopen(const char *path, const char *mode) { return fopen_path(path, mode, real_fopen); }

EXPORT FILE *fopen64(const char *path, const char *mode) { return fopen_path(path, mode, real_fopen64); }

EXPORT DIR *opendir(const char *path) {
  if (!real_opendir) {
    errno = EAGAIN;
    return NULL;
  }
  char buffer[512];
  return real_opendir(rewrite(path, buffer, sizeof(buffer)));
}

/* On arm64 and x86_64, glibc's struct stat and stat64 match the kernel's, so newfstatat fills them. */
#define DEFINE_STAT(name, type, flags) \
  EXPORT int name(const char *path, type *result) { \
    char buffer[512]; \
    const char *target = rewrite(path, buffer, sizeof(buffer)); \
    if (real_##name) return real_##name(target, result); \
    return (int)syscall(SYS_newfstatat, AT_FDCWD, target, result, flags); \
  }

DEFINE_STAT(stat, struct stat, 0)
DEFINE_STAT(lstat, struct stat, AT_SYMLINK_NOFOLLOW)
DEFINE_STAT(stat64, struct stat64, 0)
DEFINE_STAT(lstat64, struct stat64, AT_SYMLINK_NOFOLLOW)

#define DEFINE_FSTATAT(name, type) \
  EXPORT int name(int dirfd, const char *path, type *result, int flags) { \
    char buffer[512]; \
    const char *target = rewrite(path, buffer, sizeof(buffer)); \
    if (real_##name) return real_##name(dirfd, target, result, flags); \
    return (int)syscall(SYS_newfstatat, dirfd, target, result, flags); \
  }

DEFINE_FSTATAT(fstatat, struct stat)
DEFINE_FSTATAT(fstatat64, struct stat64)

EXPORT int statx(int dirfd, const char *path, int flags, unsigned int mask, struct statx *result) {
  char buffer[512];
  const char *target = rewrite(path, buffer, sizeof(buffer));
  if (real_statx) return real_statx(dirfd, target, flags, mask, result);
  return (int)syscall(SYS_statx, dirfd, target, flags, mask, result);
}

EXPORT int access(const char *path, int mode) {
  char buffer[512];
  const char *target = rewrite(path, buffer, sizeof(buffer));
  if (real_access) return real_access(target, mode);
  return (int)syscall(SYS_faccessat, AT_FDCWD, target, mode);
}

EXPORT int faccessat(int dirfd, const char *path, int mode, int flags) {
  char buffer[512];
  const char *target = rewrite(path, buffer, sizeof(buffer));
  if (real_faccessat) return real_faccessat(dirfd, target, mode, flags);
  return (int)syscall(SYS_faccessat, dirfd, target, mode);
}

EXPORT ssize_t readlink(const char *path, char *target, size_t size) {
  char buffer[512];
  const char *source = rewrite(path, buffer, sizeof(buffer));
  if (real_readlink) return real_readlink(source, target, size);
  return syscall(SYS_readlinkat, AT_FDCWD, source, target, size);
}

EXPORT ssize_t readlinkat(int dirfd, const char *path, char *target, size_t size) {
  char buffer[512];
  const char *source = rewrite(path, buffer, sizeof(buffer));
  if (real_readlinkat) return real_readlinkat(dirfd, source, target, size);
  return syscall(SYS_readlinkat, dirfd, source, target, size);
}

EXPORT int inotify_add_watch(int fd, const char *path, uint32_t mask) {
  char buffer[512];
  const char *source = rewrite(path, buffer, sizeof(buffer));
  if (real_inotify_add_watch) return real_inotify_add_watch(fd, source, mask);
  return (int)syscall(SYS_inotify_add_watch, fd, source, mask);
}

/* ---- libudev for USB ---------------------------------------------------------------------- */

/* Opaque to callers. Objects made here are recognised by address in the registry below. */
struct udev;
struct udev_monitor;
struct udev_device;
struct udev_enumerate;
struct udev_list_entry;

enum kind { MONITOR = 1, DEVICE, ENUMERATE, ENTRY };

struct object {
  void *pointer;
  enum kind kind;
};

static pthread_mutex_t registry_lock = PTHREAD_MUTEX_INITIALIZER;
static struct object *registry;
static size_t registry_count, registry_size;

static void remember(void *pointer, enum kind kind) {
  pthread_mutex_lock(&registry_lock);
  if (registry_count == registry_size) {
    size_t size = registry_size ? registry_size * 2 : 32;
    struct object *grown = realloc(registry, size * sizeof(*grown));
    if (!grown) {
      pthread_mutex_unlock(&registry_lock);
      return;
    }
    registry = grown;
    registry_size = size;
  }
  registry[registry_count++] = (struct object){pointer, kind};
  pthread_mutex_unlock(&registry_lock);
}

static void forget(void *pointer) {
  pthread_mutex_lock(&registry_lock);
  for (size_t index = 0; index < registry_count; index++) {
    if (registry[index].pointer == pointer) {
      registry[index] = registry[--registry_count];
      break;
    }
  }
  pthread_mutex_unlock(&registry_lock);
}

static int known(const void *pointer, enum kind kind) {
  if (!pointer) return 0;
  int found = 0;
  pthread_mutex_lock(&registry_lock);
  for (size_t index = 0; index < registry_count && !found; index++) {
    found = registry[index].pointer == pointer && registry[index].kind == kind;
  }
  pthread_mutex_unlock(&registry_lock);
  return found;
}

/* A libudev loaded with RTLD_LOCAL (as libusb's dependency in a dlopen) is not visible to RTLD_NEXT. */
static void *udev_real(const char *name) {
  void *symbol = dlsym(RTLD_NEXT, name);
  if (symbol) return symbol;
  void *library = dlopen("libudev.so.1", RTLD_LAZY | RTLD_NOLOAD);
  if (library) {
    symbol = dlsym(library, name);
    dlclose(library);
  }
  if (!symbol) debug("missing %s", name);
  return symbol;
}

#define UDEV_REAL(type, name) \
  static __typeof__(type) real_##name; \
  if (!real_##name) real_##name = (type)udev_real(#name)

/* Emulates only where the kernel's uevents cannot reach this process, which is every Android app. */
static int emulating(void) {
  static int answer = -1;
  if (answer >= 0) return answer;
  const char *forced = secure_getenv("T3USB_EMULATE_UDEV");
  if (forced && *forced) {
    answer = strcmp(forced, "0") != 0;
  } else {
    int probe = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_KOBJECT_UEVENT);
    answer = probe < 0;
    if (probe >= 0) close(probe);
  }
  debug("udev emulation %s", answer ? "on" : "off");
  return answer;
}

/* -- list entries -- */

struct entry {
  char *name;
  char *value;
  struct entry *next;
};

static struct entry *entry_append(struct entry **head, const char *name, const char *value) {
  struct entry *entry = calloc(1, sizeof(*entry));
  if (!entry) return NULL;
  entry->name = strdup(name);
  entry->value = value ? strdup(value) : NULL;
  struct entry **tail = head;
  while (*tail) tail = &(*tail)->next;
  *tail = entry;
  remember(entry, ENTRY);
  return entry;
}

static void entries_free(struct entry *entry) {
  while (entry) {
    struct entry *next = entry->next;
    forget(entry);
    free(entry->name);
    free(entry->value);
    free(entry);
    entry = next;
  }
}

EXPORT struct udev_list_entry *udev_list_entry_get_next(struct udev_list_entry *entry) {
  if (known(entry, ENTRY)) return (struct udev_list_entry *)((struct entry *)entry)->next;
  UDEV_REAL(struct udev_list_entry * (*)(struct udev_list_entry *), udev_list_entry_get_next);
  return real_udev_list_entry_get_next ? real_udev_list_entry_get_next(entry) : NULL;
}

EXPORT const char *udev_list_entry_get_name(struct udev_list_entry *entry) {
  if (known(entry, ENTRY)) return ((struct entry *)entry)->name;
  UDEV_REAL(const char *(*)(struct udev_list_entry *), udev_list_entry_get_name);
  return real_udev_list_entry_get_name ? real_udev_list_entry_get_name(entry) : NULL;
}

EXPORT const char *udev_list_entry_get_value(struct udev_list_entry *entry) {
  if (known(entry, ENTRY)) return ((struct entry *)entry)->value;
  UDEV_REAL(const char *(*)(struct udev_list_entry *), udev_list_entry_get_value);
  return real_udev_list_entry_get_value ? real_udev_list_entry_get_value(entry) : NULL;
}

EXPORT struct udev_list_entry *udev_list_entry_get_by_name(struct udev_list_entry *entry, const char *name) {
  if (known(entry, ENTRY)) {
    for (struct entry *cursor = (struct entry *)entry; cursor; cursor = cursor->next) {
      if (strcmp(cursor->name, name) == 0) return (struct udev_list_entry *)cursor;
    }
    return NULL;
  }
  UDEV_REAL(struct udev_list_entry * (*)(struct udev_list_entry *, const char *), udev_list_entry_get_by_name);
  return real_udev_list_entry_get_by_name ? real_udev_list_entry_get_by_name(entry, name) : NULL;
}

/* -- devices -- */

struct device {
  int refs;
  struct udev *udev;
  int bus;
  int dev;
  char action[8];
  char sysname[32];
  char syspath[64];
  char devpath[48];
  char devnode[32];
  char number[16];
  struct entry *properties;
  struct entry *attributes;
};

/* Reads one attribute of a device in the fake tree, without its trailing newline. */
static int read_attribute(const char *sysname, const char *name, char *value, size_t size) {
  char path[512];
  snprintf(path, sizeof(path), "%s/sys/bus/usb/devices/%s/%s", t3usb_root(), sysname, name);
  int fd = (int)syscall(SYS_openat, AT_FDCWD, path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t count = read(fd, value, size - 1);
  close(fd);
  if (count < 0) return -1;
  value[count] = 0;
  value[strcspn(value, "\n")] = 0;
  return 0;
}

static int device_present(int bus, int dev) {
  char path[512];
  snprintf(path, sizeof(path), "%s/sys/bus/usb/devices/%d-%d/busnum", t3usb_root(), bus, dev);
  return syscall(SYS_faccessat, AT_FDCWD, path, F_OK) == 0;
}

static struct device *device_new(struct udev *udev, int bus, int dev, const char *action) {
  struct device *device = calloc(1, sizeof(*device));
  if (!device) return NULL;
  device->refs = 1;
  device->udev = udev;
  device->bus = bus;
  device->dev = dev;
  if (action) snprintf(device->action, sizeof(device->action), "%s", action);
  snprintf(device->sysname, sizeof(device->sysname), "%d-%d", bus, dev);
  snprintf(device->syspath, sizeof(device->syspath), "/sys/bus/usb/devices/%d-%d", bus, dev);
  snprintf(device->devpath, sizeof(device->devpath), "/bus/usb/devices/%d-%d", bus, dev);
  snprintf(device->devnode, sizeof(device->devnode), "/dev/bus/usb/%03d/%03d", bus, dev);
  snprintf(device->number, sizeof(device->number), "%d", dev);
  char text[64];
  entry_append(&device->properties, "SUBSYSTEM", "usb");
  entry_append(&device->properties, "DEVTYPE", "usb_device");
  entry_append(&device->properties, "DEVNAME", device->devnode);
  entry_append(&device->properties, "DEVPATH", device->devpath);
  snprintf(text, sizeof(text), "%03d", bus);
  entry_append(&device->properties, "BUSNUM", text);
  snprintf(text, sizeof(text), "%03d", dev);
  entry_append(&device->properties, "DEVNUM", text);
  snprintf(text, sizeof(text), "%u", (unsigned)(bus - 1) * 128 + (unsigned)dev - 1);
  entry_append(&device->properties, "MINOR", text);
  entry_append(&device->properties, "MAJOR", "189");
  if (action) entry_append(&device->properties, "ACTION", action);
  char vendor[16], product[16];
  if (read_attribute(device->sysname, "idVendor", vendor, sizeof(vendor)) == 0 &&
      read_attribute(device->sysname, "idProduct", product, sizeof(product)) == 0) {
    entry_append(&device->properties, "ID_VENDOR_ID", vendor);
    entry_append(&device->properties, "ID_MODEL_ID", product);
    snprintf(text, sizeof(text), "%x/%x", (unsigned)strtoul(vendor, NULL, 16), (unsigned)strtoul(product, NULL, 16));
    entry_append(&device->properties, "PRODUCT", text);
  }
  remember(device, DEVICE);
  return device;
}

static void device_free(struct device *device) {
  forget(device);
  entries_free(device->properties);
  entries_free(device->attributes);
  free(device);
}

/* Parses /sys/bus/usb/devices/B-D (or /sys/devices/.../B-D) from the fake tree. */
static int parse_syspath(const char *path, int *bus, int *dev) {
  const char *name = strrchr(path, '/');
  if (!name || !has_prefix(path, "/sys")) return 0;
  char tail;
  return sscanf(name + 1, "%d-%d%c", bus, dev, &tail) == 2 && device_present(*bus, *dev);
}

EXPORT struct udev_device *udev_device_new_from_syspath(struct udev *udev, const char *path) {
  int bus, dev;
  if (path && emulating() && parse_syspath(path, &bus, &dev)) return (struct udev_device *)device_new(udev, bus, dev, NULL);
  UDEV_REAL(struct udev_device * (*)(struct udev *, const char *), udev_device_new_from_syspath);
  return real_udev_device_new_from_syspath ? real_udev_device_new_from_syspath(udev, path) : NULL;
}

EXPORT struct udev_device *udev_device_new_from_subsystem_sysname(struct udev *udev, const char *subsystem,
                                                                  const char *sysname) {
  int bus, dev;
  char tail;
  if (emulating() && subsystem && sysname && strcmp(subsystem, "usb") == 0 &&
      sscanf(sysname, "%d-%d%c", &bus, &dev, &tail) == 2 && device_present(bus, dev)) {
    return (struct udev_device *)device_new(udev, bus, dev, NULL);
  }
  UDEV_REAL(struct udev_device * (*)(struct udev *, const char *, const char *), udev_device_new_from_subsystem_sysname);
  return real_udev_device_new_from_subsystem_sysname ? real_udev_device_new_from_subsystem_sysname(udev, subsystem, sysname)
                                                      : NULL;
}

EXPORT struct udev_device *udev_device_new_from_devnum(struct udev *udev, char type, dev_t number) {
  if (emulating() && type == 'c' && major(number) == 189) {
    int bus = (int)minor(number) / 128 + 1, dev = (int)minor(number) % 128 + 1;
    if (device_present(bus, dev)) return (struct udev_device *)device_new(udev, bus, dev, NULL);
  }
  UDEV_REAL(struct udev_device * (*)(struct udev *, char, dev_t), udev_device_new_from_devnum);
  return real_udev_device_new_from_devnum ? real_udev_device_new_from_devnum(udev, type, number) : NULL;
}

#define DEVICE_GETTER(result, name, fallback, ...) \
  EXPORT result udev_device_##name(struct udev_device *udev_device) { \
    if (known(udev_device, DEVICE)) { \
      struct device *device = (struct device *)udev_device; \
      (void)device; \
      __VA_ARGS__; \
    } \
    UDEV_REAL(result (*)(struct udev_device *), udev_device_##name); \
    return real_udev_device_##name ? real_udev_device_##name(udev_device) : fallback; \
  }

DEVICE_GETTER(struct udev_device *, ref, NULL, device->refs++; return udev_device)
DEVICE_GETTER(struct udev_device *, unref, NULL, if (--device->refs <= 0) device_free(device); return NULL)
DEVICE_GETTER(struct udev *, get_udev, NULL, return device->udev)
DEVICE_GETTER(const char *, get_syspath, NULL, return device->syspath)
DEVICE_GETTER(const char *, get_sysname, NULL, return device->sysname)
DEVICE_GETTER(const char *, get_sysnum, NULL, return device->number)
DEVICE_GETTER(const char *, get_devpath, NULL, return device->devpath)
DEVICE_GETTER(const char *, get_devnode, NULL, return device->devnode)
DEVICE_GETTER(dev_t, get_devnum, 0, return makedev(189, (unsigned)(device->bus - 1) * 128 + (unsigned)device->dev - 1))
DEVICE_GETTER(const char *, get_subsystem, NULL, return "usb")
DEVICE_GETTER(const char *, get_devtype, NULL, return "usb_device")
DEVICE_GETTER(const char *, get_driver, NULL, return "usb")
DEVICE_GETTER(const char *, get_action, NULL, return device->action[0] ? device->action : NULL)
DEVICE_GETTER(struct udev_device *, get_parent, NULL, return NULL)
DEVICE_GETTER(int, get_is_initialized, 0, return 1)
DEVICE_GETTER(unsigned long long int, get_seqnum, 0, return 0)
DEVICE_GETTER(unsigned long long int, get_usec_since_initialized, 0, return 0)
DEVICE_GETTER(struct udev_list_entry *, get_properties_list_entry, NULL,
              return (struct udev_list_entry *)device->properties)
DEVICE_GETTER(struct udev_list_entry *, get_devlinks_list_entry, NULL, return NULL)
DEVICE_GETTER(struct udev_list_entry *, get_tags_list_entry, NULL, return NULL)
DEVICE_GETTER(struct udev_list_entry *, get_current_tags_list_entry, NULL, return NULL)
DEVICE_GETTER(struct udev_list_entry *, get_sysattr_list_entry, NULL,
              return (struct udev_list_entry *)device->attributes)

EXPORT struct udev_device *udev_device_get_parent_with_subsystem_devtype(struct udev_device *udev_device,
                                                                          const char *subsystem,
                                                                          const char *devtype) {
  if (known(udev_device, DEVICE)) return NULL;
  UDEV_REAL(struct udev_device * (*)(struct udev_device *, const char *, const char *),
            udev_device_get_parent_with_subsystem_devtype);
  return real_udev_device_get_parent_with_subsystem_devtype
           ? real_udev_device_get_parent_with_subsystem_devtype(udev_device, subsystem, devtype)
           : NULL;
}

EXPORT const char *udev_device_get_property_value(struct udev_device *udev_device, const char *key) {
  if (known(udev_device, DEVICE)) {
    struct entry *entry = (struct entry *)udev_list_entry_get_by_name(
      (struct udev_list_entry *)((struct device *)udev_device)->properties, key);
    return entry ? entry->value : NULL;
  }
  UDEV_REAL(const char *(*)(struct udev_device *, const char *), udev_device_get_property_value);
  return real_udev_device_get_property_value ? real_udev_device_get_property_value(udev_device, key) : NULL;
}

EXPORT const char *udev_device_get_sysattr_value(struct udev_device *udev_device, const char *name) {
  if (known(udev_device, DEVICE)) {
    struct device *device = (struct device *)udev_device;
    struct entry *cached = (struct entry *)udev_list_entry_get_by_name((struct udev_list_entry *)device->attributes, name);
    if (cached) return cached->value;
    char value[256];
    if (strchr(name, '/') || read_attribute(device->sysname, name, value, sizeof(value)) != 0) return NULL;
    struct entry *entry = entry_append(&device->attributes, name, value);
    return entry ? entry->value : NULL;
  }
  UDEV_REAL(const char *(*)(struct udev_device *, const char *), udev_device_get_sysattr_value);
  return real_udev_device_get_sysattr_value ? real_udev_device_get_sysattr_value(udev_device, name) : NULL;
}

EXPORT int udev_device_has_tag(struct udev_device *udev_device, const char *tag) {
  if (known(udev_device, DEVICE)) return 0;
  UDEV_REAL(int (*)(struct udev_device *, const char *), udev_device_has_tag);
  return real_udev_device_has_tag ? real_udev_device_has_tag(udev_device, tag) : 0;
}

/* -- enumeration -- */

/* The real enumerate object is kept; this records that it asked for "usb" and holds our results. */
struct usb_scan {
  struct udev_enumerate *enumerate;
  int refs;
  int other_devtype;
  struct entry *results;
};

static pthread_mutex_t scans_lock = PTHREAD_MUTEX_INITIALIZER;
static struct usb_scan *scans[16];

static struct usb_scan *scan_of(struct udev_enumerate *enumerate) {
  struct usb_scan *found = NULL;
  pthread_mutex_lock(&scans_lock);
  for (int index = 0; index < 16 && !found; index++) {
    if (scans[index] && scans[index]->enumerate == enumerate) found = scans[index];
  }
  pthread_mutex_unlock(&scans_lock);
  return found;
}

EXPORT int udev_enumerate_add_match_subsystem(struct udev_enumerate *enumerate, const char *subsystem) {
  UDEV_REAL(int (*)(struct udev_enumerate *, const char *), udev_enumerate_add_match_subsystem);
  int result = real_udev_enumerate_add_match_subsystem ? real_udev_enumerate_add_match_subsystem(enumerate, subsystem) : -ENOSYS;
  if (result == 0 && subsystem && strcmp(subsystem, "usb") == 0 && emulating() && !scan_of(enumerate)) {
    struct usb_scan *scan = calloc(1, sizeof(*scan));
    if (!scan) return result;
    scan->enumerate = enumerate;
    scan->refs = 1;
    pthread_mutex_lock(&scans_lock);
    int stored = 0;
    for (int index = 0; index < 16 && !stored; index++) {
      if (!scans[index]) stored = (scans[index] = scan) != NULL;
    }
    pthread_mutex_unlock(&scans_lock);
    if (!stored) free(scan);
  }
  return result;
}

EXPORT int udev_enumerate_add_match_property(struct udev_enumerate *enumerate, const char *property,
                                             const char *value) {
  struct usb_scan *scan = scan_of(enumerate);
  if (scan && property && value && strcmp(property, "DEVTYPE") == 0 && strcmp(value, "usb_device") != 0) {
    scan->other_devtype = 1;
  }
  UDEV_REAL(int (*)(struct udev_enumerate *, const char *, const char *), udev_enumerate_add_match_property);
  return real_udev_enumerate_add_match_property ? real_udev_enumerate_add_match_property(enumerate, property, value)
                                                : -ENOSYS;
}

EXPORT int udev_enumerate_scan_devices(struct udev_enumerate *enumerate) {
  struct usb_scan *scan = scan_of(enumerate);
  if (!scan) {
    UDEV_REAL(int (*)(struct udev_enumerate *), udev_enumerate_scan_devices);
    return real_udev_enumerate_scan_devices ? real_udev_enumerate_scan_devices(enumerate) : -ENOSYS;
  }
  entries_free(scan->results);
  scan->results = NULL;
  if (scan->other_devtype) return 0;
  char path[512];
  snprintf(path, sizeof(path), "%s/sys/bus/usb/devices", t3usb_root());
  DIR *folder = real_opendir ? real_opendir(path) : NULL;
  if (!folder) return 0;
  struct dirent *item;
  while ((item = readdir(folder))) {
    int bus, dev;
    char tail;
    if (sscanf(item->d_name, "%d-%d%c", &bus, &dev, &tail) != 2 || !device_present(bus, dev)) continue;
    char syspath[64];
    snprintf(syspath, sizeof(syspath), "/sys/bus/usb/devices/%d-%d", bus, dev);
    entry_append(&scan->results, syspath, NULL);
  }
  closedir(folder);
  debug("udev usb enumeration from the app's devices");
  return 0;
}

EXPORT struct udev_list_entry *udev_enumerate_get_list_entry(struct udev_enumerate *enumerate) {
  struct usb_scan *scan = scan_of(enumerate);
  if (scan) return (struct udev_list_entry *)scan->results;
  UDEV_REAL(struct udev_list_entry * (*)(struct udev_enumerate *), udev_enumerate_get_list_entry);
  return real_udev_enumerate_get_list_entry ? real_udev_enumerate_get_list_entry(enumerate) : NULL;
}

EXPORT struct udev_enumerate *udev_enumerate_ref(struct udev_enumerate *enumerate) {
  struct usb_scan *scan = scan_of(enumerate);
  if (scan) scan->refs++;
  UDEV_REAL(struct udev_enumerate * (*)(struct udev_enumerate *), udev_enumerate_ref);
  return real_udev_enumerate_ref ? real_udev_enumerate_ref(enumerate) : enumerate;
}

EXPORT struct udev_enumerate *udev_enumerate_unref(struct udev_enumerate *enumerate) {
  struct usb_scan *scan = scan_of(enumerate);
  if (scan && --scan->refs <= 0) {
    pthread_mutex_lock(&scans_lock);
    for (int index = 0; index < 16; index++) {
      if (scans[index] == scan) scans[index] = NULL;
    }
    pthread_mutex_unlock(&scans_lock);
    entries_free(scan->results);
    free(scan);
  }
  UDEV_REAL(struct udev_enumerate * (*)(struct udev_enumerate *), udev_enumerate_unref);
  return real_udev_enumerate_unref ? real_udev_enumerate_unref(enumerate) : NULL;
}

/* -- monitor -- */

struct event {
  char action[8];
  int bus;
  int dev;
  struct event *next;
};

/*
 * A socket pair stands in for the netlink socket: one byte per queued event, so poll() reports the
 * monitor readable exactly while events wait. The watch thread owns the write end, and writes with
 * MSG_NOSIGNAL: the program may close the monitor while an event is on its way, and a pipe would
 * then kill it with SIGPIPE.
 */
struct monitor {
  int refs;
  struct udev *udev;
  int usb;
  int started;
  int closed;
  int pipe[2];
  int sock;
  pthread_mutex_t lock;
  struct event *head;
  struct event *tail;
};

static void monitor_push(struct monitor *monitor, const char *action, int bus, int dev) {
  struct event *event = calloc(1, sizeof(*event));
  if (!event) return;
  snprintf(event->action, sizeof(event->action), "%s", action);
  event->bus = bus;
  event->dev = dev;
  pthread_mutex_lock(&monitor->lock);
  if (monitor->tail) monitor->tail->next = event;
  else monitor->head = event;
  monitor->tail = event;
  pthread_mutex_unlock(&monitor->lock);
  char byte = 1;
  while (send(monitor->pipe[1], &byte, 1, MSG_NOSIGNAL) < 0 && errno == EINTR) continue;
}

static void monitor_destroy(struct monitor *monitor) {
  pthread_mutex_lock(&monitor->lock);
  while (monitor->head) {
    struct event *next = monitor->head->next;
    free(monitor->head);
    monitor->head = next;
  }
  pthread_mutex_unlock(&monitor->lock);
  if (monitor->pipe[1] >= 0) close(monitor->pipe[1]);
  pthread_mutex_destroy(&monitor->lock);
  free(monitor);
}

/* Follows the app's list of allowed devices, and reconnects while the app restarts. */
static void *monitor_thread(void *argument) {
  struct monitor *monitor = argument;
  int known_bus[64], known_dev[64], known_count = 0;
  while (!__atomic_load_n(&monitor->closed, __ATOMIC_ACQUIRE)) {
    int sock = t3usb_connect();
    if (sock >= 0 && t3usb_send(sock, "watch\n") == 0) {
      __atomic_store_n(&monitor->sock, sock, __ATOMIC_RELEASE);
      int fresh_bus[64], fresh_dev[64], fresh_count = 0, synced = 0;
      char line[T3USB_LINE_MAX];
      while (!__atomic_load_n(&monitor->closed, __ATOMIC_ACQUIRE) &&
             t3usb_read_line(sock, line, sizeof(line), NULL, 1) >= 0) {
        char *fields[3];
        int count = t3usb_fields(line, fields, 3);
        if (!synced && strcmp(fields[0], "ready") == 0) {
          synced = 1;
          for (int index = 0; index < known_count; index++) {
            int still = 0;
            for (int other = 0; other < fresh_count; other++) {
              still |= fresh_bus[other] == known_bus[index] && fresh_dev[other] == known_dev[index];
            }
            if (!still) monitor_push(monitor, "remove", known_bus[index], known_dev[index]);
          }
          memcpy(known_bus, fresh_bus, sizeof(known_bus));
          memcpy(known_dev, fresh_dev, sizeof(known_dev));
          known_count = fresh_count;
          continue;
        }
        if (count != 3) continue;
        int bus = atoi(fields[1]), dev = atoi(fields[2]);
        if (strcmp(fields[0], "add") == 0) {
          if (!synced && fresh_count < 64) {
            fresh_bus[fresh_count] = bus;
            fresh_dev[fresh_count++] = dev;
          }
          if (synced && known_count < 64) {
            known_bus[known_count] = bus;
            known_dev[known_count++] = dev;
          }
          monitor_push(monitor, "add", bus, dev);
        } else if (strcmp(fields[0], "remove") == 0) {
          for (int index = 0; index < known_count; index++) {
            if (known_bus[index] == bus && known_dev[index] == dev) {
              known_bus[index] = known_bus[--known_count];
              known_dev[index] = known_dev[known_count];
              break;
            }
          }
          monitor_push(monitor, "remove", bus, dev);
        }
      }
      __atomic_store_n(&monitor->sock, -1, __ATOMIC_RELEASE);
    }
    if (sock >= 0) close(sock);
    for (int tick = 0; tick < 20 && !__atomic_load_n(&monitor->closed, __ATOMIC_ACQUIRE); tick++) {
      struct timespec delay = {.tv_nsec = 100 * 1000 * 1000};
      nanosleep(&delay, NULL);
    }
  }
  monitor_destroy(monitor);
  return NULL;
}

EXPORT struct udev_monitor *udev_monitor_new_from_netlink(struct udev *udev, const char *name) {
  UDEV_REAL(struct udev_monitor * (*)(struct udev *, const char *), udev_monitor_new_from_netlink);
  if (!emulating()) return real_udev_monitor_new_from_netlink ? real_udev_monitor_new_from_netlink(udev, name) : NULL;
  struct monitor *monitor = calloc(1, sizeof(*monitor));
  if (!monitor) return NULL;
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0, monitor->pipe) != 0) {
    free(monitor);
    return NULL;
  }
  monitor->refs = 1;
  monitor->udev = udev;
  monitor->sock = -1;
  pthread_mutex_init(&monitor->lock, NULL);
  remember(monitor, MONITOR);
  debug("udev monitor emulated");
  return (struct udev_monitor *)monitor;
}

#define MONITOR_CALL(result, name, parameters, arguments, fallback, ...) \
  EXPORT result udev_monitor_##name parameters { \
    if (known(udev_monitor, MONITOR)) { \
      struct monitor *monitor = (struct monitor *)udev_monitor; \
      (void)monitor; \
      __VA_ARGS__; \
    } \
    UDEV_REAL(result(*) parameters, udev_monitor_##name); \
    return real_udev_monitor_##name ? real_udev_monitor_##name arguments : fallback; \
  }

MONITOR_CALL(struct udev_monitor *, ref, (struct udev_monitor * udev_monitor), (udev_monitor), NULL,
             monitor->refs++;
             return udev_monitor)
MONITOR_CALL(struct udev *, get_udev, (struct udev_monitor * udev_monitor), (udev_monitor), NULL, return monitor->udev)
MONITOR_CALL(int, get_fd, (struct udev_monitor * udev_monitor), (udev_monitor), -1, return monitor->pipe[0])
MONITOR_CALL(int, filter_update, (struct udev_monitor * udev_monitor), (udev_monitor), -ENOSYS, return 0)
MONITOR_CALL(int, filter_remove, (struct udev_monitor * udev_monitor), (udev_monitor), -ENOSYS, return 0)
MONITOR_CALL(int, filter_add_match_tag, (struct udev_monitor * udev_monitor, const char *tag), (udev_monitor, tag),
             -ENOSYS, return 0)
MONITOR_CALL(int, set_receive_buffer_size, (struct udev_monitor * udev_monitor, int size), (udev_monitor, size),
             -ENOSYS, return 0)
MONITOR_CALL(int, filter_add_match_subsystem_devtype,
             (struct udev_monitor * udev_monitor, const char *subsystem, const char *devtype),
             (udev_monitor, subsystem, devtype), -ENOSYS,
             if (subsystem && strcmp(subsystem, "usb") == 0 && (!devtype || strcmp(devtype, "usb_device") == 0))
               monitor->usb = 1;
             return 0)
MONITOR_CALL(int, enable_receiving, (struct udev_monitor * udev_monitor), (udev_monitor), -ENOSYS,
             if (monitor->usb && !monitor->started) {
               pthread_t thread;
               monitor->started = pthread_create(&thread, NULL, monitor_thread, monitor) == 0;
               if (monitor->started) pthread_detach(thread);
             } return 0)

EXPORT struct udev_monitor *udev_monitor_unref(struct udev_monitor *udev_monitor) {
  if (known(udev_monitor, MONITOR)) {
    struct monitor *monitor = (struct monitor *)udev_monitor;
    if (--monitor->refs > 0) return NULL;
    forget(monitor);
    close(monitor->pipe[0]);
    if (!monitor->started) {
      monitor_destroy(monitor);
      return NULL;
    }
    __atomic_store_n(&monitor->closed, 1, __ATOMIC_RELEASE);
    int sock = __atomic_load_n(&monitor->sock, __ATOMIC_ACQUIRE);
    if (sock >= 0) shutdown(sock, SHUT_RDWR);
    return NULL;
  }
  UDEV_REAL(struct udev_monitor * (*)(struct udev_monitor *), udev_monitor_unref);
  return real_udev_monitor_unref ? real_udev_monitor_unref(udev_monitor) : NULL;
}

EXPORT struct udev_device *udev_monitor_receive_device(struct udev_monitor *udev_monitor) {
  if (known(udev_monitor, MONITOR)) {
    struct monitor *monitor = (struct monitor *)udev_monitor;
    char byte;
    if (read(monitor->pipe[0], &byte, 1) != 1) return NULL;
    pthread_mutex_lock(&monitor->lock);
    struct event *event = monitor->head;
    if (event) {
      monitor->head = event->next;
      if (!monitor->head) monitor->tail = NULL;
    }
    pthread_mutex_unlock(&monitor->lock);
    if (!event) return NULL;
    struct device *device = device_new(monitor->udev, event->bus, event->dev, event->action);
    debug("udev event %s %d-%d", event->action, event->bus, event->dev);
    free(event);
    return (struct udev_device *)device;
  }
  UDEV_REAL(struct udev_device * (*)(struct udev_monitor *), udev_monitor_receive_device);
  return real_udev_monitor_receive_device ? real_udev_monitor_receive_device(udev_monitor) : NULL;
}
