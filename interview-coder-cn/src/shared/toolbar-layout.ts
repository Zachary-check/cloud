/** Compact controls remain usable through the OS cursor sampler in dual mode. */
export const DUAL_TOOLBAR_ACTIONS = [
  'takeScreenshot',
  'pageUp',
  'pageDown',
  'ignoreOrEnableMouse'
] as const

// Four 28px buttons, 2px gaps, and 8px padding on either side.
export const DUAL_TOOLBAR_WIDTH =
  28 * DUAL_TOOLBAR_ACTIONS.length + 2 * (DUAL_TOOLBAR_ACTIONS.length - 1) + 16
