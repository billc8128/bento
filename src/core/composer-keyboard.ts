export function shouldSubmitComposerKey(event: {
  key: string
  shiftKey: boolean
  isComposing: boolean
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing
}
