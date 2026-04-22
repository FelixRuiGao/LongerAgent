// @ts-nocheck
import type { RootRenderable } from "../../core/index.js"
import { createElement, type ReactNode } from "react"
import ReactReconciler from "react-reconciler"
import { ConcurrentRoot } from "react-reconciler/constants"
import { hostConfig } from "./host-config.js"

let _reconciler: ReturnType<typeof ReactReconciler> | null = null

function ensureReconciler() {
  if (!_reconciler) {
    _reconciler = ReactReconciler(hostConfig)
    _reconciler.injectIntoDevTools()
  }
  return _reconciler
}

export const reconciler = new Proxy({} as ReturnType<typeof ReactReconciler>, {
  get(_, prop) {
    return (ensureReconciler() as any)[prop]
  },
})

export function _render(element: ReactNode, root: RootRenderable) {
  const rec = ensureReconciler()
  const container = rec.createContainer(
    root,
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    console.error,
    console.error,
    console.error,
    console.error,
    null,
  )

  rec.updateContainer(element, container, null, () => {})

  return container
}
