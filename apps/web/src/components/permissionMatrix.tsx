/* eslint-disable react-refresh/only-export-components -- matrix UI is intentionally co-located with the pure permission-tree logic and shared types it consumes. */
/**
 * Permission tree/matrix UI and the pure logic that backs it: grouping
 * permissions into ordered sections, nesting them by same-section prerequisites,
 * and resolving prerequisite/dependent permission sets when a checkbox toggles.
 * The `RolePermissionsMatrix` table compares roles, `PermissionTreeNode` renders
 * a single nested permission checkbox, and `PermissionDependencyPopover` prompts
 * for cross-section grants/removals. Consumed by `AuthAccessSection` and its
 * editor dialogs.
 */
import {
  Box,
  Button,
  Checkbox,
  Chip,
  IconButton,
  Sheet,
  Stack,
  Table,
  Tooltip,
  Typography
} from '@mui/joy'
import { Popper } from '@mui/base/Popper'
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded'
import EditRoundedIcon from '@mui/icons-material/EditRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import VisibilityRoundedIcon from '@mui/icons-material/VisibilityRounded'
import {
  type AuthGroup,
  type Permission,
  type PermissionDefinition,
  getPermissionPrerequisites,
  resolveImpliedPermissions
} from '@printstream/shared'
import React from 'react'
import { useMemo, useState } from 'react'
import { orderGroupsForDisplay, summarizeRoleFlags, toggleCollapsedSection } from './authAccessHelpers'
import { HorizontalOverflowScroller } from './HorizontalOverflowScroller'

export type PermissionSection = {
  title: string
  permissions: PermissionDefinition[]
}

export type PermissionSectionRows = {
  title: string
  rows: FlattenedPermissionTreeRow[]
}

export interface PermissionTreeNodeData {
  definition: PermissionDefinition
  children: PermissionTreeNodeData[]
}

export interface FlattenedPermissionTreeRow {
  definition: PermissionDefinition
  depth: number
}

export type PermissionPromptAnchor = HTMLElement

export interface PermissionPrerequisitePrompt {
  action: 'add' | 'remove'
  anchorEl: PermissionPromptAnchor | null
  permission: Permission
  affectedPermissions: Permission[]
}

export function RolePermissionsMatrix({
  groups,
  permissionSections,
  permissionLabelByKey,
  canDeleteRoles,
  onOpenRole,
  onDeleteRole
}: {
  groups: AuthGroup[]
  permissionSections: PermissionSection[]
  permissionLabelByKey: Map<Permission, string>
  canDeleteRoles: boolean
  onOpenRole: (groupId: string) => void
  onDeleteRole: (group: AuthGroup) => void
}) {
  const [showBuiltInRoles, setShowBuiltInRoles] = useState(true)
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const permissionColumnMinWidth = 176
  const roleColumnWidth = 132
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])
  const visibleGroups = useMemo(
    () => showBuiltInRoles ? orderedGroups : orderedGroups.filter((group) => !group.isSystem),
    [orderedGroups, showBuiltInRoles]
  )
  const permissionRowsBySection = useMemo<PermissionSectionRows[]>(
    () => permissionSections.map((section) => ({
      title: section.title,
      rows: flattenPermissionTree(buildPermissionTree(section.permissions))
    })),
    [permissionSections]
  )
  const permissionSetByGroup = new Map(visibleGroups.map((group) => [group.id, new Set(group.permissions)] as const))

  if (visibleGroups.length === 0) {
    return (
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="flex-end">
          <Button size="sm" variant="soft" color="neutral" onClick={() => setShowBuiltInRoles(true)}>
            Show built-in roles
          </Button>
        </Stack>
        <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
          <Typography level="body-sm" textColor="text.tertiary">
            Built-in roles are hidden. Show them again to compare their permissions.
          </Typography>
        </Sheet>
      </Stack>
    )
  }

  return (
    <Stack spacing={1}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
      >
        <Typography level="body-xs" textColor="text.tertiary">
          Built-in roles stay grouped first. Custom roles follow after them.
        </Typography>
        <Button
          size="sm"
          variant="soft"
          color="neutral"
          onClick={() => setShowBuiltInRoles((current) => !current)}
        >
          {showBuiltInRoles ? 'Hide built-in roles' : 'Show built-in roles'}
        </Button>
      </Stack>

      <Sheet variant="outlined" sx={{ borderRadius: 'md', overflow: 'hidden' }}>
        <Box>
          <HorizontalOverflowScroller fadeColor="var(--joy-palette-background-surface)" hideScrollbar={false}>
            <Table
              stickyHeader
              borderAxis="bothBetween"
              sx={{
                '--TableCell-headBackground': 'var(--joy-palette-background-level1)',
                minWidth: `${permissionColumnMinWidth + (visibleGroups.length * roleColumnWidth)}px`,
                '& tbody th[scope="row"]': {
                  whiteSpace: 'normal',
                  textOverflow: 'clip',
                  overflow: 'visible',
                  height: 'auto',
                  verticalAlign: 'top'
                }
              }}
            >
            <thead>
              <tr>
                <th style={{ minWidth: `${permissionColumnMinWidth}px` }}>Permission</th>
                {visibleGroups.map((group) => (
                  <th key={group.id} style={{ width: `${roleColumnWidth}px`, verticalAlign: 'top' }}>
                    <Stack spacing={0.75} sx={{ py: 0.5 }}>
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography level="title-sm" sx={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>
                          {group.name}
                        </Typography>
                        <Tooltip
                          arrow
                          placement="top"
                          title={(
                            <Stack spacing={0.5} sx={{ py: 0.25, maxWidth: 240 }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              <Typography level="body-xs">
                                {group.description?.trim() || 'No description yet.'}
                              </Typography>
                              <Typography level="body-xs" textColor="text.tertiary">
                                {summarizeRoleFlags(group)}
                              </Typography>
                            </Stack>
                          )}
                        >
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="neutral"
                            aria-label={`About ${group.name} role`}
                            sx={{ flexShrink: 0 }}
                          >
                            <InfoOutlinedIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        <Chip size="sm" variant="soft" color="neutral">
                          {group.permissions.length} perm{group.permissions.length === 1 ? '' : 's'}
                        </Chip>
                        <Chip size="sm" variant="soft" color="neutral">
                          {group.userCount} user{group.userCount === 1 ? '' : 's'}
                        </Chip>
                      </Stack>
                      <Stack direction="row" spacing={0.25} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        <Tooltip title={group.isEditable ? `Edit ${group.name}` : `View ${group.name}`} arrow placement="top">
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="neutral"
                            aria-label={group.isEditable && group.canManage ? `Edit ${group.name}` : `View ${group.name}`}
                            onClick={() => onOpenRole(group.id)}
                          >
                            {group.isEditable && group.canManage ? <EditRoundedIcon /> : <VisibilityRoundedIcon />}
                          </IconButton>
                        </Tooltip>
                        {group.isRemovable && canDeleteRoles && group.canManage && (
                          <Tooltip title={`Delete ${group.name}`} arrow placement="top">
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="danger"
                              aria-label={`Delete ${group.name}`}
                              onClick={() => onDeleteRole(group)}
                            >
                              <DeleteRoundedIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    </Stack>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissionRowsBySection.map((section) => (
                <React.Fragment key={section.title}>
                  <tr>
                    <th colSpan={visibleGroups.length + 1} style={{ background: 'var(--joy-palette-background-level1)' }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} useFlexGap>
                        <Button
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={() => setCollapsedSections((current) => toggleCollapsedSection(current, section.title))}
                          aria-label={`${collapsedSections.has(section.title) ? 'Expand' : 'Collapse'} ${section.title} group`}
                          startDecorator={collapsedSections.has(section.title) ? <KeyboardArrowRightRoundedIcon /> : <KeyboardArrowDownRoundedIcon />}
                          sx={{ px: 0, justifyContent: 'flex-start' }}
                        >
                          {section.title}
                        </Button>
                        <Chip size="sm" variant="soft" color="neutral">
                          {section.rows.length}
                        </Chip>
                      </Stack>
                    </th>
                  </tr>
                  {!collapsedSections.has(section.title) && section.rows.map(({ definition, depth }) => (
                    <tr key={definition.key}>
                      <th scope="row" style={{ minWidth: `${permissionColumnMinWidth}px` }}>
                        <Stack
                          direction="row"
                          spacing={0.5}
                          alignItems="center"
                          data-depth={depth + 1}
                          sx={{ py: 0.25, minWidth: 0, pl: (depth + 1) * 2 }}
                        >
                          <Typography level="body-sm" sx={{ minWidth: 0, flex: 1, whiteSpace: 'normal', wordBreak: 'break-word' }}>
                            {permissionLabelByKey.get(definition.key) ?? definition.label}
                          </Typography>
                          <Tooltip
                            arrow
                            placement="top-start"
                            title={(
                              <Stack spacing={0.5} sx={{ py: 0.25, maxWidth: 240 }}>
                                <Typography level="title-sm">{permissionLabelByKey.get(definition.key) ?? definition.label}</Typography>
                                <Typography level="body-xs">
                                  {definition.description}
                                </Typography>
                              </Stack>
                            )}
                          >
                            <IconButton
                              size="sm"
                              variant="plain"
                              color="neutral"
                              aria-label={`About ${permissionLabelByKey.get(definition.key) ?? definition.label} permission`}
                              sx={{ flexShrink: 0 }}
                            >
                              <InfoOutlinedIcon />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </th>
                      {visibleGroups.map((group) => {
                        const granted = permissionSetByGroup.get(group.id)?.has(definition.key) ?? false
                        return (
                          <td key={`${group.id}:${definition.key}`}>
                            <Chip size="sm" variant={granted ? 'soft' : 'outlined'} color={granted ? 'success' : 'neutral'}>
                              {granted ? 'Yes' : '--'}
                            </Chip>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
            </Table>
          </HorizontalOverflowScroller>
        </Box>
      </Sheet>
    </Stack>
  )
}

/**
 * Builds a tree of permissions within a section. A permission is a child if its
 * only same-section prerequisite is a single permission (its parent). Permissions
 * with multiple same-section prerequisites or no same-section prerequisites are roots.
 */
export function buildPermissionTree(definitions: PermissionDefinition[]): PermissionTreeNodeData[] {
  const sectionKeys = new Set(definitions.map((d) => d.key))
  const childToParent = new Map<Permission, Permission>()

  for (const definition of definitions) {
    const prereqs = getPermissionPrerequisites(definition.key)
    const sameSectionPrereqs = prereqs.filter((p) => sectionKeys.has(p))
    // Only nest if there's exactly one same-section parent
    if (sameSectionPrereqs.length === 1) {
      childToParent.set(definition.key, sameSectionPrereqs[0]!)
    }
  }

  // First pass: create all nodes
  const nodeMap = new Map<Permission, PermissionTreeNodeData>()
  for (const definition of definitions) {
    nodeMap.set(definition.key, { definition, children: [] })
  }

  // Second pass: assign children to parents
  const roots: PermissionTreeNodeData[] = []
  for (const definition of definitions) {
    const node = nodeMap.get(definition.key)!
    const parent = childToParent.get(definition.key)
    if (parent) {
      nodeMap.get(parent)?.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

export function flattenPermissionTree(nodes: PermissionTreeNodeData[], depth = 0): FlattenedPermissionTreeRow[] {
  return nodes.flatMap((node) => [
    { definition: node.definition, depth },
    ...flattenPermissionTree(node.children, depth + 1)
  ])
}

export function PermissionTreeNode({
  node,
  depth,
  selectedPermissions,
  disabled,
  assignablePermissionSet,
  permissionLabelMap,
  sectionKeys,
  onToggle
}: {
  node: PermissionTreeNodeData
  depth: number
  selectedPermissions: Permission[]
  disabled: boolean
  assignablePermissionSet: ReadonlySet<Permission>
  permissionLabelMap: Map<Permission, string>
  sectionKeys: Permission[]
  onToggle: (permission: Permission, checked: boolean, anchorEl: PermissionPromptAnchor | null) => void
}) {
  const { definition } = node
  const prerequisites = getPermissionPrerequisites(definition.key)
  const crossSectionPrereqs = prerequisites.filter((p) => !sectionKeys.includes(p))

  return (
    <Stack spacing={0.5} sx={depth > 0 ? { pl: 3 } : undefined}>
      <Checkbox
        size="sm"
        checked={selectedPermissions.includes(definition.key)}
        disabled={disabled || !assignablePermissionSet.has(definition.key)}
        onChange={(event) => onToggle(definition.key, event.target.checked, resolvePermissionAnchor(event.currentTarget))}
        label={(
          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <Typography level="title-sm">{definition.label}</Typography>
              {!assignablePermissionSet.has(definition.key) && (
                <Chip size="sm" variant="soft" color="warning">Higher access</Chip>
              )}
              {crossSectionPrereqs.map((prereq) => (
                <Chip key={prereq} size="sm" variant="soft" color="neutral">
                  Requires {permissionLabelMap.get(prereq) ?? prereq}
                </Chip>
              ))}
            </Stack>
            <Typography level="body-xs" textColor="text.tertiary">
              {definition.description}
            </Typography>
          </Stack>
        )}
        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
      />
      {node.children.map((child) => (
        <PermissionTreeNode
          key={child.definition.key}
          node={child}
          depth={depth + 1}
          selectedPermissions={selectedPermissions}
          disabled={disabled}
          assignablePermissionSet={assignablePermissionSet}
          permissionLabelMap={permissionLabelMap}
          sectionKeys={sectionKeys}
          onToggle={onToggle}
        />
      ))}
    </Stack>
  )
}

export function resolveMissingPrerequisites(permission: Permission, selectedPermissions: readonly Permission[]): Permission[] {
  return resolveImpliedPermissions([permission]).filter((entry) => !selectedPermissions.includes(entry))
}

export function resolvePermissionAnchor(input: EventTarget & HTMLInputElement): PermissionPromptAnchor {
  if (input.parentElement?.parentElement instanceof HTMLElement) {
    return input.parentElement.parentElement
  }
  if (input.parentElement instanceof HTMLElement) {
    return input.parentElement
  }
  return input
}

export function resolveDependentRemovals(permission: Permission, selectedPermissions: readonly Permission[]): Permission[] {
  const remaining = new Set(selectedPermissions.filter((entry) => entry !== permission))
  const removed = new Set<Permission>()
  let changed = true

  while (changed) {
    changed = false
    for (const candidate of [...remaining]) {
      const prerequisites = getPermissionPrerequisites(candidate)
      if (prerequisites.some((entry) => !remaining.has(entry))) {
        remaining.delete(candidate)
        removed.add(candidate)
        changed = true
      }
    }
  }

  return selectedPermissions.filter((entry) => removed.has(entry))
}

export function addPermissions(current: readonly Permission[], additions: readonly Permission[]): Permission[] {
  const next = new Set(current)
  for (const permission of additions) {
    next.add(permission)
  }
  return [...next]
}

export function PermissionDependencyPopover({
  prompt,
  permissionLabelMap,
  confirmLabel,
  onClose,
  onConfirm
}: {
  prompt: PermissionPrerequisitePrompt | null
  permissionLabelMap: Map<Permission, string>
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  const [arrowEl, setArrowEl] = useState<HTMLSpanElement | null>(null)

  if (!prompt) return null

  return (
    <Popper
      open
      anchorEl={prompt.anchorEl}
      placement="right"
      modifiers={[
        {
          name: 'offset',
          options: { offset: [0, 10] }
        },
        {
          name: 'arrow',
          options: { element: arrowEl }
        },
        {
          name: 'flip',
          options: { padding: 8 }
        },
        {
          name: 'preventOverflow',
          options: { padding: 8 }
        }
      ]}
      style={{ zIndex: 1600 }}
    >
      <Box sx={{ position: 'relative' }}>
        <Box
          ref={setArrowEl}
          sx={{
            position: 'absolute',
            width: 12,
            height: 12,
            bgcolor: 'background.surface',
            borderTop: '1px solid',
            borderLeft: '1px solid',
            borderColor: 'divider',
            transform: 'rotate(45deg)',
            zIndex: 0,
            '[data-popper-placement*="right"] &': {
              left: -6,
              top: 'calc(50% - 6px)'
            },
            '[data-popper-placement*="left"] &': {
              right: -6,
              top: 'calc(50% - 6px)',
              transform: 'rotate(225deg)'
            },
            '[data-popper-placement*="top"] &': {
              bottom: -6,
              left: 'calc(50% - 6px)',
              transform: 'rotate(135deg)'
            },
            '[data-popper-placement*="bottom"] &': {
              top: -6,
              left: 'calc(50% - 6px)',
              transform: 'rotate(-45deg)'
            }
          }}
        />
        <Sheet variant="outlined" sx={{ p: 1.25, borderRadius: 'md', boxShadow: 'lg', maxWidth: 320, position: 'relative', zIndex: 1 }}>
          <Stack spacing={1}>
            <Typography level="title-sm">
              {prompt.action === 'add' ? 'Grant required permissions?' : 'Remove dependent permissions?'}
            </Typography>
            <Typography level="body-sm">
              {permissionLabelMap.get(prompt.permission) ?? prompt.permission}
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {prompt.action === 'add'
                ? 'This selection also requires permissions in other sections.'
                : 'Removing this permission also removes dependent permissions that no longer have their required parents.'}
            </Typography>
            <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {prompt.affectedPermissions.map((permission) => (
                <Chip key={permission} size="sm" variant="soft" color="primary">
                  {permissionLabelMap.get(permission) ?? permission}
                </Chip>
              ))}
            </Stack>
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button size="sm" variant="plain" color="neutral" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={onConfirm}>{confirmLabel}</Button>
            </Stack>
          </Stack>
        </Sheet>
      </Box>
    </Popper>
  )
}

export function buildPermissionSections(definitions: PermissionDefinition[]): PermissionSection[] {
  const order = [
    'Platform',
    'Authentication',
    'Printers & Devices',
    'Library',
    'Jobs',
    'Plugins',
    'Settings',
    'Other'
  ] as const
  const grouped = new Map<string, PermissionDefinition[]>()

  for (const definition of definitions) {
    const title = permissionSectionTitle(definition.key)
    const existing = grouped.get(title)
    if (existing) {
      existing.push(definition)
      continue
    }
    grouped.set(title, [definition])
  }

  return order.flatMap((title) => {
    const permissions = grouped.get(title)
    return permissions ? [{ title, permissions }] : []
  })
}

export function permissionSectionTitle(permission: Permission): string {
  if (permission === 'tenants.manage' || permission === 'tenants.disable') return 'Platform'
  if (permission.startsWith('auth.')) return 'Authentication'
  if (
    permission.startsWith('camera.')
    || permission.startsWith('printerStorage.')
    || permission.startsWith('printers.')
    || permission.startsWith('prints.dispatch')
  ) {
    return 'Printers & Devices'
  }
  if (permission.startsWith('library.')) return 'Library'
  if (permission.startsWith('jobs.')) return 'Jobs'
  if (permission.startsWith('plugins.')) return 'Plugins'
  if (permission.startsWith('settings.')) return 'Settings'
  return 'Other'
}
