package expo.modules.t3localserver

import android.app.ActivityManager
import android.content.Context
import java.io.File

/**
 * Settings for the phone's Ollama and GPU models. Zero means automatic: a value worked out from
 * this phone's cores and memory, or for the GPU, the size that loaded here before.
 */
class LocalModelSettings(private val context: Context) {
  private val preferences = context.getSharedPreferences("t3_local_models", Context.MODE_PRIVATE)

  var ollamaContext: Int
    get() = preferences.getInt("ollamaContext", 0)
    set(value) = preferences.edit().putInt("ollamaContext", value.coerceIn(0, MAX_CONTEXT)).apply()

  var ollamaThreads: Int
    get() = preferences.getInt("ollamaThreads", 0)
    set(value) = preferences.edit().putInt("ollamaThreads", value.coerceIn(0, Runtime.getRuntime().availableProcessors())).apply()

  var ollamaKeepAliveMinutes: Int
    get() = preferences.getInt("ollamaKeepAliveMinutes", DEFAULT_KEEP_ALIVE_MINUTES)
    set(value) = preferences.edit().putInt("ollamaKeepAliveMinutes", value.coerceIn(1, 240)).apply()

  var gpuContext: Int
    get() = preferences.getInt("gpuContext", 0)
    set(value) = preferences.edit().putInt("gpuContext", value.coerceIn(0, MAX_CONTEXT)).apply()

  fun effectiveOllamaContext() = ollamaContext.takeIf { it > 0 } ?: autoOllamaContext(context)

  fun effectiveOllamaThreads() = ollamaThreads.takeIf { it > 0 } ?: fastCores()

  fun toMap() = mapOf(
    "ollamaContext" to ollamaContext,
    "ollamaThreads" to ollamaThreads,
    "ollamaKeepAliveMinutes" to ollamaKeepAliveMinutes,
    "gpuContext" to gpuContext,
    "autoOllamaContext" to autoOllamaContext(context),
    "autoOllamaThreads" to fastCores(),
    "cores" to Runtime.getRuntime().availableProcessors(),
    "autoGpuContext" to PhoneModels.workingContext(context),
  )

  companion object {
    private const val MAX_CONTEXT = 131072
    private const val DEFAULT_KEEP_ALIVE_MINUTES = 30
    private const val GB = 1L shl 30

    /**
     * Claude Code's instructions alone are about 20K tokens. Ollama keeps the whole context in
     * memory, so phones with less of it get a smaller one rather than swapping.
     */
    fun autoOllamaContext(context: Context): Int {
      val info = ActivityManager.MemoryInfo()
      (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
      return when {
        info.totalMem >= 11 * GB -> 32768
        info.totalMem >= 7 * GB -> 24576
        else -> 16384
      }
    }

    /**
     * Cores faster than the slowest cluster. Threads on the slow cores hold the fast ones back:
     * on a Snapdragon 865 all 8 cores ran 140 times slower than its 4 fast ones.
     */
    fun fastCores(): Int {
      val cores = Runtime.getRuntime().availableProcessors()
      val speeds = (0 until cores).mapNotNull { core ->
        runCatching { File("/sys/devices/system/cpu/cpu$core/cpufreq/cpuinfo_max_freq").readText().trim().toLong() }.getOrNull()
      }
      if (speeds.size != cores) return (cores / 2).coerceIn(1, 4)
      val slowest = speeds.min()
      val fast = speeds.count { it > slowest }
      return if (fast == 0) (cores / 2).coerceAtLeast(1) else fast
    }
  }
}
