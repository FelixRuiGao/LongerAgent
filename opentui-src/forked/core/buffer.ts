import type { TextBuffer } from "./text-buffer.js"
import { RGBA } from "./lib/index.js"
import { resolveRenderLib, type RenderLib } from "./zig.js"
import { type Pointer, toArrayBuffer, ptr } from "bun:ffi"
import { type BorderStyle, type BorderSides, BorderCharArrays, BorderChars, parseBorderStyle, getBorderSides } from "./lib/index.js"
import { type WidthMethod, type CapturedSpan, type CapturedLine } from "./types.js"
import type { TextBufferView } from "./text-buffer-view.js"
import type { EditorView } from "./editor-view.js"

// Pack drawing options into a single u32
// bits 0-3: borderSides, bit 4: shouldFill, bits 5-6: titleAlignment
function packDrawOptions(
  border: boolean | BorderSides[],
  shouldFill: boolean,
  titleAlignment: "left" | "center" | "right",
): number {
  let packed = 0

  if (border === true) {
    packed |= 0b1111 // All sides
  } else if (Array.isArray(border)) {
    if (border.includes("top")) packed |= 0b1000
    if (border.includes("right")) packed |= 0b0100
    if (border.includes("bottom")) packed |= 0b0010
    if (border.includes("left")) packed |= 0b0001
  }

  if (shouldFill) {
    packed |= 1 << 4
  }

  const alignmentMap: Record<string, number> = {
    left: 0,
    center: 1,
    right: 2,
  }
  const alignment = alignmentMap[titleAlignment]
  packed |= alignment << 5

  return packed
}

export class OptimizedBuffer {
  private static fbIdCounter = 0
  public id: string
  public lib: RenderLib
  private bufferPtr: Pointer
  private _width: number
  private _height: number
  private _widthMethod: WidthMethod
  public respectAlpha: boolean = false
  /** JS-side scissor rect stack for cursor clipping queries. */
  private _scissorStack: Array<{ x: number; y: number; w: number; h: number }> = []
  private _rawBuffers: {
    char: Uint32Array
    fg: Float32Array
    bg: Float32Array
    attributes: Uint32Array
  } | null = null
  private _destroyed: boolean = false

  get ptr(): Pointer {
    return this.bufferPtr
  }

  // Fail loud and clear
  // Instead of trying to return values that could work or not,
  // this at least will show a stack trace to know where the call to a destroyed Buffer was made
  private guard(): void {
    if (this._destroyed) throw new Error(`Buffer ${this.id} is destroyed`)
  }

  get buffers(): {
    char: Uint32Array
    fg: Float32Array
    bg: Float32Array
    attributes: Uint32Array
  } {
    this.guard()
    if (this._rawBuffers === null) {
      const size = this._width * this._height
      const charPtr = this.lib.bufferGetCharPtr(this.bufferPtr)
      const fgPtr = this.lib.bufferGetFgPtr(this.bufferPtr)
      const bgPtr = this.lib.bufferGetBgPtr(this.bufferPtr)
      const attributesPtr = this.lib.bufferGetAttributesPtr(this.bufferPtr)

      this._rawBuffers = {
        char: new Uint32Array(toArrayBuffer(charPtr, 0, size * 4)),
        fg: new Float32Array(toArrayBuffer(fgPtr, 0, size * 4 * 4)),
        bg: new Float32Array(toArrayBuffer(bgPtr, 0, size * 4 * 4)),
        attributes: new Uint32Array(toArrayBuffer(attributesPtr, 0, size * 4)),
      }
    }

    return this._rawBuffers
  }

  constructor(
    lib: RenderLib,
    ptr: Pointer,
    width: number,
    height: number,
    options: { respectAlpha?: boolean; id?: string; widthMethod?: WidthMethod },
  ) {
    this.id = options.id || `fb_${OptimizedBuffer.fbIdCounter++}`
    this.lib = lib
    this.respectAlpha = options.respectAlpha || false
    this._width = width
    this._height = height
    this._widthMethod = options.widthMethod || "unicode"
    this.bufferPtr = ptr
  }

  static create(
    width: number,
    height: number,
    widthMethod: WidthMethod,
    options: { respectAlpha?: boolean; id?: string } = {},
  ): OptimizedBuffer {
    const lib = resolveRenderLib()
    const respectAlpha = options.respectAlpha || false
    const id = options.id && options.id.trim() !== "" ? options.id : "unnamed buffer"
    const buffer = lib.createOptimizedBuffer(width, height, widthMethod, respectAlpha, id)
    return buffer
  }

  public get widthMethod(): WidthMethod {
    return this._widthMethod
  }

  public get width(): number {
    return this._width
  }

  public get height(): number {
    return this._height
  }

  public setRespectAlpha(respectAlpha: boolean): void {
    this.guard()
    this.lib.bufferSetRespectAlpha(this.bufferPtr, respectAlpha)
    this.respectAlpha = respectAlpha
  }

  public getNativeId(): string {
    this.guard()
    return this.lib.bufferGetId(this.bufferPtr)
  }

  public getRealCharBytes(addLineBreaks: boolean = false): Uint8Array {
    this.guard()
    const realSize = this.lib.bufferGetRealCharSize(this.bufferPtr)
    const outputBuffer = new Uint8Array(realSize)
    const bytesWritten = this.lib.bufferWriteResolvedChars(this.bufferPtr, outputBuffer, addLineBreaks)
    return outputBuffer.slice(0, bytesWritten)
  }

  public getSpanLines(): CapturedLine[] {
    this.guard()
    const { char, fg, bg, attributes } = this.buffers
    const lines: CapturedLine[] = []

    const CHAR_FLAG_CONTINUATION = 0xc0000000 | 0
    const CHAR_FLAG_MASK = 0xc0000000 | 0

    const realTextBytes = this.getRealCharBytes(true)
    const realTextLines = new TextDecoder().decode(realTextBytes).split("\n")

    for (let y = 0; y < this._height; y++) {
      const spans: CapturedSpan[] = []
      let currentSpan: CapturedSpan | null = null

      const lineChars = [...(realTextLines[y] || "")]
      let charIdx = 0

      for (let x = 0; x < this._width; x++) {
        const i = y * this._width + x
        const cp = char[i]
        const cellFg = RGBA.fromValues(fg[i * 4], fg[i * 4 + 1], fg[i * 4 + 2], fg[i * 4 + 3])
        const cellBg = RGBA.fromValues(bg[i * 4], bg[i * 4 + 1], bg[i * 4 + 2], bg[i * 4 + 3])
        const cellAttrs = attributes[i] & 0xff

        // Continuation cells are placeholders for wide characters (emojis, CJK)
        const isContinuation = (cp & CHAR_FLAG_MASK) === CHAR_FLAG_CONTINUATION
        const cellChar = isContinuation ? "" : (lineChars[charIdx++] ?? " ")

        // Check if this cell continues the current span
        if (
          currentSpan &&
          currentSpan.fg.equals(cellFg) &&
          currentSpan.bg.equals(cellBg) &&
          currentSpan.attributes === cellAttrs
        ) {
          currentSpan.text += cellChar
          currentSpan.width += 1
        } else {
          // Start a new span
          if (currentSpan) {
            spans.push(currentSpan)
          }
          currentSpan = {
            text: cellChar,
            fg: cellFg,
            bg: cellBg,
            attributes: cellAttrs,
            width: 1,
          }
        }
      }

      // Push the last span
      if (currentSpan) {
        spans.push(currentSpan)
      }

      lines.push({ spans })
    }

    return lines
  }

  public clear(bg: RGBA = RGBA.fromValues(0, 0, 0, 1)): void {
    this.guard()
    this.lib.bufferClear(this.bufferPtr, bg)
  }

  public setCell(x: number, y: number, char: string, fg: RGBA, bg: RGBA, attributes: number = 0): void {
    this.guard()
    this.lib.bufferSetCell(this.bufferPtr, x, y, char, fg, bg, attributes)
  }

  public setCellWithAlphaBlending(
    x: number,
    y: number,
    char: string,
    fg: RGBA,
    bg: RGBA,
    attributes: number = 0,
  ): void {
    this.guard()
    this.lib.bufferSetCellWithAlphaBlending(this.bufferPtr, x, y, char, fg, bg, attributes)
  }

  public drawText(
    text: string,
    x: number,
    y: number,
    fg: RGBA,
    bg?: RGBA,
    attributes: number = 0,
    selection?: { start: number; end: number; bgColor?: RGBA; fgColor?: RGBA } | null,
  ): void {
    this.guard()
    if (!selection) {
      this.lib.bufferDrawText(this.bufferPtr, text, x, y, fg, bg, attributes)
      return
    }

    const { start, end } = selection

    let selectionBg: RGBA
    let selectionFg: RGBA

    if (selection.bgColor) {
      selectionBg = selection.bgColor
      selectionFg = selection.fgColor || fg
    } else {
      const defaultBg = bg || RGBA.fromValues(0, 0, 0, 0)
      selectionFg = defaultBg.a > 0 ? defaultBg : RGBA.fromValues(0, 0, 0, 1)
      selectionBg = fg
    }

    if (start > 0) {
      const beforeText = text.slice(0, start)
      this.lib.bufferDrawText(this.bufferPtr, beforeText, x, y, fg, bg, attributes)
    }

    if (end > start) {
      const selectedText = text.slice(start, end)
      this.lib.bufferDrawText(this.bufferPtr, selectedText, x + start, y, selectionFg, selectionBg, attributes)
    }

    if (end < text.length) {
      const afterText = text.slice(end)
      this.lib.bufferDrawText(this.bufferPtr, afterText, x + end, y, fg, bg, attributes)
    }
  }

  public fillRect(x: number, y: number, width: number, height: number, bg: RGBA): void {
    this.lib.bufferFillRect(this.bufferPtr, x, y, width, height, bg)
  }

  public drawFrameBuffer(
    destX: number,
    destY: number,
    frameBuffer: OptimizedBuffer,
    sourceX?: number,
    sourceY?: number,
    sourceWidth?: number,
    sourceHeight?: number,
  ): void {
    this.guard()
    this.lib.drawFrameBuffer(this.bufferPtr, destX, destY, frameBuffer.ptr, sourceX, sourceY, sourceWidth, sourceHeight)
  }

  public destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this.lib.destroyOptimizedBuffer(this.bufferPtr)
  }

  public drawTextBuffer(textBufferView: TextBufferView, x: number, y: number): void {
    this.guard()
    this.lib.bufferDrawTextBufferView(this.bufferPtr, textBufferView.ptr, x, y)
  }

  public drawEditorView(editorView: EditorView, x: number, y: number): void {
    this.guard()
    this.lib.bufferDrawEditorView(this.bufferPtr, editorView.ptr, x, y)
  }

  public drawSuperSampleBuffer(
    x: number,
    y: number,
    pixelDataPtr: Pointer,
    pixelDataLength: number,
    format: "bgra8unorm" | "rgba8unorm",
    alignedBytesPerRow: number,
  ): void {
    this.guard()
    this.lib.bufferDrawSuperSampleBuffer(
      this.bufferPtr,
      x,
      y,
      pixelDataPtr,
      pixelDataLength,
      format,
      alignedBytesPerRow,
    )
  }

  public drawPackedBuffer(
    dataPtr: Pointer,
    dataLen: number,
    posX: number,
    posY: number,
    terminalWidthCells: number,
    terminalHeightCells: number,
  ): void {
    this.guard()
    this.lib.bufferDrawPackedBuffer(
      this.bufferPtr,
      dataPtr,
      dataLen,
      posX,
      posY,
      terminalWidthCells,
      terminalHeightCells,
    )
  }

  public drawGrayscaleBuffer(
    posX: number,
    posY: number,
    intensities: Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null = null,
    bg: RGBA | null = null,
  ): void {
    this.guard()
    this.lib.bufferDrawGrayscaleBuffer(this.bufferPtr, posX, posY, ptr(intensities), srcWidth, srcHeight, fg, bg)
  }

  public drawGrayscaleBufferSupersampled(
    posX: number,
    posY: number,
    intensities: Float32Array,
    srcWidth: number,
    srcHeight: number,
    fg: RGBA | null = null,
    bg: RGBA | null = null,
  ): void {
    this.guard()
    this.lib.bufferDrawGrayscaleBufferSupersampled(
      this.bufferPtr,
      posX,
      posY,
      ptr(intensities),
      srcWidth,
      srcHeight,
      fg,
      bg,
    )
  }

  public resize(width: number, height: number): void {
    this.guard()
    if (this._width === width && this._height === height) return

    this._width = width
    this._height = height
    this._rawBuffers = null

    this.lib.bufferResize(this.bufferPtr, width, height)
  }

  public drawBox(options: {
    x: number
    y: number
    width: number
    height: number
    borderStyle?: BorderStyle
    customBorderChars?: Uint32Array
    border: boolean | BorderSides[]
    borderColor: RGBA
    backgroundColor: RGBA
    shouldFill?: boolean
    title?: string
    titleAlignment?: "left" | "center" | "right"
    titleColor?: RGBA
    dividerRatio?: number
    dividerTitle?: string
    dividerTitleColor?: RGBA
  }): void {
    this.guard()
    const style = parseBorderStyle(options.borderStyle, "single")
    const borderChars: Uint32Array = options.customBorderChars ?? BorderCharArrays[style]

    const packedOptions = packDrawOptions(options.border, options.shouldFill ?? false, options.titleAlignment || "left")

    // Determine rendering strategy for the left title
    const hasDivider = options.dividerRatio != null && options.dividerRatio > 0 && options.dividerRatio < 1
    // Only use JS for the left title when a custom titleColor is explicitly set.
    // Otherwise let Zig handle it natively (it correctly skips ─ in the title area).
    const jsDrawsLeftTitle = !!options.titleColor
    let leftTitleText = options.title ?? null

    if (leftTitleText && hasDivider) {
      // Truncate left title so it doesn't bleed past the divider.
      // Reserve 2 extra chars for the spaces we wrap around the title.
      const dividerCol = Math.round(options.width * options.dividerRatio!)
      const leftPadding = 2 // matches Zig's 2-cell padding before and after title
      const maxTitleLen = dividerCol - leftPadding * 2 - 2
      if (maxTitleLen < 1) {
        leftTitleText = null
      } else if (leftTitleText.length > maxTitleLen) {
        leftTitleText = leftTitleText.slice(0, Math.max(1, maxTitleLen - 1)) + "…"
      }
    }

    // Wrap with spaces for visual separation from ── border segments
    if (leftTitleText) {
      leftTitleText = ` ${leftTitleText} `
    }

    this.lib.bufferDrawBox(
      this.bufferPtr,
      options.x,
      options.y,
      options.width,
      options.height,
      borderChars,
      packedOptions,
      options.borderColor,
      options.backgroundColor,
      // When JS draws the left title (custom color), tell Zig to skip title.
      // Otherwise pass the (possibly truncated) title to Zig for native rendering.
      jsDrawsLeftTitle ? null : leftTitleText,
    )

    // Draw left title from JS only when a custom titleColor is set
    if (jsDrawsLeftTitle && leftTitleText && leftTitleText.length > 0) {
      const sides = getBorderSides(options.border)
      if (sides.top) {
        const titlePadding = 2
        const titleStartX = options.x + titlePadding
        const titleFg = options.titleColor!
        // Use setCell (not setCellWithAlphaBlending) to directly overwrite ─ border chars.
        // blendCells preserves underlying chars when bg is transparent.
        for (let i = 0; i < leftTitleText.length; i++) {
          this.setCell(
            titleStartX + i, options.y, leftTitleText[i], titleFg, options.backgroundColor,
          )
        }
      }
    }

    // Draw vertical divider after the base box is rendered
    if (hasDivider) {
      const ratio = options.dividerRatio!
      const sides = getBorderSides(options.border)
      const chars = BorderChars[style]
      const fg = options.borderColor
      const bg = options.backgroundColor

      // Divider x position: offset from box left edge
      const dividerX = options.x + Math.round(options.width * ratio)

      // Only draw if divider falls within the box (excluding the outer border columns)
      const leftEdge = options.x + (sides.left ? 1 : 0)
      const rightEdge = options.x + options.width - 1 - (sides.right ? 1 : 0)
      if (dividerX < leftEdge || dividerX > rightEdge) return

      // Top junction: topT (┬) if there is a top border
      if (sides.top) {
        this.setCellWithAlphaBlending(dividerX, options.y, chars.topT, fg, bg)
      }

      // Vertical line through the interior
      const innerTop = options.y + (sides.top ? 1 : 0)
      const innerBottom = options.y + options.height - 1 - (sides.bottom ? 1 : 0)
      for (let dy = innerTop; dy <= innerBottom; dy++) {
        this.setCellWithAlphaBlending(dividerX, dy, chars.vertical, fg, bg)
      }

      // Bottom junction: bottomT (┴) if there is a bottom border
      if (sides.bottom) {
        this.setCellWithAlphaBlending(dividerX, options.y + options.height - 1, chars.bottomT, fg, bg)
      }

      // Draw divider title on the top border, starting 2 cells after dividerX
      if (options.dividerTitle && sides.top && options.dividerTitle.length > 0) {
        const titlePadding = 2
        const titleStartX = dividerX + titlePadding
        // Available space: from titleStartX to right border (exclusive), minus padding on the right.
        // Reserve 2 extra chars for the spaces we wrap around the title.
        const rightBorderX = options.x + options.width - 1
        const availableWidth = rightBorderX - titleStartX - titlePadding - 2
        if (availableWidth >= 1) {
          let titleText = options.dividerTitle.length <= availableWidth
            ? options.dividerTitle
            : options.dividerTitle.slice(0, Math.max(1, availableWidth - 1)) + "…"
          // Wrap with spaces for visual separation from ── border segments
          titleText = ` ${titleText} `
          const dividerTitleFg = options.dividerTitleColor ?? fg
          // Use setCell (not setCellWithAlphaBlending) to directly overwrite ─ border chars.
          // blendCells preserves underlying chars when bg is transparent.
          for (let i = 0; i < titleText.length; i++) {
            this.setCell(
              titleStartX + i, options.y, titleText[i], dividerTitleFg, bg,
            )
          }
        }
      }
    }
  }

  public pushScissorRect(x: number, y: number, width: number, height: number): void {
    this.guard()
    this._scissorStack.push({ x, y, w: width, h: height })
    this.lib.bufferPushScissorRect(this.bufferPtr, x, y, width, height)
  }

  public popScissorRect(): void {
    this.guard()
    this._scissorStack.pop()
    this.lib.bufferPopScissorRect(this.bufferPtr)
  }

  public clearScissorRects(): void {
    this.guard()
    this._scissorStack.length = 0
    this.lib.bufferClearScissorRects(this.bufferPtr)
  }

  /**
   * Check whether a 0-based coordinate is within ALL active scissor rects.
   * Used by cursor rendering to hide the cursor when it's clipped by a scrollbox viewport.
   */
  public isWithinScissorRect(x: number, y: number): boolean {
    for (const rect of this._scissorStack) {
      if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) {
        return false
      }
    }
    return true
  }

  public pushOpacity(opacity: number): void {
    this.guard()
    this.lib.bufferPushOpacity(this.bufferPtr, Math.max(0, Math.min(1, opacity)))
  }

  public popOpacity(): void {
    this.guard()
    this.lib.bufferPopOpacity(this.bufferPtr)
  }

  public getCurrentOpacity(): number {
    this.guard()
    return this.lib.bufferGetCurrentOpacity(this.bufferPtr)
  }

  public clearOpacity(): void {
    this.guard()
    this.lib.bufferClearOpacity(this.bufferPtr)
  }

  public encodeUnicode(text: string): { ptr: Pointer; data: Array<{ width: number; char: number }> } | null {
    this.guard()
    return this.lib.encodeUnicode(text, this._widthMethod)
  }

  public freeUnicode(encoded: { ptr: Pointer; data: Array<{ width: number; char: number }> }): void {
    this.guard()
    this.lib.freeUnicode(encoded)
  }

  public drawGrid(options: {
    borderChars: Uint32Array
    borderFg: RGBA
    borderBg: RGBA
    columnOffsets: Int32Array
    rowOffsets: Int32Array
    drawInner: boolean
    drawOuter: boolean
  }): void {
    this.guard()

    const columnCount = Math.max(0, options.columnOffsets.length - 1)
    const rowCount = Math.max(0, options.rowOffsets.length - 1)

    this.lib.bufferDrawGrid(
      this.bufferPtr,
      options.borderChars,
      options.borderFg,
      options.borderBg,
      options.columnOffsets,
      columnCount,
      options.rowOffsets,
      rowCount,
      {
        drawInner: options.drawInner,
        drawOuter: options.drawOuter,
      },
    )
  }

  public drawChar(char: number, x: number, y: number, fg: RGBA, bg: RGBA, attributes: number = 0): void {
    this.guard()
    this.lib.bufferDrawChar(this.bufferPtr, char, x, y, fg, bg, attributes)
  }
}
