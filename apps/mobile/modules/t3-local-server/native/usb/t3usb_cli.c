/* t3-usb: lists USB devices the T3 app can see, asks Android for access, and checks the bridge. */
#define _GNU_SOURCE
#include <stdint.h>
#include <sys/stat.h>

#include "t3usb.h"

static int usage(void) {
  fprintf(stderr,
          "Usage: t3-usb [list]           USB devices attached to the phone\n"
          "       t3-usb allow [BUS/DEV]  ask Android for access (all devices if none named)\n"
          "       t3-usb probe BUS/DEV    open a device and read its descriptor\n"
          "       t3-usb selftest         check the connection to the app and the adb setup\n");
  return 2;
}

static int connect_or_explain(void) {
  int sock = t3usb_connect();
  if (sock < 0) {
    fprintf(stderr, "t3-usb: cannot reach the T3 app (%s). Keep the app open and try again.\n", strerror(errno));
  }
  return sock;
}

static int request(const char *line) {
  int sock = connect_or_explain();
  if (sock < 0) return -1;
  if (t3usb_send(sock, line) != 0) {
    perror("t3-usb");
    close(sock);
    return -1;
  }
  return sock;
}

static int list(void) {
  int sock = request("list\n");
  if (sock < 0) return 1;
  char line[T3USB_LINE_MAX];
  int count = 0;
  while (t3usb_read_line(sock, line, sizeof(line), NULL, 1) >= 0 && strcmp(line, "end") != 0) {
    char *fields[9];
    if (t3usb_fields(line, fields, 9) < 9 || strcmp(fields[0], "device") != 0) continue;
    if (count++ == 0) printf("%-8s %-10s %-11s %s\n", "BUS/DEV", "ID", "ACCESS", "NAME");
    char id[16];
    snprintf(id, sizeof(id), "%04x:%04x", atoi(fields[3]), atoi(fields[4]));
    printf("%03d/%03d  %-10s %-11s %s%s%s", atoi(fields[1]), atoi(fields[2]), id,
           strcmp(fields[5], "1") == 0 ? "allowed" : "not allowed", fields[6], *fields[6] ? " " : "", fields[7]);
    if (*fields[8]) printf(" (serial %s)", fields[8]);
    printf("\n");
  }
  close(sock);
  if (count == 0) printf("No USB devices attached. Connect one with a USB OTG adapter or cable.\n");
  else printf("\nAllow a device with: t3-usb allow, or in Settings > This phone > USB devices.\n");
  return 0;
}

static int parse_device(const char *text, int *bus, int *dev) {
  char tail;
  return sscanf(text, "%d/%d%c", bus, dev, &tail) == 2 || sscanf(text, "%d:%d%c", bus, dev, &tail) == 2;
}

static int allow(int argc, char **argv) {
  char line[T3USB_LINE_MAX];
  int bus, dev;
  if (argc < 3 || strcmp(argv[2], "all") == 0) snprintf(line, sizeof(line), "allow\tall\n");
  else if (parse_device(argv[2], &bus, &dev)) snprintf(line, sizeof(line), "allow\t%d\t%d\n", bus, dev);
  else return usage();
  int sock = request(line);
  if (sock < 0) return 1;
  int failed = 0, count = 0;
  while (t3usb_read_line(sock, line, sizeof(line), NULL, 1) >= 0 && strcmp(line, "end") != 0) {
    char *fields[4];
    int fieldCount = t3usb_fields(line, fields, 4);
    if (fieldCount == 3 && strcmp(fields[0], "asking") == 0) {
      printf("%03d/%03d: answer the prompt on the phone...\n", atoi(fields[1]), atoi(fields[2]));
      fflush(stdout);
    } else if (fieldCount >= 3) {
      count++;
      printf("%03d/%03d %s%s%s\n", atoi(fields[1]), atoi(fields[2]), fields[0], fieldCount > 3 ? ": " : "",
             fieldCount > 3 ? fields[3] : "");
      if (strcmp(fields[0], "granted") != 0) failed = 1;
    } else if (fieldCount == 2 && strcmp(fields[0], "error") == 0) {
      printf("%s\n", fields[1]);
      failed = 1;
    }
  }
  close(sock);
  if (count == 0 && !failed) printf("Nothing to allow: every attached device is already allowed, or none is attached.\n");
  return failed;
}

static int probe(const char *text) {
  int bus, dev;
  if (!parse_device(text, &bus, &dev)) return usage();
  char error[256];
  int fd = t3usb_open_device(bus, dev, 1, error, sizeof(error));
  if (fd < 0) {
    fprintf(stderr, "t3-usb: %03d/%03d: %s\n", bus, dev, error);
    return 1;
  }
  uint8_t descriptor[18];
  lseek(fd, 0, SEEK_SET);
  ssize_t count = read(fd, descriptor, sizeof(descriptor));
  close(fd);
  if (count < 18 || descriptor[1] != 1) {
    fprintf(stderr, "t3-usb: %03d/%03d: opened, but no device descriptor (read %zd bytes)\n", bus, dev, count);
    return 1;
  }
  printf("%03d/%03d opened: USB %x.%02x, id %02x%02x:%02x%02x, class %d, %d configuration(s)\n", bus, dev,
         descriptor[3], descriptor[2], descriptor[9], descriptor[8], descriptor[11], descriptor[10], descriptor[4],
         descriptor[17]);
  return 0;
}

static int file_exists(const char *path) {
  struct stat info;
  return stat(path, &info) == 0;
}

static int selftest(void) {
  int failed = 0;
  int sock = request("selftest\n");
  if (sock < 0) return 1;
  char line[T3USB_LINE_MAX];
  int fd = -1;
  if (t3usb_read_line(sock, line, sizeof(line), &fd, 1) < 0 || strcmp(line, "ok") != 0 || fd < 0) {
    printf("FAIL  the app did not pass a file descriptor (%s)\n", line);
    failed = 1;
  } else {
    char text[64] = {0};
    ssize_t count = read(fd, text, sizeof(text) - 1);
    text[count > 0 ? count : 0] = 0;
    text[strcspn(text, "\n")] = 0;
    printf("%s  app connection and fd passing: %s\n", count > 0 ? "ok  " : "FAIL", count > 0 ? text : "empty pipe");
    failed |= count <= 0;
  }
  if (fd >= 0) close(fd);
  close(sock);

  const char *preload = "/usr/local/lib/t3/libt3usb.so";
  printf("%s  %s\n", file_exists(preload) ? "ok  " : "FAIL", preload);
  failed |= !file_exists(preload);
  const char *tools[] = {"adb", "fastboot"};
  for (int index = 0; index < 2; index++) {
    char wrapper[64], target[64];
    snprintf(wrapper, sizeof(wrapper), "/usr/local/bin/%s", tools[index]);
    snprintf(target, sizeof(target), "/usr/bin/%s", tools[index]);
    if (!file_exists(target)) printf("note  %s is not installed (apt install %s)\n", tools[index], tools[index]);
    else if (!file_exists(wrapper)) {
      printf("FAIL  %s is missing, so %s cannot see USB devices\n", wrapper, tools[index]);
      failed = 1;
    }
    else printf("ok    %s runs %s with USB access\n", wrapper, target);
  }
  return failed;
}

int main(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "list") == 0) return list();
  if (strcmp(argv[1], "allow") == 0) return allow(argc, argv);
  if (strcmp(argv[1], "probe") == 0 && argc == 3) return probe(argv[2]);
  if (strcmp(argv[1], "selftest") == 0) return selftest();
  return usage();
}
