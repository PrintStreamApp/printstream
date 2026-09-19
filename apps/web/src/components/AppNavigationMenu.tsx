/**
 * App-wide secondary navigation collected behind the final kebab in the main
 * navigation row. The shell renders one copy for each responsive nav variant;
 * only the visible variant can be opened.
 */
import React, { type ReactNode } from 'react'
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded'
import {
  Box,
  Dropdown,
  IconButton,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Typography
} from '@mui/joy'
import { listItemDecoratorClasses } from '@mui/joy/ListItemDecorator'
import { sectionTabSx } from '../theme/theme'

interface AppNavigationMenuProps {
  accountLabel?: string
  accountIcon?: ReactNode
  onOpenAccount?: () => void
  workspaceActionLabel?: string
  workspaceContextLabel?: string
  workspaceActionIcon?: ReactNode
  onOpenWorkspaceChooser?: () => void
  workspaceActionDisabled?: boolean
  actions?: ReactNode
  mobile?: boolean
}

/** Renders account and app-wide utility destinations in the main-nav overflow menu. */
export function AppNavigationMenu({
  accountLabel,
  accountIcon,
  onOpenAccount,
  workspaceActionLabel,
  workspaceContextLabel,
  workspaceActionIcon,
  onOpenWorkspaceChooser,
  workspaceActionDisabled = false,
  actions,
  mobile = false
}: AppNavigationMenuProps) {
  if (!onOpenAccount && !onOpenWorkspaceChooser && !actions) return null

  return (
    <Box
      data-app-navigation-menu
      sx={{
        position: 'sticky',
        right: 0,
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        alignSelf: 'center',
        flexShrink: 0,
        px: mobile ? 0.125 : 0.25,
        backgroundColor: 'transparent'
      }}
    >
      <Dropdown>
        <MenuButton
          variant="plain"
          color="neutral"
          size={mobile ? 'lg' : 'md'}
          slots={{ root: IconButton }}
          slotProps={{
            root: {
              'aria-label': 'More'
            }
          }}
          sx={[
            sectionTabSx,
            {
              flex: '0 0 auto',
              minWidth: mobile ? 42 : 56,
              minHeight: mobile ? 42 : 52,
              px: mobile ? 0.125 : 1.25,
              border: 0,
              backgroundColor: 'transparent',
              '& svg': { fontSize: mobile ? 32 : 24 }
            }
          ]}
        >
          <MoreVertRoundedIcon />
        </MenuButton>
        <Menu
          placement={mobile ? 'top-end' : 'bottom-end'}
          size="md"
          sx={{
            minWidth: mobile ? 240 : 220,
            '--ListItem-minHeight': mobile ? '3rem' : '2.75rem',
            [`& .${listItemDecoratorClasses.root}`]: { minInlineSize: '2rem' },
            [`& .${listItemDecoratorClasses.root} svg`]: { fontSize: mobile ? 24 : 22 }
          }}
        >
          {onOpenAccount ? (
            <MenuItem onClick={onOpenAccount}>
              {accountIcon ? <ListItemDecorator>{accountIcon}</ListItemDecorator> : null}
              <Stack spacing={0}>
                <Typography level="body-md">Account</Typography>
                {accountLabel ? <Typography level="body-sm" textColor="text.tertiary">{accountLabel}</Typography> : null}
              </Stack>
            </MenuItem>
          ) : null}
          {onOpenWorkspaceChooser ? (
            <MenuItem disabled={workspaceActionDisabled} onClick={onOpenWorkspaceChooser}>
              {workspaceActionIcon ? <ListItemDecorator>{workspaceActionIcon}</ListItemDecorator> : null}
              <Stack spacing={0}>
                <Typography level="body-md">{workspaceActionLabel ?? 'Switch workspace'}</Typography>
                {workspaceContextLabel && workspaceContextLabel !== workspaceActionLabel ? (
                  <Typography level="body-sm" textColor="text.tertiary">{workspaceContextLabel}</Typography>
                ) : null}
              </Stack>
            </MenuItem>
          ) : null}
          {actions}
        </Menu>
      </Dropdown>
    </Box>
  )
}
