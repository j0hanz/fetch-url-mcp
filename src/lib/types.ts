export interface IconInfo {
  src: string;
  mimeType: string;
}

export function buildOptionalIcons(
  iconInfo?: IconInfo
): { icons: IconInfo[] } | Record<string, never> {
  if (!iconInfo) return {};
  return {
    icons: [
      {
        src: iconInfo.src,
        mimeType: iconInfo.mimeType,
      },
    ],
  };
}
