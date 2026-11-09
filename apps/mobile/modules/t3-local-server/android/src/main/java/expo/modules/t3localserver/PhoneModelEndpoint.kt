package expo.modules.t3localserver

import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.OpenApiTool
import com.google.ai.edge.litertlm.ToolCall
import com.google.ai.edge.litertlm.tool
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread

/**
 * Anthropic's Messages API on 127.0.0.1, answered by [PhoneModels], so Claude Code in Linux can
 * use the phone's GPU the same way it uses Ollama.
 */
object PhoneModelEndpoint {
  private const val TAG = "T3PhoneEndpoint"
  const val PORT = 11435
  private const val CHARS_PER_TOKEN = 4

  @Volatile
  private var socket: ServerSocket? = null

  @Synchronized
  fun start(context: Context) {
    if (socket != null) return
    val server = try {
      ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"))
    } catch (error: IOException) {
      Log.w(TAG, "Could not listen on $PORT", error)
      return
    }
    socket = server
    PhoneModels.update { it.copy(running = true) }
    val appContext = context.applicationContext
    thread(name = "t3-phone-endpoint") {
      while (!server.isClosed) {
        val client = runCatching { server.accept() }.getOrNull() ?: break
        thread(name = "t3-phone-request") { client.use { handle(appContext, it) } }
      }
    }
  }

  @Synchronized
  fun stop() {
    runCatching { socket?.close() }
    socket = null
    PhoneModels.update { it.copy(running = false) }
    thread(name = "t3-phone-unload") { PhoneModels.unload() }
  }

  // ---- HTTP ----------------------------------------------------------------------------------

  private fun handle(context: Context, client: Socket) {
    val input = client.getInputStream()
    val output = client.getOutputStream()
    val requestLine = readLine(input) ?: return
    val headers = generateSequence { readLine(input)?.takeIf { it.isNotEmpty() } }
      .mapNotNull { line -> line.indexOf(':').takeIf { it > 0 }?.let { line.substring(0, it).trim().lowercase() to line.substring(it + 1).trim() } }
      .toMap()
    val (method, target) = requestLine.split(" ").let { (it.getOrNull(0) ?: "") to (it.getOrNull(1) ?: "") }
    val path = target.substringBefore('?')
    val body = readBody(input, headers)
    try {
      when {
        method == "POST" && path == "/v1/messages" -> messages(context, JSONObject(body), output)
        method == "POST" && path == "/v1/messages/count_tokens" ->
          json(output, 200, JSONObject().put("input_tokens", estimateTokens(JSONObject(body))))
        method == "GET" -> json(output, 200, JSONObject().put("models", JSONArray(PhoneModels.state.installed)))
        else -> json(output, 404, error("not_found_error", "No route for $method $path"))
      }
    } catch (error: Exception) {
      Log.w(TAG, "Request failed", error)
      runCatching { json(output, 500, error("api_error", error.message ?: error.toString())) }
    }
  }

  private fun readLine(input: InputStream): String? {
    val bytes = ByteArrayOutputStream()
    while (true) {
      val b = input.read()
      if (b < 0) return if (bytes.size() == 0) null else bytes.toString(Charsets.UTF_8.name())
      if (b == '\n'.code) return bytes.toString(Charsets.UTF_8.name()).trimEnd('\r')
      bytes.write(b)
    }
  }

  private fun readBody(input: InputStream, headers: Map<String, String>): String {
    if (headers["transfer-encoding"]?.contains("chunked") == true) {
      val body = ByteArrayOutputStream()
      while (true) {
        val size = readLine(input)?.substringBefore(';')?.trim()?.toIntOrNull(16) ?: break
        if (size == 0) break
        body.write(readExactly(input, size))
        readLine(input)
      }
      return body.toString(Charsets.UTF_8.name())
    }
    val length = headers["content-length"]?.toIntOrNull() ?: 0
    return String(readExactly(input, length), Charsets.UTF_8)
  }

  private fun readExactly(input: InputStream, length: Int): ByteArray {
    val bytes = ByteArray(length)
    var read = 0
    while (read < length) {
      val count = input.read(bytes, read, length - read)
      if (count < 0) throw IOException("Request body ended early")
      read += count
    }
    return bytes
  }

  private fun json(output: OutputStream, status: Int, body: JSONObject) {
    val bytes = body.toString().toByteArray()
    output.write(
      ("HTTP/1.1 $status ${if (status < 400) "OK" else "Error"}\r\nContent-Type: application/json\r\n" +
        "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray(),
    )
    output.write(bytes)
    output.flush()
  }

  private fun error(type: String, message: String) =
    JSONObject().put("type", "error").put("error", JSONObject().put("type", type).put("message", message))

  // ---- Messages API --------------------------------------------------------------------------

  private class Reply(val output: OutputStream, val stream: Boolean, val model: String) {
    val id = "msg_" + UUID.randomUUID().toString().replace("-", "")
    val blocks = JSONArray()
    private var textIndex = -1
    private val text = StringBuilder()

    fun event(type: String, data: JSONObject) {
      if (!stream) return
      output.write("event: $type\ndata: ${data.put("type", type)}\n\n".toByteArray())
      output.flush()
    }

    fun start(inputTokens: Int) {
      if (!stream) return
      output.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".toByteArray())
      event("message_start", JSONObject().put("message", message(inputTokens, 0)))
    }

    fun message(inputTokens: Int, outputTokens: Int) = JSONObject()
      .put("id", id).put("type", "message").put("role", "assistant").put("model", model)
      .put("content", if (stream) JSONArray() else blocks)
      .put("stop_reason", JSONObject.NULL).put("stop_sequence", JSONObject.NULL)
      .put("usage", JSONObject().put("input_tokens", inputTokens).put("output_tokens", outputTokens))

    fun text(delta: String) {
      if (delta.isEmpty()) return
      if (textIndex < 0) {
        textIndex = blocks.length()
        blocks.put(JSONObject().put("type", "text").put("text", ""))
        event("content_block_start", JSONObject().put("index", textIndex).put("content_block", JSONObject().put("type", "text").put("text", "")))
      }
      text.append(delta)
      blocks.getJSONObject(textIndex).put("text", text.toString())
      event("content_block_delta", JSONObject().put("index", textIndex).put("delta", JSONObject().put("type", "text_delta").put("text", delta)))
    }

    fun toolUse(name: String, input: JSONObject) {
      closeText()
      val index = blocks.length()
      val id = "toolu_" + UUID.randomUUID().toString().replace("-", "").take(24)
      blocks.put(JSONObject().put("type", "tool_use").put("id", id).put("name", name).put("input", input))
      event("content_block_start", JSONObject().put("index", index).put("content_block", JSONObject().put("type", "tool_use").put("id", id).put("name", name).put("input", JSONObject())))
      event("content_block_delta", JSONObject().put("index", index).put("delta", JSONObject().put("type", "input_json_delta").put("partial_json", input.toString())))
      event("content_block_stop", JSONObject().put("index", index))
    }

    private fun closeText() {
      if (textIndex < 0) return
      event("content_block_stop", JSONObject().put("index", textIndex))
      textIndex = -1
      text.setLength(0)
    }

    fun finish(stopReason: String, inputTokens: Int, outputTokens: Int) {
      closeText()
      if (stream) {
        event("message_delta", JSONObject().put("delta", JSONObject().put("stop_reason", stopReason).put("stop_sequence", JSONObject.NULL)).put("usage", JSONObject().put("output_tokens", outputTokens)))
        event("message_stop", JSONObject())
      } else {
        json(output, 200, message(inputTokens, outputTokens).put("stop_reason", stopReason))
      }
    }

    fun fail(type: String, message: String) {
      if (stream) event("error", JSONObject().put("error", JSONObject().put("type", type).put("message", message)))
      else json(output, if (type == "invalid_request_error") 400 else 500, error(type, message))
    }
  }

  private fun messages(context: Context, request: JSONObject, output: OutputStream) {
    val reply = Reply(output, request.optBoolean("stream"), request.optString("model"))
    val anthropic = request.optJSONArray("messages") ?: JSONArray()
    val history = toMessages(anthropic)
    val last = history.removeLastOrNull()
    if (last == null || last.role.name == "MODEL") {
      return reply.fail("invalid_request_error", "The last message must come from the user")
    }
    val inputTokens = estimateTokens(request)
    reply.start(inputTokens)
    try {
      PhoneModels.withEngine(context, request.optString("model")) { engine, id ->
        generate(engine, id, request, anthropic, reply, history, last, inputTokens)
      }
    } catch (error: Exception) {
      Log.w(TAG, "Generation failed", error)
      runCatching { reply.fail("api_error", error.message ?: error.toString()) }
    }
  }

  /** What the open conversation holds, so a request that only adds a message skips rereading the rest. */
  private class Live(val conversation: Conversation, val key: String, val messages: List<String>)

  // Only touched inside PhoneModels.withEngine, which runs one request at a time.
  private var live: Live? = null

  private fun generate(
    engine: Engine,
    id: String,
    request: JSONObject,
    anthropic: JSONArray,
    reply: Reply,
    history: List<Message>,
    last: Message,
    inputTokens: Int,
  ) {
    val system = systemText(request.opt("system"))
    val key = listOf(id, system, request.optJSONArray("tools")?.toString()).joinToString("\u0000")
    val signatures = (0 until anthropic.length()).map { signature(anthropic.optJSONObject(it) ?: JSONObject()) }
    val reusable = live?.takeIf {
      it.conversation === PhoneModels.openConversation && it.key == key && it.messages == signatures.dropLast(1)
    }
    live = null
    val conversation = reusable?.conversation ?: run {
      PhoneModels.closeOpenConversation()
      engine.createConversation(
        ConversationConfig(
          systemInstruction = system?.let { Contents.of(it) },
          initialMessages = history,
          tools = toTools(request.optJSONArray("tools")),
          automaticToolCalling = false,
        ),
      ).also { PhoneModels.openConversation = it }
    }
    val maxChars = request.optInt("max_tokens", 4096) * CHARS_PER_TOKEN
    val done = CountDownLatch(1)
    var failure: Throwable? = null
    var stopReason = "end_turn"
    var written = 0
    val seen = StringBuilder()
    val started = System.currentTimeMillis()
    conversation.sendMessageAsync(
      last,
      object : MessageCallback {
        override fun onMessage(message: Message) {
          try {
            val chunk = message.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }
            // Tolerates both deltas and the whole reply so far.
            val delta = if (chunk.startsWith(seen) && seen.isNotEmpty()) chunk.substring(seen.length) else chunk
            seen.append(delta)
            reply.text(delta)
            written += delta.length
            message.toolCalls.forEach { call ->
              reply.toolUse(call.name, toJson(call.arguments) as JSONObject)
              stopReason = "tool_use"
            }
            if (written > maxChars) {
              stopReason = "max_tokens"
              conversation.cancelProcess()
            }
          } catch (error: IOException) {
            // Claude Code went away, such as when the user stopped the turn.
            failure = error
            conversation.cancelProcess()
          }
        }

        override fun onDone() = done.countDown()

        override fun onError(throwable: Throwable) {
          if (stopReason != "max_tokens" && failure == null) failure = throwable
          done.countDown()
        }
      },
    )
    done.await()
    val error = failure
    Log.i(TAG, "request: ~$inputTokens tokens, ${if (reusable != null) "continued" else "read in full"}, ${System.currentTimeMillis() - started} ms, ${error?.message ?: stopReason}")
    if (error == null && stopReason != "max_tokens") {
      val answer = JSONObject().put("role", "assistant").put("content", reply.blocks)
      live = Live(conversation, key, signatures + signature(answer))
    } else {
      // A cut-off or failed reply leaves the conversation somewhere Claude Code's history is not.
      PhoneModels.closeOpenConversation()
    }
    when {
      error is IOException -> Unit
      error != null -> {
        val message = error.message ?: error.toString()
        val limit = PhoneModels.state.contextTokens
        if (message.contains("token", ignoreCase = true) && inputTokens > limit / 2) {
          reply.fail("invalid_request_error", "prompt is too long: $inputTokens tokens > $limit maximum")
        } else {
          reply.fail("api_error", message)
        }
      }
      else -> reply.finish(stopReason, inputTokens, written / CHARS_PER_TOKEN + 1)
    }
  }

  /** A message's words, tool calls and results, ignoring what Claude Code adds or drops when it resends it. */
  private fun signature(message: JSONObject): String {
    val blocks = when (val content = message.opt("content")) {
      is JSONArray -> (0 until content.length()).mapNotNull { content.optJSONObject(it) }
      is String -> listOf(JSONObject().put("type", "text").put("text", content))
      else -> emptyList()
    }
    return message.optString("role") + blocks.mapNotNull { block ->
      when (block.optString("type")) {
        "text" -> block.optString("text").trim().takeIf { it.isNotEmpty() }?.let { "t:$it" }
        "tool_use" -> "u:${block.optString("id")}:${block.optString("name")}:${canonical(block.optJSONObject("input"))}"
        "tool_result" -> "r:${block.optString("tool_use_id")}:${resultText(block)}"
        "image" -> "i"
        else -> null
      }
    }.joinToString("\u0001", prefix = "\u0002")
  }

  private fun resultText(block: JSONObject): String = when (val value = block.opt("content")) {
    is JSONArray -> (0 until value.length()).mapNotNull { value.optJSONObject(it)?.optString("text") }.joinToString("\n")
    is String -> value
    else -> ""
  }

  private fun canonical(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { "$it=${canonical(value.opt(it))}" }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.opt(it)) }
    null, JSONObject.NULL -> ""
    else -> value.toString()
  }

  private fun systemText(system: Any?): String? = when (system) {
    is String -> system
    is JSONArray -> (0 until system.length()).mapNotNull { system.optJSONObject(it)?.optString("text") }.joinToString("\n\n")
    else -> null
  }?.takeIf { it.isNotBlank() }

  private fun toTools(tools: JSONArray?) = (0 until (tools?.length() ?: 0)).mapNotNull { index ->
    val definition = tools!!.optJSONObject(index) ?: return@mapNotNull null
    // Server tools such as web search have no schema and no way to run here.
    val schema = definition.optJSONObject("input_schema") ?: return@mapNotNull null
    val description = JSONObject()
      .put("name", definition.optString("name"))
      .put("description", definition.optString("description"))
      .put("parameters", schema)
      .toString()
    tool(
      object : OpenApiTool {
        override fun getToolDescriptionJsonString() = description
        override fun execute(paramsJsonString: String) = throw UnsupportedOperationException("Claude Code runs tools")
      },
    )
  }

  /** Anthropic's history in LiteRT's roles; tool results find their tool's name by id. */
  private fun toMessages(messages: JSONArray): MutableList<Message> {
    val toolNames = mutableMapOf<String, String>()
    val result = mutableListOf<Message>()
    for (i in 0 until messages.length()) {
      val message = messages.optJSONObject(i) ?: continue
      val content = message.opt("content")
      val blocks = when (content) {
        is JSONArray -> (0 until content.length()).mapNotNull { content.optJSONObject(it) }
        is String -> listOf(JSONObject().put("type", "text").put("text", content))
        else -> emptyList()
      }
      val text = blocks.joinToString("\n") { block ->
        when (block.optString("type")) {
          "text" -> block.optString("text")
          "image" -> "[image omitted]"
          else -> ""
        }
      }.trim()
      if (message.optString("role") == "assistant") {
        val calls = blocks.filter { it.optString("type") == "tool_use" }.map { block ->
          toolNames[block.optString("id")] = block.optString("name")
          @Suppress("UNCHECKED_CAST")
          ToolCall(block.optString("name"), fromJson(block.optJSONObject("input") ?: JSONObject()) as Map<String, Any>)
        }
        result += Message.model(Contents.of(if (text.isEmpty()) emptyList<Content>() else listOf(Content.Text(text))), calls, emptyMap())
      } else {
        // Gemma's template closes a replayed tool call's turn before its response, and the model
        // then answers nothing, so results go back as the user's words in a fresh turn.
        val results = blocks.filter { it.optString("type") == "tool_result" }.map { block ->
          val output = resultText(block)
          val name = toolNames[block.optString("tool_use_id")] ?: "the tool"
          (if (block.optBoolean("is_error")) "$name failed:\n" else "$name returned:\n") + output.ifEmpty { "(no output)" }
        }
        val words = (results + listOfNotNull(text.takeIf { it.isNotEmpty() })).joinToString("\n\n")
        if (words.isNotEmpty()) result += Message.user(words)
      }
    }
    return result
  }

  private fun fromJson(value: Any?): Any? = when (value) {
    is JSONObject -> value.keys().asSequence().associateWith { fromJson(value.opt(it)) }
    is JSONArray -> (0 until value.length()).map { fromJson(value.opt(it)) }
    JSONObject.NULL -> null
    else -> value
  }

  private fun toJson(value: Any?): Any = when (value) {
    is Map<*, *> -> JSONObject().apply { value.forEach { (key, item) -> put(key.toString(), toJson(item)) } }
    is List<*> -> JSONArray().apply { value.forEach { put(toJson(it)) } }
    null -> JSONObject.NULL
    else -> value
  }

  private fun estimateTokens(request: JSONObject): Int {
    val chars = (request.opt("system")?.toString()?.length ?: 0) +
      (request.optJSONArray("messages")?.toString()?.length ?: 0) +
      (request.optJSONArray("tools")?.toString()?.length ?: 0)
    return chars / CHARS_PER_TOKEN
  }
}
