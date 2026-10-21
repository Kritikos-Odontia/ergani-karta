// SPDX-License-Identifier: EUPL-1.2
// THE MAC APP'S OWN PROGRAM — «Κάρτα Εργασίας.app/Contents/MacOS/karta». It runs the launcher's «open» on the Node.js
// in the app's Resources: the launcher writes the LaunchAgent that keeps the program running, and opens the owner's
// page. First it clears the «downloaded from the internet» mark from the app — the owner has just allowed it to open
// (System Settings → Privacy & Security → Open Anyway), and the Node.js inside would otherwise be asked about again.
// Run from the Downloads folder (macOS then runs it from a hidden copy), it says to move it to Applications instead.
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int run(char *const argv[]) {
  pid_t pid;
  int status = 0;
  if (posix_spawn(&pid, argv[0], NULL, NULL, argv, environ) != 0) return -1;
  waitpid(pid, &status, 0);
  return status;
}

int main(void) {
  char exe[PATH_MAX], self[PATH_MAX], app[PATH_MAX], node[PATH_MAX], launcher[PATH_MAX];
  uint32_t size = sizeof exe;
  if (_NSGetExecutablePath(exe, &size) != 0 || realpath(exe, self) == NULL) return 1;
  // …/Κάρτα Εργασίας.app/Contents/MacOS/karta → …/Κάρτα Εργασίας.app
  snprintf(app, sizeof app, "%s", self);
  for (int up = 0; up < 3; up += 1) {
    char *slash = strrchr(app, '/');
    if (slash == NULL) return 1;
    *slash = '\0';
  }
  if (strstr(app, "/AppTranslocation/") != NULL) {
    char *dialog[] = {"/usr/bin/osascript", "-e",
                      "display dialog \"Μεταφέρετε την «Κάρτα Εργασίας» στον φάκελο Εφαρμογές (Applications) και ανοίξτε την από εκεί.\" "
                      "buttons {\"OK\"} default button 1 with title \"Κάρτα Εργασίας\"",
                      NULL};
    run(dialog);
    return 0;
  }
  char *unmark[] = {"/usr/bin/xattr", "-dr", "com.apple.quarantine", app, NULL};
  run(unmark);
  snprintf(node, sizeof node, "%s/Contents/Resources/node", app);
  snprintf(launcher, sizeof launcher, "%s/Contents/Resources/launcher.mjs", app);
  execl(node, node, launcher, "open", (char *)NULL);
  return 1;
}
