import { CliRenderer, CliRenderEvents, engine } from "../../core/index.js"
import { createElement, type ReactNode } from "react"
import type { OpaqueRoot } from "react-reconciler"
import { AppContext } from "../components/app.js"
import { ErrorBoundary } from "../components/error-boundary.js"
import { _render, reconciler } from "./reconciler.js"

const _r = reconciler as typeof reconciler & { flushSyncFromReconciler?: typeof reconciler.flushSync }
const flushSync = _r.flushSyncFromReconciler ?? _r.flushSync
const { createPortal } = reconciler

export type Root = {
  render: (node: ReactNode) => void
  unmount: () => void
}

export function createRoot(renderer: CliRenderer): Root {
  let container: OpaqueRoot | null = null

  const cleanup = () => {
    if (container) {
      reconciler.updateContainer(null, container, null, () => {})
      // @ts-expect-error the types for `react-reconciler` are not up to date with the library.
      reconciler.flushSyncWork()
      container = null
    }
  }

  renderer.once(CliRenderEvents.DESTROY, cleanup)

  return {
    render: (node: ReactNode) => {
      engine.attach(renderer)

      container = _render(
        createElement(
          AppContext.Provider,
          { value: { keyHandler: renderer.keyInput, renderer } },
          createElement(ErrorBoundary, null, node),
        ),
        renderer.root,
      )
    },

    unmount: cleanup,
  }
}

export { createPortal, flushSync }
