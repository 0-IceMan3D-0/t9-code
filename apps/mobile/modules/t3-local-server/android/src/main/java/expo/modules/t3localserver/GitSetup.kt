package expo.modules.t3localserver

import android.os.Build
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Git identity and a GitHub SSH key for root in the Linux environment. The server and its agents
 * run as the same root with HOME=/root, so they use this key and ~/.gitconfig too.
 *
 * The private key is never read: only its presence is checked, and ssh-keygen's output is dropped.
 */
class GitSetup(private val guest: GuestRuntime) {
  class Result(val exitCode: Int, val output: String)

  private val sshDir get() = File(guest.rootfs, "root/.ssh")
  private val privateKey get() = File(sshDir, KEY_NAME)
  private val publicKey get() = File(sshDir, "$KEY_NAME.pub")

  private fun installed(path: String) = File(guest.rootfs, path.removePrefix("/")).let { it.isFile || it.exists() }

  /** Runs a command in Linux with no shell, so arguments are passed as they are. */
  fun run(command: List<String>, timeoutSeconds: Long = 30, onLine: ((String) -> Unit)? = null): Result {
    val process = guest.process(command).redirectInput(ProcessBuilder.Redirect.from(File("/dev/null"))).start()
    val output = StringBuilder()
    val reader = thread(name = "t3-git-output") {
      process.inputStream.bufferedReader().forEachLine { line ->
        synchronized(output) { if (output.length < MAX_OUTPUT) output.appendLine(line) }
        onLine?.invoke(line)
      }
    }
    if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
      ProcessTree.killProcess(process)
      process.waitFor(5, TimeUnit.SECONDS)
      reader.join(1_000)
      return Result(TIMED_OUT, synchronized(output) { output.toString() } + "Timed out after $timeoutSeconds s")
    }
    reader.join(5_000)
    return Result(process.exitValue(), synchronized(output) { output.toString() }.trim())
  }

  fun status(): JSONObject {
    val git = installed("/usr/bin/git")
    val identity = if (git) {
      run(listOf("git", "config", "--global", "--get-regexp", """^user\.(name|email)$""")).output.lines()
        .mapNotNull { line -> line.split(' ', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }
        .toMap()
    } else {
      emptyMap()
    }
    return JSONObject()
      .put("git", git)
      .put("ssh", installed("/usr/bin/ssh") && installed("/usr/bin/ssh-keygen"))
      .put("name", identity["user.name"] ?: JSONObject.NULL)
      .put("email", identity["user.email"] ?: JSONObject.NULL)
      .put("keyExists", privateKey.exists() || publicKey.exists())
      .put("publicKey", publicKey.readTextOrNull() ?: JSONObject.NULL)
      .put("keyPath", "/root/.ssh/$KEY_NAME")
  }

  fun setIdentity(name: String, email: String) {
    for ((key, value) in listOf("user.name" to name, "user.email" to email)) {
      val result = if (value.isBlank()) {
        run(listOf("git", "config", "--global", "--unset-all", key))
      } else {
        run(listOf("git", "config", "--global", key, value.trim()))
      }
      // 5 means there was nothing to unset.
      if (result.exitCode != 0 && !(value.isBlank() && result.exitCode == 5)) {
        throw IllegalStateException(result.output.ifBlank { "git config failed (${result.exitCode})" })
      }
    }
  }

  /** Installs git and the OpenSSH client with apt, reporting apt's own progress. */
  fun installTools(onProgress: (stage: String, percent: Double, detail: String) -> Unit): Result {
    onProgress("update", 0.0, "Updating package lists")
    val update = run(listOf("apt-get", "-q", "update"), timeoutSeconds = 600)
    if (update.exitCode != 0) return update
    onProgress("install", 0.0, "Installing git and openssh-client")
    return run(
      listOf(
        "env",
        "DEBIAN_FRONTEND=noninteractive",
        "apt-get",
        "-q",
        "-y",
        "-o",
        "APT::Status-Fd=1",
        "install",
        "git",
        "openssh-client",
      ),
      timeoutSeconds = 900,
    ) { line ->
      // dlstatus:<pkg>:<percent>:<text> or pmstatus:<pkg>:<percent>:<text>
      val parts = line.split(':', limit = 4)
      if (parts.size == 4 && (parts[0] == "dlstatus" || parts[0] == "pmstatus")) {
        val percent = parts[2].toDoubleOrNull() ?: return@run
        // Downloading is the first half, unpacking and setting up the second.
        val overall = if (parts[0] == "dlstatus") percent / 2 else 50 + percent / 2
        onProgress("install", overall, parts[3])
      }
    }
  }

  /**
   * Creates an ed25519 key with no passphrase, so agents can use it unattended. An existing key is
   * replaced only when [overwrite] is set, after the person confirmed it.
   */
  fun createKey(overwrite: Boolean) {
    if (privateKey.exists() || publicKey.exists()) {
      if (!overwrite) throw KeyExists()
      deleteKey()
    }
    sshDir.mkdirs()
    run(listOf("chmod", "700", "/root/.ssh"))
    val comment = "T3² Code on ${deviceName()}"
    val result = run(listOf("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", "/root/.ssh/$KEY_NAME"))
    if (result.exitCode != 0 || !publicKey.isFile) {
      throw IllegalStateException("ssh-keygen failed (${result.exitCode})")
    }
    trustGitHub()
  }

  fun deleteKey() {
    privateKey.delete()
    publicKey.delete()
  }

  /**
   * Adds GitHub's host keys so the first connection cannot be intercepted. They match
   * https://api.github.com/meta and the fingerprints GitHub documents (checked 2026-11-08).
   */
  fun trustGitHub() {
    val knownHosts = File(sshDir, "known_hosts")
    val existing = knownHosts.readTextOrNull().orEmpty()
    val missing = GITHUB_HOST_KEYS.filter { key -> existing.lines().none { it.trim() == key } }
    if (missing.isEmpty()) return
    sshDir.mkdirs()
    val prefix = if (existing.isEmpty() || existing.endsWith("\n")) "" else "\n"
    knownHosts.appendText(prefix + missing.joinToString("\n", postfix = "\n"))
  }

  fun testGitHub(): Result {
    trustGitHub()
    return run(
      listOf(
        "ssh",
        "-T",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "git@github.com",
      ),
      timeoutSeconds = 40,
    )
  }

  class KeyExists : Exception("An SSH key already exists")

  companion object {
    const val KEY_NAME = "id_ed25519"
    private const val MAX_OUTPUT = 64_000
    private const val TIMED_OUT = 124

    private fun deviceName(): String {
      val maker = Build.MANUFACTURER.orEmpty().replaceFirstChar { it.uppercase() }
      val model = Build.MODEL.orEmpty()
      return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model".trim()
    }

    private val GITHUB_HOST_KEYS = listOf(
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
    )
  }
}
