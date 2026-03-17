// Stub: ink is not used in Electron GUI main process
export function render() { throw new Error("ink is not available in GUI mode"); }
export function Box() {}
export function Text() {}
export function useApp() { return { exit() {} }; }
export function useStdin() { return { stdin: null, isRawModeSupported: false, setRawMode() {} }; }
