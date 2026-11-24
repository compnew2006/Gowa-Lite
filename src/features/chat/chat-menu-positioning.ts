export interface ChatMenuPositionInput {
  anchorX: number;
  anchorY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  isRtl: boolean;
  submenuWidth?: number;
  submenuHeight?: number;
  muteItemTopOffset?: number;
  edgePadding?: number;
}

export interface ChatMenuPosition {
  left: number;
  top: number;
  submenuLeft: number;
  submenuTop: number;
  submenuSide: 'left' | 'right';
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

export function computeChatMenuPosition(input: ChatMenuPositionInput): ChatMenuPosition {
  const {
    anchorX,
    anchorY,
    menuWidth,
    menuHeight,
    viewportWidth,
    viewportHeight,
    isRtl,
    submenuWidth = 176,
    submenuHeight = 148,
    muteItemTopOffset = 44,
    edgePadding = 8,
  } = input;

  const maxMenuLeft = Math.max(edgePadding, viewportWidth - menuWidth - edgePadding);
  const maxMenuTop = Math.max(edgePadding, viewportHeight - menuHeight - edgePadding);

  let rawLeft: number;
  if (isRtl) {
    const leftAnchored = anchorX - menuWidth;
    rawLeft = leftAnchored >= edgePadding ? leftAnchored : anchorX;
  } else {
    const rightExpanding = anchorX;
    rawLeft =
      rightExpanding + menuWidth + edgePadding <= viewportWidth
        ? rightExpanding
        : anchorX - menuWidth;
  }
  const left = clamp(rawLeft, edgePadding, maxMenuLeft);

  const preferredTop =
    anchorY + menuHeight + edgePadding <= viewportHeight ? anchorY : anchorY - menuHeight;
  const top = clamp(preferredTop, edgePadding, maxMenuTop);

  const rightSubLeft = left + menuWidth - 4;
  const leftSubLeft = left - submenuWidth + 4;
  const maxSubLeft = Math.max(edgePadding, viewportWidth - submenuWidth - edgePadding);
  const maxSubTop = Math.max(edgePadding, viewportHeight - submenuHeight - edgePadding);

  let submenuSide: 'left' | 'right';
  let rawSubLeft: number;
  if (isRtl) {
    if (leftSubLeft >= edgePadding) {
      submenuSide = 'left';
      rawSubLeft = leftSubLeft;
    } else if (rightSubLeft + submenuWidth + edgePadding <= viewportWidth) {
      submenuSide = 'right';
      rawSubLeft = rightSubLeft;
    } else {
      submenuSide = 'left';
      rawSubLeft = leftSubLeft;
    }
  } else {
    if (rightSubLeft + submenuWidth + edgePadding <= viewportWidth) {
      submenuSide = 'right';
      rawSubLeft = rightSubLeft;
    } else if (leftSubLeft >= edgePadding) {
      submenuSide = 'left';
      rawSubLeft = leftSubLeft;
    } else {
      submenuSide = 'right';
      rawSubLeft = rightSubLeft;
    }
  }

  const submenuLeft = clamp(rawSubLeft, edgePadding, maxSubLeft);
  const submenuTop = clamp(top + muteItemTopOffset, edgePadding, maxSubTop);

  return {
    left,
    top,
    submenuLeft,
    submenuTop,
    submenuSide,
  };
}
