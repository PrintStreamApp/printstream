/** Shared type scale for metadata and user tags displayed beside library items. */
export function metadataChipStyles(compact: boolean) {
  return {
    '--Chip-minHeight': compact ? '15px' : '17px',
    fontSize: compact ? '9px' : '10px',
    maxWidth: '100%'
  }
}
