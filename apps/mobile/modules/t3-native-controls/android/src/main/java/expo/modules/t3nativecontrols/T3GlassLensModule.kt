package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.HardwareRenderer
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.RenderNode
import android.graphics.Shader
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sign

class T3GlassLensModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3GlassLens")

    View(T3GlassLensView::class) {
      Prop("targetTag") { view: T3GlassLensView, value: Int ->
        view.targetTag = value
      }
      Prop("tintColor") { view: T3GlassLensView, value: Int ->
        view.tintColor = value
      }
      Prop("backdropColor") { view: T3GlassLensView, value: Int ->
        view.backdropColor = value
      }
      Prop("dark") { view: T3GlassLensView, value: Boolean ->
        view.dark = value
      }
    }
  }
}

/**
 * Refracts the target view's pixels on the CPU, because RuntimeShader needs API 33. The bar is small
 * enough at half resolution for a lookup table per color channel to run on every frame.
 */
class T3GlassLensView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var targetTag = 0
    set(value) {
      field = value
      target = null
      forceCompose = true
    }
  var tintColor = 0
    set(value) {
      field = value
      forceCompose = true
    }
  var backdropColor = Color.BLACK
    set(value) {
      field = value
      forceCompose = true
    }
  var dark = false
    set(value) {
      field = value
      lutWidth = 0
      forceCompose = true
    }

  private val density = resources.displayMetrics.density
  private var target: View? = null
  private var forceCompose = true

  private var renderer: HardwareRenderer? = null
  private var reader: ImageReader? = null
  private var captureNode: RenderNode? = null
  private var output: Bitmap? = null
  private var source = IntArray(0)
  private var previous = IntArray(0)
  private var blurred = IntArray(0)
  private var scratch = IntArray(0)
  private var pixels = IntArray(0)

  private var lutWidth = 0
  private var lutHeight = 0
  private var captureWidth = 0
  private var captureHeight = 0
  private var redSample = IntArray(0)
  private var greenSample = IntArray(0)
  private var blueSample = IntArray(0)
  private var sharpness = IntArray(0)
  private var tintWeight = IntArray(0)
  private var scatter = IntArray(0)

  private val glassPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val rimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val tintPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val shaderMatrix = Matrix()
  private val bounds = RectF()
  private val selfLocation = IntArray(2)
  private val targetLocation = IntArray(2)

  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    refract()
    true
  }

  init {
    setWillNotDraw(false)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnPreDrawListener(preDraw)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDraw)
    releaseCapture()
    lutWidth = 0
    super.onDetachedFromWindow()
  }

  private fun resolveTarget(): View? {
    target?.let { return it }
    if (targetTag == 0) return null
    return appContext.findView<View>(targetTag)?.also { target = it }
  }

  private fun prepare(width: Int, height: Int) {
    val lensWidth = ceil(width * SCALE).toInt()
    val lensHeight = ceil(height * SCALE).toInt()
    if (lensWidth == lutWidth && lensHeight == lutHeight) return
    lutWidth = lensWidth
    lutHeight = lensHeight
    captureWidth = lensWidth + 2 * MARGIN
    captureHeight = lensHeight + 2 * MARGIN
    releaseCapture()
    val images = ImageReader.newInstance(captureWidth, captureHeight, PixelFormat.RGBA_8888, 3)
    images.setOnImageAvailableListener({ receiveFrame(it) }, Handler(Looper.getMainLooper()))
    val node = RenderNode("T3GlassLens").apply { setPosition(0, 0, captureWidth, captureHeight) }
    reader = images
    captureNode = node
    renderer = HardwareRenderer().apply {
      setSurface(images.surface)
      setContentRoot(node)
    }
    val refracted = Bitmap.createBitmap(lensWidth, lensHeight, Bitmap.Config.ARGB_8888)
    output = refracted
    glassPaint.shader = BitmapShader(refracted, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    val size = captureWidth * captureHeight
    source = IntArray(size)
    previous = IntArray(size)
    blurred = IntArray(size)
    scratch = IntArray(size)
    pixels = IntArray(lensWidth * lensHeight)
    bakeLens(lensWidth, lensHeight, captureHeight)
    forceCompose = true
  }

  private fun releaseCapture() {
    renderer?.destroy()
    renderer = null
    reader?.close()
    reader = null
    captureNode?.discardDisplayList()
    captureNode = null
  }

  // Rounded-rect distance field: pixels within the bezel sample from further inside.
  private fun bakeLens(width: Int, height: Int, captureHeight: Int) {
    val size = width * height
    redSample = IntArray(size)
    greenSample = IntArray(size)
    blueSample = IntArray(size)
    sharpness = IntArray(size)
    tintWeight = IntArray(size)
    scatter = IntArray(size)
    val halfWidth = width / 2f
    val halfHeight = height / 2f
    val radius = min(halfWidth, halfHeight)
    val bezel = min(BEZEL_DP * density * SCALE, radius)
    val bend = BEND_DP * density * SCALE
    val lightX = -0.6f
    val lightY = -0.8f
    for (y in 0 until height) {
      for (x in 0 until width) {
        val pointX = x + 0.5f - halfWidth
        val pointY = y + 0.5f - halfHeight
        val edgeX = abs(pointX) - (halfWidth - radius)
        val edgeY = abs(pointY) - (halfHeight - radius)
        val outerX = max(edgeX, 0f)
        val outerY = max(edgeY, 0f)
        val outside = hypot(outerX, outerY)
        val depth = -(outside + min(max(edgeX, edgeY), 0f) - radius)
        var normalX = 0f
        var normalY = 0f
        if (outside > 0f) {
          normalX = outerX / outside
          normalY = outerY / outside
        } else if (edgeX > edgeY) {
          normalX = 1f
        } else {
          normalY = 1f
        }
        normalX *= sign(pointX)
        normalY *= sign(pointY)
        val rim = if (depth > 0f && depth < bezel) 1f - depth / bezel else if (depth <= 0f) 1f else 0f
        val shift = rim * rim * bend
        val index = y * width + x
        redSample[index] = sampleIndex(x, y, normalX, normalY, shift * (1f + DISPERSION), width, height, captureHeight)
        greenSample[index] = sampleIndex(x, y, normalX, normalY, shift, width, height, captureHeight)
        blueSample[index] = sampleIndex(x, y, normalX, normalY, shift * (1f - DISPERSION), width, height, captureHeight)
        sharpness[index] = (min(1f, rim * 1.6f) * 255f).toInt()
        tintWeight[index] = ((1f - 0.85f * rim) * 255f).toInt()
        val facing = abs(normalX * lightX + normalY * lightY)
        scatter[index] = (rim.pow(3f) * (0.2f + 0.8f * facing * facing) * 255f).toInt()
      }
    }
  }

  private fun sampleIndex(
    x: Int,
    y: Int,
    normalX: Float,
    normalY: Float,
    shift: Float,
    width: Int,
    height: Int,
    captureHeight: Int,
  ): Int {
    val sampleX = (x + MARGIN - normalX * shift).toInt().coerceIn(0, width + 2 * MARGIN - 1)
    val sampleY = (y + MARGIN - normalY * shift).toInt().coerceIn(0, captureHeight - 1)
    return sampleY * captureWidth + sampleX
  }

  // View.draw on a software canvas corrupts the live tree's redraw state and blanks returning
  // screens, so capture records through the same hardware path the window uses.
  private fun refract() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val view = resolveTarget() ?: return
    if (width == 0 || height == 0 || !isShown) return
    prepare(width, height)
    val node = captureNode ?: return
    view.getLocationInWindow(targetLocation)
    getLocationInWindow(selfLocation)
    val left = selfLocation[0] - targetLocation[0] - MARGIN / SCALE
    val top = selfLocation[1] - targetLocation[1] - MARGIN / SCALE
    val canvas = node.beginRecording(captureWidth, captureHeight)
    try {
      canvas.drawColor(backdropColor)
      canvas.scale(SCALE, SCALE)
      canvas.translate(-left, -top)
      view.draw(canvas)
    } finally {
      node.endRecording()
    }
    renderer?.createRenderRequest()?.syncAndDraw()
  }

  private fun receiveFrame(images: ImageReader) {
    val image = images.acquireLatestImage() ?: return
    image.use {
      val plane = it.planes[0]
      val rows = plane.buffer.order(ByteOrder.LITTLE_ENDIAN).asIntBuffer()
      val stride = plane.rowStride / 4
      for (row in 0 until captureHeight) {
        rows.position(row * stride)
        rows.get(source, row * captureWidth, captureWidth)
      }
    }
    for (index in source.indices) {
      val color = source[index]
      source[index] =
        (255 shl 24) or ((color and 255) shl 16) or (color and 0xFF00) or ((color shr 16) and 255)
    }
    if (!forceCompose && source.contentEquals(previous)) return
    forceCompose = false
    System.arraycopy(source, 0, previous, 0, source.size)
    System.arraycopy(source, 0, blurred, 0, source.size)
    repeat(BLUR_PASSES) { boxBlur(blurred, scratch, captureWidth, captureHeight, BLUR_RADIUS) }
    compose()
    output?.setPixels(pixels, 0, lutWidth, 0, 0, lutWidth, lutHeight)
    invalidate()
  }

  private fun compose() {
    val tintAlpha = Color.alpha(tintColor)
    val tintRed = Color.red(tintColor)
    val tintGreen = Color.green(tintColor)
    val tintBlue = Color.blue(tintColor)
    val base = if (dark) 96 else 210
    for (index in pixels.indices) {
      val edge = sharpness[index]
      val soft = 255 - edge
      val red = redSample[index]
      val green = greenSample[index]
      val blue = blueSample[index]
      val glowRed = (blurred[red] shr 16) and 255
      val glowGreen = (blurred[green] shr 8) and 255
      val glowBlue = blurred[blue] and 255
      var outRed = (glowRed * soft + ((source[red] shr 16) and 255) * edge) / 255
      var outGreen = (glowGreen * soft + ((source[green] shr 8) and 255) * edge) / 255
      var outBlue = (glowBlue * soft + (source[blue] and 255) * edge) / 255
      val tint = tintAlpha * tintWeight[index] / 255
      val clear = 255 - tint
      outRed = (outRed * clear + tintRed * tint) / 255
      outGreen = (outGreen * clear + tintGreen * tint) / 255
      outBlue = (outBlue * clear + tintBlue * tint) / 255
      val light = scatter[index]
      outRed = min(255, outRed + light * (glowRed + base) / 255)
      outGreen = min(255, outGreen + light * (glowGreen + base) / 255)
      outBlue = min(255, outBlue + light * (glowBlue + base) / 255)
      pixels[index] = (255 shl 24) or (outRed shl 16) or (outGreen shl 8) or outBlue
    }
  }

  private fun boxBlur(data: IntArray, work: IntArray, width: Int, height: Int, radius: Int) {
    blurLines(data, work, height, width, width, 1, radius)
    blurLines(work, data, width, height, 1, width, radius)
  }

  private fun blurLines(
    from: IntArray,
    to: IntArray,
    lines: Int,
    length: Int,
    lineStride: Int,
    step: Int,
    radius: Int,
  ) {
    val window = 2 * radius + 1
    for (line in 0 until lines) {
      val start = line * lineStride
      var red = 0
      var green = 0
      var blue = 0
      for (offset in -radius..radius) {
        val color = from[start + offset.coerceIn(0, length - 1) * step]
        red += (color shr 16) and 255
        green += (color shr 8) and 255
        blue += color and 255
      }
      for (position in 0 until length) {
        to[start + position * step] =
          (255 shl 24) or ((red / window) shl 16) or ((green / window) shl 8) or (blue / window)
        val leaving = from[start + (position - radius).coerceIn(0, length - 1) * step]
        val entering = from[start + (position + radius + 1).coerceIn(0, length - 1) * step]
        red += ((entering shr 16) and 255) - ((leaving shr 16) and 255)
        green += ((entering shr 8) and 255) - ((leaving shr 8) and 255)
        blue += (entering and 255) - (leaving and 255)
      }
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val radius = height / 2f
    bounds.set(0f, 0f, width.toFloat(), height.toFloat())
    val refracted = output
    if (refracted == null) {
      tintPaint.color = tintColor
      canvas.drawRoundRect(bounds, radius, radius, tintPaint)
      return
    }
    shaderMatrix.setScale(width.toFloat() / refracted.width, height.toFloat() / refracted.height)
    glassPaint.shader?.setLocalMatrix(shaderMatrix)
    canvas.drawRoundRect(bounds, radius, radius, glassPaint)

    val inset = density * 0.5f
    bounds.inset(inset, inset)
    rimPaint.strokeWidth = density
    rimPaint.shader = LinearGradient(
      0f,
      0f,
      width.toFloat(),
      height.toFloat(),
      if (dark) DARK_RIM else LIGHT_RIM,
      floatArrayOf(0f, 0.35f, 0.7f, 1f),
      Shader.TileMode.CLAMP,
    )
    canvas.drawRoundRect(bounds, radius, radius, rimPaint)
  }

  private companion object {
    const val SCALE = 0.5f
    const val MARGIN = 12
    const val BEZEL_DP = 20f
    const val BEND_DP = 26f
    const val DISPERSION = 0.12f
    const val BLUR_RADIUS = 5
    const val BLUR_PASSES = 2
    val DARK_RIM = intArrayOf(0xE6FFFFFF.toInt(), 0x14FFFFFF, 0x14FFFFFF, 0xB3FFFFFF.toInt())
    val LIGHT_RIM = intArrayOf(0x33000000, 0x14000000, 0x14000000, 0x40000000)
  }
}
