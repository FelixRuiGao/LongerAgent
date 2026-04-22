// @ts-nocheck
/** @jsxImportSource opentui-jsx */
import { TimeToFirstDrawRenderable } from "../core/index.js"
import { createElement } from "react"
import { extend } from "./components/index.js"
import type { ExtendedComponentProps } from "./types/components.js"

declare module "@opentui/react" {
  interface OpenTUIComponents {
    "time-to-first-draw": typeof TimeToFirstDrawRenderable
  }
}

extend({ "time-to-first-draw": TimeToFirstDrawRenderable })

export type TimeToFirstDrawProps = ExtendedComponentProps<typeof TimeToFirstDrawRenderable>

export const TimeToFirstDraw = (props: TimeToFirstDrawProps) => {
  return createElement("time-to-first-draw", props)
}
