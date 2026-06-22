import { extendTheme } from '@mui/joy/styles'
import { modalDialogAutoScrollStyles } from '../lib/modalDialogLayout'

export interface PrintStreamThemePalette {
  primary: Record<number, string>
  warning: Record<number, string>
  neutral: Record<number, string>
  chrome: {
    surfacePanelStyle: 'legacy' | 'glass'
    bodyBackground: string
    ambientOverlayBase: string
    ambientOverlayGlow: string
    ambientHighlight: string
    ambientSpectrum: string
    shellNavBackground: string
    shellNavBorder: string
    shellNavTopLine: string
    shellNavInsetHighlight: string
    shellNavShadowRing: string
    sectionNavBackground: string
    sectionNavBorder: string
    sectionNavShadowRing: string
    sectionNavText: string
    sectionNavTextHover: string
    sectionNavFocusRing: string
    sectionNavCount: string
    sectionNavSeparator: string
    sectionTabHoverBackground: string
    sectionTabHoverColor: string
    sectionTabSelectedColor: string
    sectionTabSelectedBackground: string
    sectionTabSelectedRing: string
    sectionTabSelectedBorder: string
    modalDialogBackground: string
    modalDialogBorder: string
    primarySoftCardGradientStart: string
    primarySoftCardGradientEnd: string
    surfacePanelBackground: string
    surfacePanelBorder: string
    surfacePanelInsetHighlight: string
    surfacePanelShadow: string
    surfacePanelBackdropFilter: string
    surfacePanelGradient: string
    surfacePanelGlow: string
    surfacePanelEdgeHighlight: string
    tableHeaderBackground: string
    tableRowStripeBackground: string
    tableRowHoverBackground: string
    emptyStateBackground: string
    emptyStateBorder: string
    emptyStateIconBackground: string
    emptyStateIconBorder: string
  }
  background: {
    body: string
    surface: string
    popup: string
    level1: string
    level2: string
    level3: string
  }
  text: {
    primary: string
    secondary: string
    tertiary: string
    icon: string
  }
}

export function buildChromeCssVars(chrome: PrintStreamThemePalette['chrome']): Record<string, string> {
  return {
    '--printstream-body-background': chrome.bodyBackground,
    '--printstream-shell-ambient-overlay-base': chrome.ambientOverlayBase,
    '--printstream-shell-ambient-overlay-glow': chrome.ambientOverlayGlow,
    '--printstream-shell-ambient-highlight': chrome.ambientHighlight,
    '--printstream-shell-ambient-spectrum': chrome.ambientSpectrum,
    '--printstream-shell-nav-background': chrome.shellNavBackground,
    '--printstream-shell-nav-border': chrome.shellNavBorder,
    '--printstream-shell-nav-top-line': chrome.shellNavTopLine,
    '--printstream-shell-nav-inset-highlight': chrome.shellNavInsetHighlight,
    '--printstream-shell-nav-shadow-ring': chrome.shellNavShadowRing,
    '--printstream-section-nav-background': chrome.sectionNavBackground,
    '--printstream-section-nav-border': chrome.sectionNavBorder,
    '--printstream-section-nav-shadow-ring': chrome.sectionNavShadowRing,
    '--printstream-section-nav-text': chrome.sectionNavText,
    '--printstream-section-nav-text-hover': chrome.sectionNavTextHover,
    '--printstream-section-nav-focus-ring': chrome.sectionNavFocusRing,
    '--printstream-section-nav-count': chrome.sectionNavCount,
    '--printstream-section-nav-separator': chrome.sectionNavSeparator,
    '--printstream-section-tab-hover-background': chrome.sectionTabHoverBackground,
    '--printstream-section-tab-hover-color': chrome.sectionTabHoverColor,
    '--printstream-section-tab-selected-color': chrome.sectionTabSelectedColor,
    '--printstream-section-tab-selected-background': chrome.sectionTabSelectedBackground,
    '--printstream-section-tab-selected-ring': chrome.sectionTabSelectedRing,
    '--printstream-section-tab-selected-border': chrome.sectionTabSelectedBorder,
    '--printstream-modal-dialog-background': chrome.modalDialogBackground,
    '--printstream-modal-dialog-border': chrome.modalDialogBorder,
    '--printstream-soft-primary-card-gradient-start': chrome.primarySoftCardGradientStart,
    '--printstream-soft-primary-card-gradient-end': chrome.primarySoftCardGradientEnd,
    '--printstream-surface-panel-background': chrome.surfacePanelBackground,
    '--printstream-surface-panel-border': chrome.surfacePanelBorder,
    '--printstream-surface-panel-inset-highlight': chrome.surfacePanelInsetHighlight,
    '--printstream-surface-panel-shadow': chrome.surfacePanelShadow,
    '--printstream-surface-panel-backdrop-filter': chrome.surfacePanelBackdropFilter,
    '--printstream-surface-panel-gradient': chrome.surfacePanelGradient,
    '--printstream-surface-panel-glow': chrome.surfacePanelGlow,
    '--printstream-surface-panel-edge-highlight': chrome.surfacePanelEdgeHighlight,
    '--printstream-table-header-background': chrome.tableHeaderBackground,
    '--printstream-table-row-stripe-background': chrome.tableRowStripeBackground,
    '--printstream-table-row-hover-background': chrome.tableRowHoverBackground,
    '--printstream-empty-state-background': chrome.emptyStateBackground,
    '--printstream-empty-state-border': chrome.emptyStateBorder,
    '--printstream-empty-state-icon-background': chrome.emptyStateIconBackground,
    '--printstream-empty-state-icon-border': chrome.emptyStateIconBorder
  }
}

function buildSoftControlStyles(color: string) {
  return {
    backgroundColor: `var(--joy-palette-${color}-700, var(--joy-palette-neutral-700))`,
    color: `var(--joy-palette-${color}-100, var(--joy-palette-neutral-100))`,
    border: `1px solid var(--joy-palette-${color}-600, var(--joy-palette-neutral-600))`,
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
    '&:hover': {
      backgroundColor: `var(--joy-palette-${color}-600, var(--joy-palette-neutral-600))`
    },
    '&:active': {
      backgroundColor: `var(--joy-palette-${color}-500, var(--joy-palette-neutral-500))`
    },
    '&.Mui-disabled': {
      backgroundColor: 'var(--joy-palette-neutral-800)',
      color: 'var(--joy-palette-neutral-500)',
      borderColor: 'var(--joy-palette-neutral-700)',
      boxShadow: 'none'
    }
  }
}

function buildLegacyCardSurfaceStyles() {
  return {
    backgroundColor: 'var(--joy-palette-background-surface)',
    borderColor: 'var(--joy-palette-neutral-700)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)'
  }
}

function buildGlassSurfaceStyles() {
  return {
    backgroundColor: 'var(--printstream-surface-panel-background)',
    backgroundImage: [
      'var(--printstream-surface-panel-gradient)',
      'var(--printstream-surface-panel-glow)',
      'linear-gradient(180deg, var(--printstream-surface-panel-edge-highlight) 0%, transparent 32%)'
    ].join(', '),
    backgroundOrigin: 'border-box',
    backgroundClip: 'padding-box, border-box, border-box',
    border: '1px solid var(--printstream-surface-panel-border)',
    boxShadow: [
      'inset 0 1px 0 var(--printstream-surface-panel-inset-highlight)',
      'var(--printstream-surface-panel-shadow)'
    ].join(', '),
    backdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
    WebkitBackdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
    position: 'relative',
    overflow: 'hidden'
  }
}

function buildLegacySoftCardStyles(color?: string) {
  if (color === 'primary') {
    return {
      background: 'linear-gradient(180deg, var(--printstream-soft-primary-card-gradient-start), var(--printstream-soft-primary-card-gradient-end))',
      border: '1px solid var(--joy-palette-primary-600)',
      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)'
    }
  }

  return {
    backgroundColor: 'var(--joy-palette-background-level1)',
    border: '1px solid var(--joy-palette-neutral-700)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.03)'
  }
}

function buildSoftAlertStyles(color: string) {
  return {
    backgroundColor: `color-mix(in srgb, var(--joy-palette-${color}-700, var(--joy-palette-neutral-700)) 16%, var(--printstream-surface-panel-background))`,
    border: `1px solid color-mix(in srgb, var(--joy-palette-${color}-400, var(--joy-palette-neutral-400)) 26%, var(--printstream-surface-panel-border))`,
    boxShadow: [
      'inset 0 1px 0 var(--printstream-surface-panel-inset-highlight)',
      'var(--printstream-surface-panel-shadow)'
    ].join(', '),
    backdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
    WebkitBackdropFilter: 'var(--printstream-surface-panel-backdrop-filter)'
  }
}

export function createAppTheme(palette: PrintStreamThemePalette) {
  const usesGlassSurfacePanels = palette.chrome.surfacePanelStyle === 'glass'

  return extendTheme({
    fontFamily: {
      body: 'IBM Plex Sans, sans-serif',
      display: 'Space Grotesk, sans-serif'
    },
    // Thin the weights a notch for IBM Plex Sans, which reads heavier than the old
    // system fallback: medium (titles/medium UI) 500 -> 400, and bold (buttons/bold
    // text, Joy's `lg`) 600 -> 500. Still one step of contrast between them.
    fontWeight: {
      md: 400,
      lg: 500
    },
    components: ({
      JoyButton: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            const color = ownerState.color ?? 'neutral'
            if (ownerState.variant === 'soft') {
              return buildSoftControlStyles(color)
            }
            if (ownerState.variant !== 'outlined') {
              return {}
            }
            return {
              backgroundColor: `var(--joy-palette-${color}-800, var(--joy-palette-neutral-800))`,
              borderColor: `var(--joy-palette-${color}-600, var(--joy-palette-neutral-600))`,
              boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)',
              '&:hover': {
                backgroundColor: `var(--joy-palette-${color}-700, var(--joy-palette-neutral-700))`
              },
              '&:active': {
                backgroundColor: `var(--joy-palette-${color}-600, var(--joy-palette-neutral-600))`
              },
              '&.Mui-disabled': {
                backgroundColor: 'var(--joy-palette-neutral-800)',
                borderColor: 'var(--joy-palette-neutral-700)'
              }
            }
          }
        }
      },
      JoyIconButton: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            if (ownerState.variant !== 'soft') return {}
            return buildSoftControlStyles(ownerState.color ?? 'neutral')
          }
        }
      },
      JoyButtonGroup: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            const color = ownerState.color ?? 'neutral'
            // Joy colors the 1px separator between grouped buttons with the
            // palette's OUTLINED border color regardless of the group's variant.
            // This theme's soft controls use a `${color}-700` background (see
            // buildSoftControlStyles) — the same shade — so soft groups (split
            // buttons, toolbars) lost their separators entirely. Pick a shade per
            // variant that contrasts with that variant's actual background.
            const shade = ownerState.variant === 'soft' ? 500 : ownerState.variant === 'solid' ? 700 : 600
            return {
              '--ButtonGroup-separatorColor': `var(--joy-palette-${color}-${shade}, var(--joy-palette-neutral-${shade}))`
            }
          }
        }
      },
      JoyChip: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            if (ownerState.variant !== 'soft') return {}
            return buildSoftControlStyles(ownerState.color ?? 'neutral')
          }
        }
      },
      JoyTabs: {
        styleOverrides: {
          root: {
            '--Tab-indicatorThickness': '0px'
          }
        }
      },
      JoyTabList: {
        defaultProps: {
          disableUnderline: true
        },
        styleOverrides: {
          root: usesGlassSurfacePanels
            ? {
                gap: '0.375rem',
                padding: '0.375rem',
                borderRadius: 'var(--joy-radius-md)',
                backgroundColor: 'var(--printstream-surface-panel-background)',
                border: '1px solid var(--printstream-surface-panel-border)',
                boxShadow: [
                  'inset 0 1px 0 var(--printstream-surface-panel-inset-highlight)',
                  'var(--printstream-surface-panel-shadow)'
                ].join(', '),
                backdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
                WebkitBackdropFilter: 'var(--printstream-surface-panel-backdrop-filter)'
              }
            : {
                gap: '0.375rem',
                padding: '0.375rem',
                borderRadius: 'var(--joy-radius-md)',
                backgroundColor: 'color-mix(in srgb, var(--joy-palette-background-level1) 82%, transparent)',
                border: '1px solid var(--joy-palette-neutral-700)',
                boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.04)'
              }
        }
      },
      JoyTab: {
        styleOverrides: {
          root: {
            minHeight: '2.75rem',
            paddingInline: '0.95rem',
            borderRadius: 'var(--joy-radius-md)',
            color: 'var(--joy-palette-neutral-300)',
            fontWeight: 'var(--joy-fontWeight-md)',
            lineHeight: 1.2,
            transition: 'background-color 180ms ease, color 180ms ease, box-shadow 180ms ease, border-color 180ms ease',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.04)',
              color: 'var(--joy-palette-neutral-100)'
            },
            '&.Mui-selected': {
              color: 'var(--joy-palette-primary-100)',
              backgroundColor: 'rgba(20, 136, 106, 0.22)',
              boxShadow: 'inset 0 0 0 1px rgba(141, 255, 216, 0.18)'
            }
          }
        }
      },
      JoyCard: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            if (ownerState.variant === 'outlined') {
              return usesGlassSurfacePanels ? buildGlassSurfaceStyles() : buildLegacyCardSurfaceStyles()
            }
            if (ownerState.variant === 'soft') {
              if (!usesGlassSurfacePanels) {
                return buildLegacySoftCardStyles(ownerState.color)
              }

              if (ownerState.color === 'primary') {
                return {
                  backgroundImage: [
                    'linear-gradient(180deg, var(--printstream-soft-primary-card-gradient-start), var(--printstream-soft-primary-card-gradient-end))',
                    'var(--printstream-surface-panel-glow)',
                    'linear-gradient(180deg, var(--printstream-surface-panel-edge-highlight) 0%, transparent 32%)'
                  ].join(', '),
                  backgroundColor: 'var(--printstream-surface-panel-background)',
                  border: '1px solid var(--joy-palette-primary-600)',
                  boxShadow: [
                    'inset 0 1px 0 var(--printstream-surface-panel-inset-highlight)',
                    'var(--printstream-surface-panel-shadow)'
                  ].join(', '),
                  backdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
                  WebkitBackdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
                  position: 'relative',
                  overflow: 'hidden'
                }
              }
              return {
                ...buildGlassSurfaceStyles(),
                backgroundColor: 'color-mix(in srgb, var(--printstream-surface-panel-background) 82%, var(--joy-palette-background-level1))'
              }
            }
            return {}
          }
        }
      },
      JoyAvatar: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            if (ownerState.variant !== 'soft') {
              return {}
            }
            const color = ownerState.color ?? 'neutral'
            return {
              backgroundColor: `var(--joy-palette-${color}-700, var(--joy-palette-neutral-700))`,
              color: `var(--joy-palette-${color}-100, var(--joy-palette-neutral-100))`,
              border: `1px solid var(--joy-palette-${color}-600, var(--joy-palette-neutral-600))`,
              boxShadow: '0 0 0 1px rgba(7, 11, 20, 0.24)'
            }
          }
        }
      },
      JoySheet: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            if (ownerState.variant === 'outlined') {
              return usesGlassSurfacePanels
                ? buildGlassSurfaceStyles()
                : {
                    backgroundColor: 'var(--joy-palette-background-level2)',
                    borderColor: 'var(--joy-palette-neutral-700)',
                    boxShadow: 'none'
                  }
            }
            if (ownerState.variant === 'soft') {
              if (!usesGlassSurfacePanels) {
                return {
                  backgroundColor: 'var(--joy-palette-background-level2)',
                  border: '1px solid var(--joy-palette-neutral-700)',
                  boxShadow: 'none'
                }
              }

              return {
                ...buildGlassSurfaceStyles(),
                backgroundColor: 'color-mix(in srgb, var(--printstream-surface-panel-background) 74%, var(--joy-palette-background-level2))'
              }
            }
            return {}
          }
        }
      },
      JoyAlert: {
        styleOverrides: {
          root: ({ ownerState }: { ownerState: { color?: string; variant?: string } }) => {
            if (!usesGlassSurfacePanels || ownerState.variant !== 'soft') return {}
            return buildSoftAlertStyles(ownerState.color ?? 'neutral')
          }
        }
      },
      JoyTable: {
        styleOverrides: {
          root: usesGlassSurfacePanels
            ? {
                '--TableCell-headBackground': 'var(--printstream-table-header-background)',
                '--TableCell-selectedBackground': 'var(--printstream-table-row-hover-background)',
                borderRadius: 'var(--joy-radius-md)',
                overflow: 'hidden',
                backgroundColor: 'transparent',
                '& thead th': {
                  backgroundColor: 'var(--printstream-table-header-background)',
                  backdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
                  WebkitBackdropFilter: 'var(--printstream-surface-panel-backdrop-filter)',
                  borderColor: 'var(--printstream-surface-panel-border)'
                },
                '& tbody td, & tbody th': {
                  borderColor: 'color-mix(in srgb, var(--printstream-surface-panel-border) 76%, transparent)'
                },
                '& tbody tr:nth-of-type(odd) td, & tbody tr:nth-of-type(odd) th': {
                  backgroundColor: 'var(--printstream-table-row-stripe-background)'
                },
                '& tbody tr:hover td, & tbody tr:hover th': {
                  backgroundColor: 'var(--printstream-table-row-hover-background)'
                }
              }
            : {}
        }
      },
      JoyStack: {
        defaultProps: {
          useFlexGap: true
        }
      },
      JoyModalDialog: {
        styleOverrides: {
          root: {
            ...modalDialogAutoScrollStyles,
            backgroundColor: 'var(--printstream-modal-dialog-background)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderColor: 'var(--printstream-modal-dialog-border)',
            boxShadow: 'var(--printstream-surface-panel-shadow)'
          }
        }
      },
      JoyDialogContent: {
        styleOverrides: {
          root: {
            flex: '0 0 auto',
            overflow: 'visible'
          }
        }
      },
      JoyDialogActions: {
        styleOverrides: {
          root: {
            flexDirection: 'row',
            justifyContent: 'flex-end'
          }
        }
      },
      JoyTooltip: {
        defaultProps: {
          variant: 'outlined',
          arrow: true,
          placement: 'top',
          enterDelay: 150,
          enterNextDelay: 150
        },
        styleOverrides: {
          root: {
            backgroundColor: 'var(--joy-palette-background-popup)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            borderColor: 'var(--joy-palette-neutral-700)',
            color: 'var(--joy-palette-text-primary)',
            boxShadow: '0 8px 24px -12px rgba(0, 0, 0, 0.6)'
          },
          arrow: {
            '--Tooltip-arrowColor': 'var(--joy-palette-background-popup)' as string
          }
        }
      },
      JoyMenu: {
        styleOverrides: {
          root: {
            maxWidth: 'calc(100vw - 24px)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            '& [role="menuitem"]': {
              minWidth: 0,
              maxWidth: '100%'
            },
            '& [role="menuitem"] .MuiTypography-root': {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }
          }
        }
      },
      JoyMenuItem: {
        styleOverrides: {
          root: {
            minWidth: 0,
            maxWidth: 'calc(100vw - 24px)',
            overflow: 'hidden',
            '& > *': {
              minWidth: 0
            }
          }
        }
      },
      JoySelect: {
        defaultProps: {
          slotProps: {
            listbox: {
              placement: 'bottom-start'
            }
          }
        },
        styleOverrides: {
          listbox: {
            minWidth: 0,
            maxWidth: 'calc(100vw - 24px)',
            maxHeight: 'min(40vh, 280px)',
            overflow: 'auto'
          }
        }
      },
      JoyOption: {
        styleOverrides: {
          root: {
            minWidth: 0,
            maxWidth: 'calc(100vw - 24px)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            '& > *': {
              minWidth: 0
            },
            '& .MuiTypography-root': {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }
          }
        }
      }
    }) as never,
    colorSchemes: {
      dark: {
        palette
      }
    }
  })
}