package expo.modules.t3localserver

import android.util.Log
import org.json.JSONObject
import java.io.IOException
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Passes Claude Code's requests on to Ollama. Ollama sends nothing while it reads the prompt,
 * minutes on a phone's processor, and Claude Code gives up on a stream that stays silent for six
 * minutes whatever its timeouts say. This answers at once and sends pings until Ollama does.
 */
object OllamaRelay {
  private const val TAG = "T3OllamaRelay"
  const val PORT = 11436
  private const val PING_SECONDS = 15L
  private val PING = "event: ping\ndata: {\"type\": \"ping\"}\n\n".toByteArray()
  private val FORWARDED = listOf("content-type", "accept", "authorization", "x-api-key", "anthropic-version", "anthropic-beta")

  @Volatile
  private var socket: ServerSocket? = null

  @Synchronized
  fun start() {
    if (socket != null) return
    val server = try {
      ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"))
    } catch (error: IOException) {
      Log.w(TAG, "Could not listen on $PORT", error)
      return
    }
    socket = server
    thread(name = "t3-ollama-relay") {
      while (!server.isClosed) {
        val client = runCatching { server.accept() }.getOrNull() ?: break
        thread(name = "t3-ollama-relay-request") {
          client.use { runCatching { handle(it) }.onFailure { error -> Log.w(TAG, "Request failed", error) } }
        }
      }
    }
  }

  @Synchronized
  fun stop() {
    runCatching { socket?.close() }
    socket = null
  }

  private fun handle(client: Socket) {
    val input = client.getInputStream()
    val output = client.getOutputStream()
    val requestLine = PhoneModelEndpoint.readLine(input) ?: return
    val headers = generateSequence { PhoneModelEndpoint.readLine(input)?.takeIf { it.isNotEmpty() } }
      .mapNotNull { line -> line.indexOf(':').takeIf { it > 0 }?.let { line.substring(0, it).trim().lowercase() to line.substring(it + 1).trim() } }
      .toMap()
    val (method, target) = requestLine.split(" ").let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "/") }
    val body = PhoneModelEndpoint.readBody(input, headers).toByteArray()
    val streams = method == "POST" && runCatching { JSONObject(String(body)).optBoolean("stream") }.getOrDefault(false)

    val upstream = (URL(Ollama.BASE_URL + target).openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = 5_000
      readTimeout = 0
      // Compressed events would arrive in bursts.
      setRequestProperty("Accept-Encoding", "identity")
      FORWARDED.forEach { name -> headers[name]?.let { setRequestProperty(name, it) } }
    }
    try {
      if (streams) stream(upstream, body, output) else plain(upstream, body, output)
    } finally {
      upstream.disconnect()
    }
  }

  private fun send(upstream: HttpURLConnection, body: ByteArray) {
    if (body.isEmpty()) return
    upstream.doOutput = true
    upstream.setFixedLengthStreamingMode(body.size)
    upstream.outputStream.use { it.write(body) }
  }

  private fun plain(upstream: HttpURLConnection, body: ByteArray, output: OutputStream) {
    val (status, bytes) = try {
      send(upstream, body)
      val code = upstream.responseCode
      code to ((if (code < 400) upstream.inputStream else upstream.errorStream)?.use { it.readBytes() } ?: ByteArray(0))
    } catch (error: IOException) {
      502 to failure(error.message ?: "Ollama did not answer").toByteArray()
    }
    val type = runCatching { upstream.contentType }.getOrNull() ?: "application/json"
    output.write(
      ("HTTP/1.1 $status ${if (status < 400) "OK" else "Error"}\r\nContent-Type: $type\r\n" +
        "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(),
    )
    output.write(bytes)
    output.flush()
  }

  private fun stream(upstream: HttpURLConnection, body: ByteArray, output: OutputStream) {
    output.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".toByteArray())
    output.flush()
    val answered = CountDownLatch(1)
    val started = System.nanoTime()
    val seconds = { (System.nanoTime() - started) / 1_000_000_000 }
    val pinger = thread(name = "t3-ollama-relay-ping") {
      while (!answered.await(PING_SECONDS, TimeUnit.SECONDS)) {
        try {
          output.write(PING)
          output.flush()
        } catch (error: IOException) {
          // Claude Code went away; closing the request stops Ollama reading the prompt for nobody.
          Log.i(TAG, "Claude Code closed the request after ${seconds()} s, before Ollama answered")
          upstream.disconnect()
          return@thread
        }
      }
    }
    try {
      send(upstream, body)
      // Returns once Ollama starts answering, which is after it has read the whole prompt.
      val status = upstream.responseCode
      answered.countDown()
      pinger.join()
      Log.i(TAG, "Ollama answered HTTP $status after ${seconds()} s")
      if (status >= 400) {
        val text = upstream.errorStream?.use { it.readBytes() }?.let { String(it) }.orEmpty()
        val event = runCatching { JSONObject(text).takeIf { it.has("error") }?.toString() }.getOrNull() ?: failure(text.ifBlank { "Ollama answered HTTP $status" })
        output.write("event: error\ndata: $event\n\n".toByteArray())
        output.flush()
        return
      }
      upstream.inputStream.use { events ->
        val buffer = ByteArray(8192)
        while (true) {
          val count = events.read(buffer)
          if (count < 0) break
          output.write(buffer, 0, count)
          output.flush()
        }
      }
    } catch (error: IOException) {
      answered.countDown()
      pinger.join()
      Log.w(TAG, "The request ended after ${seconds()} s", error)
      runCatching {
        output.write("event: error\ndata: ${failure(error.message ?: "Ollama stopped answering")}\n\n".toByteArray())
        output.flush()
      }
    } finally {
      answered.countDown()
    }
  }

  private fun failure(message: String) =
    JSONObject().put("type", "error").put("error", JSONObject().put("type", "api_error").put("message", message)).toString()
}
