export function browserRevealPanelWidth(viewportWidth: number, sidebarWidth: number): number {
  return Math.max(320, Math.min(460, viewportWidth - sidebarWidth - 480))
}
