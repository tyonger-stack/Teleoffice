export type TemplateMenuPlacement = 'above' | 'below'

export interface TemplateMenuLayout {
  placement: TemplateMenuPlacement
  listMaxHeight: number
  menuMaxHeight: number
}

const MENU_EDGE_GAP = 12
const MENU_FIXED_HEIGHT = 104
const MIN_LIST_HEIGHT = 104
const MAX_LIST_HEIGHT = 320
const TEMPLATE_ROW_HEIGHT = 52
const DEFAULT_VISIBLE_ENTRIES = 3

/** Choose a side for the template menu and leave its actions room to stay visible. */
export function computeTemplateMenuLayout({
  cardTop,
  cardBottom,
  viewportHeight,
  entryCount,
}: {
  cardTop: number
  cardBottom: number
  viewportHeight: number
  entryCount?: number
}): TemplateMenuLayout {
  const belowSpace = Math.max(0, viewportHeight - cardBottom - MENU_EDGE_GAP)
  const aboveSpace = Math.max(0, cardTop - MENU_EDGE_GAP)
  const visibleEntries = Math.min(
    DEFAULT_VISIBLE_ENTRIES,
    Math.max(0, entryCount ?? DEFAULT_VISIBLE_ENTRIES),
  )
  const desiredListHeight = Math.max(MIN_LIST_HEIGHT, visibleEntries * TEMPLATE_ROW_HEIGHT)
  const requiredSpace = MENU_FIXED_HEIGHT + desiredListHeight

  let placement: TemplateMenuPlacement
  if (belowSpace >= requiredSpace) {
    placement = 'below'
  } else if (aboveSpace > belowSpace) {
    placement = 'above'
  } else {
    placement = 'below'
  }

  const availableSpace = placement === 'above' ? aboveSpace : belowSpace
  // On exceptionally short viewports, preserve the minimum list and action area.
  const menuMaxHeight = Math.max(availableSpace, MENU_FIXED_HEIGHT + MIN_LIST_HEIGHT)
  const listMaxHeight = Math.max(
    MIN_LIST_HEIGHT,
    Math.min(MAX_LIST_HEIGHT, menuMaxHeight - MENU_FIXED_HEIGHT),
  )

  return { placement, listMaxHeight, menuMaxHeight }
}
