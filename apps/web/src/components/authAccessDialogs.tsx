/**
 * Dialog and overview-card components for the auth-access settings surfaces:
 * support-access action picker, user/role/service-account create and edit
 * dialogs, their delete confirmations, the one-time service-account token
 * reveal, and the management overview cards. Each component is presentational
 * and stateful only in the local-form sense; persistence and mutation wiring
 * live in `AuthAccessSection`. Permission editing reuses the tree/matrix logic
 * from `./permissionMatrix`.
 */
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  ModalClose,
  Sheet,
  Stack,
  Textarea,
  Typography
} from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded'
import KeyboardArrowRightRoundedIcon from '@mui/icons-material/KeyboardArrowRightRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  type AuthBootstrap,
  type AuthGroup,
  type AuthServiceAccount,
  type AuthSessionListResponse,
  type AuthUser,
  type CreateManagedAuthUserRequest,
  type CreateAuthServiceAccountRequest,
  type CreateAuthGroupRequest,
  type Permission,
  type UpdateAuthServiceAccountRequest,
  type UpdateAuthGroupRequest
} from '@printstream/shared'
import { useEffect, useMemo, useState } from 'react'
import {
  formatCount,
  orderGroupsForDisplay,
  type RevealedServiceAccountToken,
  samePermissions,
  sameIds,
  toggleCollapsedSection
} from './authAccessHelpers'
import {
  addPermissions,
  buildPermissionTree,
  type PermissionPromptAnchor,
  type PermissionPrerequisitePrompt,
  type PermissionSection,
  PermissionDependencyPopover,
  PermissionTreeNode,
  resolveDependentRemovals,
  resolveMissingPrerequisites
} from './permissionMatrix'
import { AuthSessionList } from './AuthSessionList'
import { BackAwareModal as Modal } from './BackAwareModal'
import { DialogSection } from './DialogSection'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { webPluginRegistry } from '../plugin/registry'
import { ScrollableDialogBody, ScrollableModalDialog } from './ScrollableDialog'

export function SupportAccessPermissionsDialog({
  open,
  supportAccessEnabled,
  permissionSections,
  selectedPermissions,
  changed,
  canManageSupportAccess,
  saving,
  error,
  onClose,
  onTogglePermission,
  onSave
}: {
  open: boolean
  supportAccessEnabled: boolean
  permissionSections: PermissionSection[]
  selectedPermissions: Permission[]
  changed: boolean
  canManageSupportAccess: boolean
  saving: boolean
  error: string | null
  onClose: () => void
  onTogglePermission: (permission: Permission, checked: boolean) => void
  onSave: () => void
}) {
  const selectedCount = selectedPermissions.length
  const [prerequisitePrompt, setPrerequisitePrompt] = useState<PermissionPrerequisitePrompt | null>(null)

  const allDefinitions = useMemo(
    () => permissionSections.flatMap((s) => s.permissions),
    [permissionSections]
  )
  const permissionLabelMap = useMemo(
    () => new Map(allDefinitions.map((d) => [d.key, d.label])),
    [allDefinitions]
  )
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())

  function handleToggle(permission: Permission, checked: boolean, sectionKeys: Permission[], anchorEl: PermissionPromptAnchor | null) {
    if (checked) {
      const missing = resolveMissingPrerequisites(permission, selectedPermissions)
      const crossSectionMissing = missing.filter((entry) => !sectionKeys.includes(entry))
      if (crossSectionMissing.length > 0) {
        setPrerequisitePrompt({ action: 'add', anchorEl, permission, affectedPermissions: missing })
        return
      }
      if (missing.length > 0) {
        for (const entry of [permission, ...missing]) {
          onTogglePermission(entry, true)
        }
        return
      }
    } else {
      const dependentRemovals = resolveDependentRemovals(permission, selectedPermissions)
      if (dependentRemovals.length > 0) {
        setPrerequisitePrompt({ action: 'remove', anchorEl, permission, affectedPermissions: dependentRemovals })
        return
      }
    }
    onTogglePermission(permission, checked)
  }

  function confirmPrerequisites() {
    if (!prerequisitePrompt) return
    const { action, permission, affectedPermissions } = prerequisitePrompt
    onTogglePermission(permission, action === 'add')
    for (const entry of affectedPermissions) {
      onTogglePermission(entry, action === 'add')
    }
    setPrerequisitePrompt(null)
  }

  return (
    <Modal open={open} onClose={onClose}>
      <>
        <ScrollableModalDialog sx={{ width: 'min(880px, 100%)' }}>
          <ModalClose disabled={saving} />
          <DialogTitle>Allowed support actions</DialogTitle>
          <DialogContent>
            <Stack spacing={0.75}>
              <Typography level="body-sm" textColor="text.tertiary">
                Choose the actions support users can take while they are helping inside this workspace.
              </Typography>
              <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip size="sm" variant="soft" color={selectedCount > 0 ? 'primary' : 'neutral'}>
                  {selectedCount} allowed
                </Chip>
                {!canManageSupportAccess && (
                  <Chip size="sm" variant="soft" color="warning">
                    View only
                  </Chip>
                )}
              </Stack>
            </Stack>
          </DialogContent>

          <ScrollableDialogBody>
            <Stack spacing={1.25}>
              {error && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {error}
                </Alert>
              )}

              {!supportAccessEnabled && (
                <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                  Support access is currently disabled. These action choices will apply the next time you enable it.
                </Alert>
              )}

              {permissionSections.length === 0 ? (
                <Alert color="neutral" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                  No support-manageable actions are available in this workspace yet.
                </Alert>
              ) : permissionSections.map((section) => {
                const isCollapsed = collapsedSections.has(section.title)
                const selectedInSection = section.permissions.filter((permission) => selectedPermissions.includes(permission.key)).length
                const tree = buildPermissionTree(section.permissions)
                const sectionKeys = section.permissions.map((d) => d.key)
                const allAssignable = new Set(section.permissions.map((d) => d.key))

                return (
                  <DialogSection
                    key={section.title}
                    title={section.title}
                    description={`${selectedInSection} of ${section.permissions.length} action${section.permissions.length === 1 ? '' : 's'} allowed.${selectedInSection !== section.permissions.length ? ` ${selectedInSection} selected.` : ''}`}
                  >
                    <Stack spacing={1.25}>
                      <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
                        <Button
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={() => setCollapsedSections((current) => toggleCollapsedSection(current, section.title))}
                          aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${section.title} actions`}
                          startDecorator={isCollapsed ? <KeyboardArrowRightRoundedIcon /> : <KeyboardArrowDownRoundedIcon />}
                          sx={{ px: 0, justifyContent: 'flex-start', minWidth: 0 }}
                        >
                          {isCollapsed ? 'Show actions' : 'Hide actions'}
                        </Button>
                      </Box>

                      {!isCollapsed && (
                        <Stack spacing={0.5}>
                          {tree.map((node) => (
                            <PermissionTreeNode
                              key={node.definition.key}
                              node={node}
                              depth={0}
                              selectedPermissions={selectedPermissions}
                              disabled={!canManageSupportAccess || saving}
                              assignablePermissionSet={allAssignable}
                              permissionLabelMap={permissionLabelMap}
                              sectionKeys={sectionKeys}
                              onToggle={(permission, checked, anchorEl) => handleToggle(permission, checked, sectionKeys, anchorEl)}
                            />
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  </DialogSection>
                )
              })}
            </Stack>
          </ScrollableDialogBody>

          <DialogActions>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={onSave} loading={saving} disabled={!canManageSupportAccess || !changed}>
              Save actions
            </Button>
          </DialogActions>
        </ScrollableModalDialog>

        <PermissionDependencyPopover
          prompt={prerequisitePrompt}
          permissionLabelMap={permissionLabelMap}
          confirmLabel={prerequisitePrompt?.action === 'remove' ? 'Remove all' : 'Grant all'}
          onClose={() => setPrerequisitePrompt(null)}
          onConfirm={confirmPrerequisites}
        />
      </>
    </Modal>
  )
}

export function CreateAuthUserDialog({
  groups,
  canAssignUserRoles,
  error,
  saving,
  onClose,
  onCreate
}: {
  groups: AuthGroup[]
  canAssignUserRoles: boolean
  error: string | null
  saving: boolean
  onClose: () => void
  onCreate: (body: CreateManagedAuthUserRequest) => void
}) {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  const normalizedEmail = email.trim()
  const normalizedDisplayName = displayName.trim() ? displayName.trim() : null
  const sortedSelectedGroupIds = useMemo(
    () => [...selectedGroupIds].sort(),
    [selectedGroupIds]
  )
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      if (checked) {
        return current.includes(groupId) ? current : [...current, groupId]
      }
      return current.filter((entry) => entry !== groupId)
    })
  }

  function handleSubmit() {
    if (normalizedEmail.length === 0) return
    onCreate({
      email: normalizedEmail,
      displayName: normalizedDisplayName,
      groupIds: sortedSelectedGroupIds
    })
  }

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose disabled={saving} />
        <DialogTitle>Create user</DialogTitle>
        <DialogContent>
          <Stack spacing={0.75}>
            <Typography level="body-sm" textColor="text.tertiary">
              Create an auth user account and assign its initial roles. Provider-specific setup actions are available after the user is created.
            </Typography>
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={2}>
            <DialogSection title="User details">
              <Stack spacing={1.25}>
                <FormControl required>
                  <FormLabel>Email</FormLabel>
                  <Input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    disabled={saving}
                    placeholder="name@example.com"
                  />
                </FormControl>

                <FormControl>
                  <FormLabel>Display name</FormLabel>
                  <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    disabled={saving}
                    placeholder="Optional"
                  />
                </FormControl>
              </Stack>
            </DialogSection>

            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}

            {groups.length === 0 ? (
              <Alert color="warning" variant="soft">
                No roles exist yet. This user will be created without any assigned access until you add roles.
              </Alert>
            ) : !canAssignUserRoles ? (
              <Alert color="neutral" variant="soft">
                Assigning roles during user creation requires the Assign User Roles permission.
              </Alert>
            ) : (
              <DialogSection
                title="Initial roles"
                description="Choose the roles this user should start with."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {orderedGroups.map((group) => (
                      <Checkbox
                        key={group.id}
                        checked={sortedSelectedGroupIds.includes(group.id)}
                        disabled={saving || !group.canManage}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        label={(
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              {group.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                              {!group.canManage && <Chip size="sm" variant="soft" color="warning">Higher access</Chip>}
                            </Stack>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {group.description?.trim() || 'No description yet.'}
                            </Typography>
                          </Stack>
                        )}
                        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
                      />
                    ))}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving} disabled={normalizedEmail.length === 0}>
            Create user
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function AuthGroupEditorDialog({
  group,
  creating,
  permissionSections,
  assignablePermissionSet,
  canEditRoleDetails,
  canAssignRolePermissions,
  error,
  saving,
  onClose,
  onCreate,
  onUpdate
}: {
  group: AuthGroup | null
  creating: boolean
  permissionSections: PermissionSection[]
  assignablePermissionSet: ReadonlySet<Permission>
  canEditRoleDetails: boolean
  canAssignRolePermissions: boolean
  error: string | null
  saving: boolean
  onClose: () => void
  onCreate: (body: CreateAuthGroupRequest) => void
  onUpdate: (groupId: string, body: UpdateAuthGroupRequest) => void
}) {
  const permissionDefinitions = permissionSections.flatMap((section) => section.permissions)
  const permissionOrder = useMemo(
    () => new Map(permissionDefinitions.map((definition, index) => [definition.key, index] as const)),
    [permissionDefinitions]
  )
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const [prerequisitePrompt, setPrerequisitePrompt] = useState<PermissionPrerequisitePrompt | null>(null)
  useEffect(() => {
    if (creating) {
      setName('')
      setDescription('')
      setPermissions([])
      return
    }

    if (!group) return
    setName(group.name)
    setDescription(group.description ?? '')
    setPermissions(group.permissions)
  }, [creating, group])

  const canEditMetadata = creating ? canEditRoleDetails : Boolean(group?.isEditable) && group?.canManage && canEditRoleDetails
  const canEditPermissions = creating
    ? canAssignRolePermissions
    : Boolean(group?.isEditable) && group?.canManage && canAssignRolePermissions
  const isEditable = canEditMetadata || canEditPermissions
  const normalizedName = name.trim()
  const normalizedDescription = description.trim() ? description.trim() : null
  const sortedPermissions = useMemo(
    () => [...permissions].sort((left, right) => (permissionOrder.get(left) ?? 0) - (permissionOrder.get(right) ?? 0)),
    [permissionOrder, permissions]
  )
  const hasChanges = creating
    ? normalizedName.length > 0 || normalizedDescription != null || sortedPermissions.length > 0
    : Boolean(
      group
      && (
        normalizedName !== group.name
        || normalizedDescription !== group.description
        || !samePermissions(sortedPermissions, group.permissions)
      )
    )

  const permissionLabelMap = useMemo(
    () => new Map(permissionDefinitions.map((definition) => [definition.key, definition.label])),
    [permissionDefinitions]
  )

  function togglePermission(permission: Permission, checked: boolean, sectionKeys: Permission[], anchorEl: PermissionPromptAnchor | null) {
    if (checked) {
      const missing = resolveMissingPrerequisites(permission, permissions)
      const crossSectionMissing = missing.filter((entry) => !sectionKeys.includes(entry))
      if (crossSectionMissing.length > 0) {
        setPrerequisitePrompt({ action: 'add', anchorEl, permission, affectedPermissions: missing })
        return
      }
      setPermissions((current) => addPermissions(current, [permission, ...missing]))
    } else {
      const dependentRemovals = resolveDependentRemovals(permission, permissions)
      if (dependentRemovals.length > 0) {
        setPrerequisitePrompt({ action: 'remove', anchorEl, permission, affectedPermissions: dependentRemovals })
        return
      }
      setPermissions((current) => current.filter((entry) => entry !== permission))
    }
  }

  function confirmPrerequisites() {
    if (!prerequisitePrompt) return
    const { action, permission, affectedPermissions } = prerequisitePrompt
    setPermissions((current) => {
      if (action === 'add') {
        return addPermissions(current, [permission, ...affectedPermissions])
      }
      const removals = new Set<Permission>([permission, ...affectedPermissions])
      return current.filter((entry) => !removals.has(entry))
    })
    setPrerequisitePrompt(null)
  }

  function handleSubmit() {
    if (!isEditable || normalizedName.length === 0) return
    if (creating) {
      onCreate({
        name: normalizedName,
        description: normalizedDescription,
        permissions: sortedPermissions
      })
      return
    }
    if (!group) return
    const body: UpdateAuthGroupRequest = {}
    if (canEditMetadata) {
      body.name = normalizedName
      body.description = normalizedDescription
    }
    if (canEditPermissions) {
      body.permissions = sortedPermissions
    }
    onUpdate(group.id, body)
  }

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <>
        <ScrollableModalDialog sx={{ width: 'min(880px, 100%)' }}>
          <ModalClose disabled={saving} />
          <DialogTitle>
            {creating
              ? 'Create role'
              : isEditable
                ? `Edit role — ${group?.name ?? 'Role'}`
                : `Role permissions — ${group?.name ?? 'Role'}`}
          </DialogTitle>
          <DialogContent>
            <Stack spacing={1}>
              <Typography level="body-sm" textColor="text.tertiary">
                Roles bundle reusable permissions so users and future service accounts can share the same access policy.
              </Typography>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Chip size="sm" variant="soft" color="primary">
                  {sortedPermissions.length} of {permissionDefinitions.length} selected
                </Chip>
                {group?.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                {!isEditable && <Chip size="sm" variant="soft" color="warning">Read-only</Chip>}
              </Stack>
              {!isEditable && (
                <Alert color="warning" variant="soft">
                  {group?.canManage === false
                    ? 'This role grants higher access than you can assign. You can review it here, but you cannot change it.'
                    : 'This built-in role is fixed. You can review its permissions here, but it cannot be edited or removed.'}
                </Alert>
              )}
            </Stack>
          </DialogContent>

          <ScrollableDialogBody>
            <Stack spacing={2}>
              <DialogSection title="Role details">
                <Stack spacing={1.25}>
                  <FormControl required>
                    <FormLabel>Role name</FormLabel>
                    <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canEditMetadata || saving} />
                  </FormControl>

                  <FormControl>
                    <FormLabel>Description</FormLabel>
                    <Textarea
                      minRows={3}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                      disabled={!canEditMetadata || saving}
                      placeholder="Describe who should use this role and what it grants."
                    />
                  </FormControl>
                </Stack>
              </DialogSection>

              {error && (
                <Alert color="danger" variant="soft">
                  {error}
                </Alert>
              )}

              <DialogSection
                title="Permissions"
                description="Choose the access this role grants. Related permissions still follow the existing prerequisite rules."
                wrapInSheet={false}
              >
                <Stack spacing={1.5}>
                  {permissionSections.map((section) => {
                                      const isCollapsed = collapsedSections.has(section.title)
                    const selectedCount = section.permissions.filter((definition) => sortedPermissions.includes(definition.key)).length
                    const tree = buildPermissionTree(section.permissions)
                    const sectionKeys = section.permissions.map((definition) => definition.key)
                    return (
                      <Sheet key={section.title} variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                        <Stack spacing={1.25}>
                          <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" useFlexGap>
                            <Button
                              size="sm"
                              variant="plain"
                              color="neutral"
                              onClick={() => setCollapsedSections((current) => toggleCollapsedSection(current, section.title))}
                              aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${section.title} permissions`}
                              startDecorator={isCollapsed ? <KeyboardArrowRightRoundedIcon /> : <KeyboardArrowDownRoundedIcon />}
                              sx={{ px: 0, justifyContent: 'flex-start', minWidth: 0 }}
                            >
                              <Box sx={{ minWidth: 0, textAlign: 'left' }}>
                                <Typography level="title-sm">{section.title}</Typography>
                                <Typography level="body-xs" textColor="text.tertiary">
                                  {selectedCount} of {section.permissions.length} granted
                                </Typography>
                              </Box>
                            </Button>
                            <Chip size="sm" variant="outlined" color="neutral">
                              {selectedCount}/{section.permissions.length}
                            </Chip>
                          </Stack>

                          {!isCollapsed && (
                            <Stack spacing={0.5}>
                              {tree.map((node) => (
                                <PermissionTreeNode
                                  key={node.definition.key}
                                  node={node}
                                  depth={0}
                                  selectedPermissions={sortedPermissions}
                                  disabled={!canEditPermissions || saving}
                                  assignablePermissionSet={assignablePermissionSet}
                                  permissionLabelMap={permissionLabelMap}
                                  sectionKeys={sectionKeys}
                                  onToggle={(permission, checked, anchorEl) => togglePermission(permission, checked, sectionKeys, anchorEl)}
                                />
                              ))}
                            </Stack>
                          )}
                        </Stack>
                      </Sheet>
                    )
                  })}
                </Stack>
              </DialogSection>
            </Stack>
          </ScrollableDialogBody>

          <DialogActions>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
              {isEditable ? 'Cancel' : 'Close'}
            </Button>
            {isEditable && (
              <Button onClick={handleSubmit} loading={saving} disabled={normalizedName.length === 0 || !hasChanges}>
                {creating ? 'Create role' : 'Save changes'}
              </Button>
            )}
          </DialogActions>
        </ScrollableModalDialog>

        <PermissionDependencyPopover
          prompt={prerequisitePrompt}
          permissionLabelMap={permissionLabelMap}
          confirmLabel={prerequisitePrompt?.action === 'remove' ? 'Remove all' : 'Grant all'}
          onClose={() => setPrerequisitePrompt(null)}
          onConfirm={confirmPrerequisites}
        />
      </>
    </Modal>
  )
}

export function DeleteAuthGroupDialog({
  group,
  error,
  deleting,
  onClose,
  onConfirm
}: {
  group: AuthGroup
  error: string | null
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open onClose={() => !deleting && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(520px, 100%)' }}>
        <ModalClose disabled={deleting} />
        <DialogTitle>Delete role — {group.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography level="body-sm" textColor="text.tertiary">
              This removes the role definition. Existing members of this role will lose the access it granted.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color="neutral">{formatCount(group.userCount, 'user')}</Chip>
              <Chip size="sm" variant="soft" color="neutral">{formatCount(group.serviceAccountCount, 'service account')}</Chip>
            </Stack>
            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button color="danger" onClick={onConfirm} loading={deleting}>
            Delete role
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function AuthUserManagementDialog({
  user,
  authProviders,
  groups,
  canDisableUserSignIn,
  canDeleteUsers,
  canAssignUserRoles,
  canViewRoles,
  canViewUserSessions,
  canRevokeUserSessions,
  canSendUserInvites,
  canViewUserPasskeys,
  canEditUserPasskeys,
  canRevokeUserPasskeys,
  isOnlyEnabledAdmin,
  sessions,
  sessionsLoading,
  sessionsError,
  accessError,
  lifecycleError,
  deleteError,
  savingAccess,
  mutatingLifecycle,
  revokingSessionId,
  onClose,
  onSubmit,
  onToggleLoginDisabled,
  onRevokeSession,
  onDeleteRequest
}: {
  user: AuthUser
  authProviders: AuthBootstrap['providers']
  groups: AuthGroup[]
  canDisableUserSignIn: boolean
  canDeleteUsers: boolean
  canAssignUserRoles: boolean
  canViewRoles: boolean
  canViewUserSessions: boolean
  canRevokeUserSessions: boolean
  canSendUserInvites: boolean
  canViewUserPasskeys: boolean
  canEditUserPasskeys: boolean
  canRevokeUserPasskeys: boolean
  isOnlyEnabledAdmin: boolean
  sessions: AuthSessionListResponse['sessions']
  sessionsLoading: boolean
  sessionsError: string | null
  accessError: string | null
  lifecycleError: string | null
  deleteError: string | null
  savingAccess: boolean
  mutatingLifecycle: boolean
  revokingSessionId: string | null
  onClose: () => void
  onSubmit: (groupIds: string[]) => void
  onToggleLoginDisabled: (loginDisabled: boolean) => void
  onRevokeSession: (sessionId: string) => void
  onDeleteRequest: () => void
}) {
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  useEffect(() => {
    setSelectedGroupIds(user.groups.map((group) => group.id))
  }, [user])

  const sortedSelectedGroupIds = useMemo(
    () => [...selectedGroupIds].sort(),
    [selectedGroupIds]
  )
  const originalGroupIds = useMemo(
    () => [...user.groups.map((group) => group.id)].sort(),
    [user.groups]
  )
  const hasAccessChanges = !sameIds(sortedSelectedGroupIds, originalGroupIds)
  const localAuthManaged = authProviders.some(
    (provider) => provider.id === 'auth-local' && provider.enabled && provider.capabilities.adminUserCredentials
  )
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])
  const hasLifecyclePlugin = webPluginRegistry.slots('auth.userManagement.lifecycle').length > 0
  const canManageLifecycle = canDisableUserSignIn || canDeleteUsers || canSendUserInvites
  const canReviewOrAssignRoles = canViewRoles || canAssignUserRoles
  const canReviewSessions = canViewUserSessions
  const canManagePasskeys = canViewUserPasskeys || canEditUserPasskeys || canRevokeUserPasskeys

  const disableSignInAction = canDisableUserSignIn
    ? (
      <Button
        size="sm"
        variant="soft"
        color={user.loginDisabled ? 'success' : 'warning'}
        disabled={mutatingLifecycle || (isOnlyEnabledAdmin && !user.loginDisabled)}
        onClick={() => onToggleLoginDisabled(!user.loginDisabled)}
      >
        {user.loginDisabled ? 'Re-enable sign-in' : 'Disable sign-in'}
      </Button>
    )
    : null

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      if (checked) {
        return current.includes(groupId) ? current : [...current, groupId]
      }
      return current.filter((entry) => entry !== groupId)
    })
  }

  return (
    <Modal open onClose={() => !savingAccess && !mutatingLifecycle && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose disabled={savingAccess || mutatingLifecycle} />
        <DialogTitle>Manage user — {user.displayName?.trim() || user.email}</DialogTitle>
        <DialogContent>
          <Stack spacing={0.75}>
            <Typography level="body-sm" textColor="text.tertiary">
              Manage this user’s access policy, sign-in state, and provider-managed credentials.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color={user.loginDisabled ? 'warning' : 'success'}>
                {user.loginDisabled ? 'Sign-in disabled' : 'Sign-in enabled'}
              </Chip>
              <Chip size="sm" variant="soft" color="neutral">
                {sortedSelectedGroupIds.length} role{sortedSelectedGroupIds.length === 1 ? '' : 's'} selected
              </Chip>
              {localAuthManaged && (
                <Chip size="sm" variant="soft" color="neutral">
                  {user.passkeyCount} passkey{user.passkeyCount === 1 ? '' : 's'}
                </Chip>
              )}
            </Stack>
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={2}>
            {accessError && (
              <Alert color="danger" variant="soft">
                {accessError}
              </Alert>
            )}

            {lifecycleError && (
              <Alert color="danger" variant="soft">
                {lifecycleError}
              </Alert>
            )}

            {deleteError && (
              <Alert color="danger" variant="soft">
                {deleteError}
              </Alert>
            )}

            {canManageLifecycle && (
              <DialogSection
                title="Account lifecycle"
                description="Disable sign-in temporarily or remove the account entirely. Providers can contribute setup and recovery actions below."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1.25}>
                    {isOnlyEnabledAdmin && (
                      <Alert color="warning" variant="soft">
                        This is the only enabled Admin user left. Keep at least one enabled Admin account to avoid locking the system out of auth management.
                      </Alert>
                    )}
                    <StaticPluginSlot
                      name="auth.userManagement.lifecycle"
                      context={{
                        user,
                        authProviders,
                        mutatingLifecycle,
                        canSendUserInvites,
                        extraActions: disableSignInAction
                      }}
                    />
                    {!hasLifecyclePlugin && (
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                        {disableSignInAction}
                      </Stack>
                    )}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}

            {canReviewOrAssignRoles && (groups.length === 0 ? (
              <Alert color="warning" variant="soft">
                Create at least one role before assigning user access.
              </Alert>
            ) : (
              <DialogSection
                title="Role assignments"
                description="Roles determine what this user can access across the app."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {orderedGroups.map((group) => (
                      <Checkbox
                        key={group.id}
                        checked={sortedSelectedGroupIds.includes(group.id)}
                        disabled={!canAssignUserRoles || savingAccess || !group.canManage || (isOnlyEnabledAdmin && group.key === 'admin' && sortedSelectedGroupIds.includes(group.id))}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        label={(
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              {group.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                              {!group.canManage && <Chip size="sm" variant="soft" color="warning">Higher access</Chip>}
                            </Stack>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {group.description?.trim() || 'No description yet.'}
                            </Typography>
                          </Stack>
                        )}
                        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
                      />
                    ))}
                  </Stack>
                </Sheet>
              </DialogSection>
            ))}

            {canManagePasskeys && (
              <StaticPluginSlot
                name="auth.userManagement.credentials"
                context={{
                  user,
                  authProviders,
                  mutatingLifecycle,
                  canViewUserPasskeys,
                  canEditUserPasskeys,
                  canRevokeUserPasskeys
                }}
              />
            )}

            {canReviewSessions && (
              <DialogSection
                title="Sessions"
                description="Review active browser sessions for this user and revoke any session that should no longer have access."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {sessionsError && (
                      <Alert color="danger" variant="soft">
                        {sessionsError}
                      </Alert>
                    )}

                    {sessionsLoading ? (
                      <Typography level="body-sm" textColor="text.tertiary">
                        Loading sessions…
                      </Typography>
                    ) : (
                      <AuthSessionList
                        sessions={sessions}
                        emptyMessage="No active sessions found for this user."
                        revokingSessionId={revokingSessionId}
                        onRevoke={canRevokeUserSessions ? onRevokeSession : undefined}
                        actionsDisabled={mutatingLifecycle || !canRevokeUserSessions}
                        cardVariant="outlined"
                      />
                    )}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions sx={{ justifyContent: 'space-between' }}>
          {canDeleteUsers ? (
            <Button
              variant="plain"
              color="danger"
              onClick={onDeleteRequest}
              disabled={mutatingLifecycle || savingAccess || isOnlyEnabledAdmin}
            >
              Delete user
            </Button>
          ) : <span />}
          <Stack direction="row" spacing={1}>
            <Button variant="plain" color="neutral" onClick={onClose} disabled={savingAccess || mutatingLifecycle}>
              Cancel
            </Button>
            {canAssignUserRoles && (
              <Button onClick={() => onSubmit(sortedSelectedGroupIds)} loading={savingAccess} disabled={!hasAccessChanges || mutatingLifecycle}>
                Save access
              </Button>
            )}
          </Stack>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function DeleteAuthUserDialog({
  user,
  error,
  deleting,
  onClose,
  onConfirm
}: {
  user: AuthUser
  error: string | null
  deleting: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open onClose={() => !deleting && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(520px, 100%)' }}>
        <ModalClose disabled={deleting} />
        <DialogTitle>Delete user — {user.displayName?.trim() || user.email}</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography level="body-sm" textColor="text.tertiary">
              This removes the user account, its sessions, any pending email codes, and all registered passkeys.
            </Typography>
            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button color="danger" onClick={onConfirm} loading={deleting}>
            Delete user
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function AuthServiceAccountEditorDialog({
  serviceAccount,
  groups,
  creating,
  canEditServiceAccountName,
  canAssignServiceAccountRoles,
  error,
  saving,
  onClose,
  onCreate,
  onUpdate
}: {
  serviceAccount: AuthServiceAccount | null
  groups: AuthGroup[]
  creating: boolean
  canEditServiceAccountName: boolean
  canAssignServiceAccountRoles: boolean
  error: string | null
  saving: boolean
  onClose: () => void
  onCreate: (body: CreateAuthServiceAccountRequest) => void
  onUpdate: (serviceAccountId: string, body: UpdateAuthServiceAccountRequest) => void
}) {
  const [name, setName] = useState('')
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  useEffect(() => {
    if (creating) {
      setName('')
      setSelectedGroupIds([])
      return
    }

    if (!serviceAccount) return
    setName(serviceAccount.name)
    setSelectedGroupIds(serviceAccount.groups.map((group) => group.id))
  }, [creating, serviceAccount])

  const normalizedName = name.trim()
  const sortedSelectedGroupIds = useMemo(
    () => [...selectedGroupIds].sort(),
    [selectedGroupIds]
  )
  const orderedGroups = useMemo(() => orderGroupsForDisplay(groups), [groups])
  const originalGroupIds = useMemo(
    () => [...(serviceAccount?.groups.map((group) => group.id) ?? [])].sort(),
    [serviceAccount?.groups]
  )
  const canEditName = creating ? canEditServiceAccountName : canEditServiceAccountName && Boolean(serviceAccount?.canManage)
  const canAssignRoles = creating ? canAssignServiceAccountRoles : canAssignServiceAccountRoles && Boolean(serviceAccount?.canManage)
  const isEditable = canEditName || canAssignRoles
  const hasChanges = creating
    ? normalizedName.length > 0 || sortedSelectedGroupIds.length > 0
    : Boolean(
      serviceAccount
      && (
        normalizedName !== serviceAccount.name
        || !sameIds(sortedSelectedGroupIds, originalGroupIds)
      )
    )

  function toggleGroup(groupId: string, checked: boolean) {
    setSelectedGroupIds((current) => {
      if (checked) {
        return current.includes(groupId) ? current : [...current, groupId]
      }
      return current.filter((entry) => entry !== groupId)
    })
  }

  function handleSubmit() {
    if (!isEditable || normalizedName.length === 0) return
    if (creating) {
      onCreate({
        name: normalizedName,
        groupIds: sortedSelectedGroupIds
      })
      return
    }
    if (!serviceAccount) return
    onUpdate(serviceAccount.id, {
      ...(canEditName ? { name: normalizedName } : {}),
      ...(canAssignRoles ? { groupIds: sortedSelectedGroupIds } : {})
    })
  }

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <ScrollableModalDialog sx={{ width: 'min(720px, 100%)' }}>
        <ModalClose disabled={saving} />
        <DialogTitle>
          {creating
            ? 'Create service account'
            : `Edit service account — ${serviceAccount?.name ?? 'Service account'}`}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={0.75}>
            <Typography level="body-sm" textColor="text.tertiary">
              Service accounts provide role-based access for automation and external integrations.
            </Typography>
            {!creating && serviceAccount?.canManage === false && (
              <Alert color="warning" variant="soft">
                This service account has higher access than you can manage. You can review it here, but you cannot change it.
              </Alert>
            )}
            {serviceAccount?.revokedAt && (
              <Alert color="warning" variant="soft">
                This service account is revoked. You can still review or adjust its role assignments here.
              </Alert>
            )}
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={2}>
            <DialogSection title="Service account details">
              <FormControl required>
                <FormLabel>Name</FormLabel>
                <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canEditName || saving} placeholder="CI deploy worker" />
              </FormControl>
            </DialogSection>

            {error && (
              <Alert color="danger" variant="soft">
                {error}
              </Alert>
            )}

            {groups.length === 0 ? (
              <Alert color="warning" variant="soft">
                Create at least one role before creating a service account.
              </Alert>
            ) : (
              <DialogSection
                title="Role assignments"
                description="Choose the roles this service account should have in this workspace."
                wrapInSheet={false}
              >
                <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
                  <Stack spacing={1}>
                    {orderedGroups.map((group) => (
                      <Checkbox
                        key={group.id}
                        checked={sortedSelectedGroupIds.includes(group.id)}
                        disabled={!canAssignRoles || saving || !group.canManage}
                        onChange={(event) => toggleGroup(group.id, event.target.checked)}
                        label={(
                          <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                              <Typography level="title-sm">{group.name}</Typography>
                              {group.isSystem && <Chip size="sm" variant="soft" color="primary">Built-in</Chip>}
                              {!group.canManage && <Chip size="sm" variant="soft" color="warning">Higher access</Chip>}
                            </Stack>
                            <Typography level="body-xs" textColor="text.tertiary">
                              {group.description?.trim() || 'No description yet.'}
                            </Typography>
                          </Stack>
                        )}
                        sx={{ alignItems: 'flex-start', '--Checkbox-gap': '0.75rem' }}
                      />
                    ))}
                  </Stack>
                </Sheet>
              </DialogSection>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={saving}>
            {isEditable ? 'Cancel' : 'Close'}
          </Button>
          {isEditable && (
            <Button onClick={handleSubmit} loading={saving} disabled={normalizedName.length === 0 || !hasChanges}>
              {creating ? 'Create service account' : 'Save changes'}
            </Button>
          )}
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function CreatedServiceAccountTokenDialog({
  revealedToken,
  onClose
}: {
  revealedToken: RevealedServiceAccountToken
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(revealedToken.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal open onClose={onClose}>
      <ScrollableModalDialog sx={{ width: 'min(680px, 100%)' }}>
        <ModalClose />
        <DialogTitle>Service account token</DialogTitle>
        <DialogContent>
          <Stack spacing={1}>
            <Typography level="body-sm" textColor="text.tertiary">
              Save this token now. It is only shown once after the service account is created.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Chip size="sm" variant="soft" color="primary">{revealedToken.name}</Chip>
              <Chip size="sm" variant="soft" color="neutral">{revealedToken.tokenPrefix}</Chip>
            </Stack>
          </Stack>
        </DialogContent>

        <ScrollableDialogBody>
          <Stack spacing={1.5}>
            <FormControl>
              <FormLabel>Token</FormLabel>
              <Textarea minRows={3} value={revealedToken.token} readOnly />
            </FormControl>
            {copied && (
              <Alert color="success" variant="soft">
                Token copied to the clipboard.
              </Alert>
            )}
          </Stack>
        </ScrollableDialogBody>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void handleCopy()}>
            Copy token
          </Button>
        </DialogActions>
      </ScrollableModalDialog>
    </Modal>
  )
}

export function AuthManagementOverviewCards({
  userCount,
  roleCount,
  permissionCount,
  onOpenUsers,
  onOpenRoles
}: {
  userCount: number
  roleCount: number
  permissionCount: number
  onOpenUsers?: () => void
  onOpenRoles?: () => void
}) {
  return (
    <Stack spacing={1.25}>
      <Box>
        <Typography level="title-md">Access management</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Open a dedicated users or roles view when you need to manage auth access in detail.
        </Typography>
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
        <Card variant="outlined" sx={{ flex: 1 }}>
          <CardContent>
            <Stack spacing={1.25}>
              <Box>
                <Typography level="title-sm">Users</Typography>
              </Box>
              <Chip size="sm" variant="soft" color="neutral" sx={{ alignSelf: 'flex-start' }}>
                {userCount} user{userCount === 1 ? '' : 's'}
              </Chip>
              <Button size="sm" variant="soft" color="primary" onClick={onOpenUsers} disabled={!onOpenUsers}>
                Open users
              </Button>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined" sx={{ flex: 1 }}>
          <CardContent>
            <Stack spacing={1.25}>
              <Box>
                <Typography level="title-sm">Roles</Typography>
              </Box>
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                <Chip size="sm" variant="soft" color="primary">
                  {roleCount} role{roleCount === 1 ? '' : 's'}
                </Chip>
                <Chip size="sm" variant="soft" color="neutral">
                  {permissionCount} permission{permissionCount === 1 ? '' : 's'}
                </Chip>
              </Stack>
              <Button size="sm" variant="soft" color="primary" onClick={onOpenRoles} disabled={!onOpenRoles}>
                Open roles
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Stack>
  )
}
