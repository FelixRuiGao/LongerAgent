export class RGBA {
  buffer: Float32Array

  constructor(buffer: Float32Array) {
    this.buffer = buffer
  }

  static fromArray(array: Float32Array) {
    return new RGBA(array)
  }

  static fromValues(r: number, g: number, b: number, a: number = 1.0) {
    return new RGBA(new Float32Array([r, g, b, a]))
  }

  static fromInts(r: number, g: number, b: number, a: number = 255) {
    return new RGBA(new Float32Array([r / 255, g / 255, b / 255, a / 255]))
  }

  static fromHex(hex: string): RGBA {
    return hexToRgb(hex)
  }

  static fromAnsi256(index: number): RGBA {
    if (!Number.isInteger(index) || index < 0 || index > 255) {
      throw new RangeError(`ANSI 256 color index must be an integer between 0 and 255, got ${index}`)
    }

    // Sentinel encoding:
    //   r < 0 marks an indexed terminal color.
    //   g stores the 0..255 palette index.
    //   b is reserved for future use.
    //   a is kept opaque so existing truthy/alpha checks stay stable.
    return new RGBA(new Float32Array([-1, index, 0, 1]))
  }

  toInts(): [number, number, number, number] {
    if (this.isAnsi256()) {
      const [r, g, b] = ansi256ToRgb(this.ansi256Index()!)
      return [r, g, b, 255]
    }
    return [Math.round(this.r * 255), Math.round(this.g * 255), Math.round(this.b * 255), Math.round(this.a * 255)]
  }

  get r(): number {
    return this.buffer[0]
  }

  set r(value: number) {
    this.buffer[0] = value
  }

  get g(): number {
    return this.buffer[1]
  }

  set g(value: number) {
    this.buffer[1] = value
  }

  get b(): number {
    return this.buffer[2]
  }

  set b(value: number) {
    this.buffer[2] = value
  }

  get a(): number {
    return this.buffer[3]
  }

  set a(value: number) {
    this.buffer[3] = value
  }

  map<R>(fn: (value: number) => R) {
    return [fn(this.r), fn(this.g), fn(this.b), fn(this.a)]
  }

  toString() {
    if (this.isAnsi256()) {
      return `ansi256(${this.ansi256Index()})`
    }
    return `rgba(${this.r.toFixed(2)}, ${this.g.toFixed(2)}, ${this.b.toFixed(2)}, ${this.a.toFixed(2)})`
  }

  equals(other?: RGBA): boolean {
    if (!other) return false
    if (this.isAnsi256() || other.isAnsi256()) {
      return this.isAnsi256() && other.isAnsi256() && this.ansi256Index() === other.ansi256Index()
    }
    return this.r === other.r && this.g === other.g && this.b === other.b && this.a === other.a
  }

  isAnsi256(): boolean {
    return this.r < 0 && this.b === 0 && this.a === 1 && Number.isInteger(this.g) && this.g >= 0 && this.g <= 255
  }

  ansi256Index(): number | null {
    return this.isAnsi256() ? Math.round(this.g) : null
  }
}

export type ColorInput = string | RGBA

const ANSI_16_RGB: Array<[number, number, number]> = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
]

export function ansi256(index: number): RGBA {
  return RGBA.fromAnsi256(index)
}

export function isAnsi256Color(color: RGBA | undefined | null): color is RGBA {
  return !!color && color.isAnsi256()
}

export function getAnsi256Index(color: RGBA | undefined | null): number | null {
  return color?.ansi256Index() ?? null
}

export function ansi256ToRgb(index: number): [number, number, number] {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new RangeError(`ANSI 256 color index must be an integer between 0 and 255, got ${index}`)
  }

  if (index < 16) {
    return ANSI_16_RGB[index]
  }

  if (index < 232) {
    const paletteIndex = index - 16
    const r = Math.floor(paletteIndex / 36)
    const g = Math.floor((paletteIndex % 36) / 6)
    const b = paletteIndex % 6
    const steps = [0, 95, 135, 175, 215, 255]
    return [steps[r], steps[g], steps[b]]
  }

  const gray = 8 + (index - 232) * 10
  return [gray, gray, gray]
}

export function hexToRgb(hex: string): RGBA {
  hex = hex.replace(/^#/, "")

  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  } else if (hex.length === 4) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
  }

  if (!/^[0-9A-Fa-f]{6}$/.test(hex) && !/^[0-9A-Fa-f]{8}$/.test(hex)) {
    console.warn(`Invalid hex color: ${hex}, defaulting to magenta`)
    return RGBA.fromValues(1, 0, 1, 1)
  }

  const r = parseInt(hex.substring(0, 2), 16) / 255
  const g = parseInt(hex.substring(2, 4), 16) / 255
  const b = parseInt(hex.substring(4, 6), 16) / 255
  const a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1

  return RGBA.fromValues(r, g, b, a)
}

export function rgbToHex(rgb: RGBA): string {
  const components = rgb.a === 1 ? [rgb.r, rgb.g, rgb.b] : [rgb.r, rgb.g, rgb.b, rgb.a]
  return (
    "#" +
    components
      .map((x) => {
        const hex = Math.floor(Math.max(0, Math.min(1, x) * 255)).toString(16)
        return hex.length === 1 ? "0" + hex : hex
      })
      .join("")
  )
}

export function hsvToRgb(h: number, s: number, v: number): RGBA {
  let r = 0,
    g = 0,
    b = 0

  const i = Math.floor(h / 60) % 6
  const f = h / 60 - Math.floor(h / 60)
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)

  switch (i) {
    case 0:
      r = v
      g = t
      b = p
      break
    case 1:
      r = q
      g = v
      b = p
      break
    case 2:
      r = p
      g = v
      b = t
      break
    case 3:
      r = p
      g = q
      b = v
      break
    case 4:
      r = t
      g = p
      b = v
      break
    case 5:
      r = v
      g = p
      b = q
      break
  }

  return RGBA.fromValues(r, g, b, 1)
}

const CSS_COLOR_NAMES: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#008000",
  blue: "#0000FF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  magenta: "#FF00FF",
  silver: "#C0C0C0",
  gray: "#808080",
  grey: "#808080",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00FF00",
  aqua: "#00FFFF",
  teal: "#008080",
  navy: "#000080",
  fuchsia: "#FF00FF",
  purple: "#800080",
  orange: "#FFA500",
  brightblack: "#666666",
  brightred: "#FF6666",
  brightgreen: "#66FF66",
  brightblue: "#6666FF",
  brightyellow: "#FFFF66",
  brightcyan: "#66FFFF",
  brightmagenta: "#FF66FF",
  brightwhite: "#FFFFFF",
}

export function parseColor(color: ColorInput): RGBA {
  if (typeof color === "string") {
    const lowerColor = color.toLowerCase()

    if (lowerColor === "transparent") {
      return RGBA.fromValues(0, 0, 0, 0)
    }

    if (CSS_COLOR_NAMES[lowerColor]) {
      return hexToRgb(CSS_COLOR_NAMES[lowerColor])
    }

    return hexToRgb(color)
  }
  return color
}
