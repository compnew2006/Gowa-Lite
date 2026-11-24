export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface FloatingPickerPosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

export function computeFloatingPickerPosition({
  triggerRect,
  pickerSize,
  viewport,
  alignEnd,
  gap = 8,
  edgePadding = 8,
  minTop = 64,
}: {
  triggerRect: RectLike;
  pickerSize: {width: number; height: number};
  viewport: {width: number; height: number};
  alignEnd: boolean;
  gap?: number;
  edgePadding?: number;
  minTop?: number;
}): FloatingPickerPosition {
  const aboveTop = triggerRect.top - pickerSize.height - gap;
  const canPlaceAbove = aboveTop >= minTop;
  const rawTop = canPlaceAbove ? aboveTop : triggerRect.bottom + gap;
  const maxTop = Math.max(edgePadding, viewport.height - pickerSize.height - edgePadding);
  const top = Math.min(Math.max(edgePadding, rawTop), maxTop);

  const rawLeft = alignEnd ? triggerRect.right - pickerSize.width : triggerRect.left;
  const maxLeft = Math.max(edgePadding, viewport.width - pickerSize.width - edgePadding);
  const left = Math.min(Math.max(edgePadding, rawLeft), maxLeft);

  return {
    top,
    left,
    placement: canPlaceAbove ? 'above' : 'below',
  };
}
