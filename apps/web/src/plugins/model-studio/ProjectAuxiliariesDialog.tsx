/** Editor for BambuStudio-compatible project attachments and descriptive metadata. */
import { useEffect, useMemo, useRef, useState } from 'react'
import AddRoundedIcon from '@mui/icons-material/AddRounded'
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded'
import DriveFileRenameOutlineRoundedIcon from '@mui/icons-material/DriveFileRenameOutlineRounded'
import ImageRoundedIcon from '@mui/icons-material/ImageRounded'
import { Box, Button, Chip, CircularProgress, FormControl, FormLabel, IconButton, Input, Stack, Tab, TabList, TabPanel, Tabs, Textarea, Tooltip, Typography } from '@mui/joy'
import {
  PROJECT_AUXILIARY_ACCEPT,
  PROJECT_AUXILIARY_CATEGORIES,
  decodeProjectAuxiliaryBase64,
  projectAuxiliaryFileNameAllowed,
  projectAuxiliariesSchema,
  type ProjectAuxiliaries,
  type ProjectAuxiliaryCategory,
  type ProjectAuxiliaryFile
} from '@printstream/shared'
import { FormDialog } from '../../components/FormDialog'
import { ImageLightbox } from '../../components/ImageLightbox'
import { usePromptDialog } from '../../components/PromptDialogProvider'
import { SquareImageFrame } from '../../components/SquareMediaFrame'
import {
  cloneProjectAuxiliaries,
  generateProjectCoverThumbnails,
  projectAuxiliaryFileFromFile
} from './lib/projectAuxiliaries'

const EMPTY_AUXILIARIES: ProjectAuxiliaries = {
  files: [],
  metadata: {
    modelName: '',
    modelAuthor: '',
    modelDescription: '',
    modelId: '',
    profileName: '',
    profileAuthor: '',
    profileDescription: ''
  }
}

/** Build a browser-displayable URL for an image attachment stored inline in the project. */
function projectAuxiliaryImageUrl(file: ProjectAuxiliaryFile): string {
  const lowerName = file.name.toLowerCase()
  const mediaType = lowerName.endsWith('.png')
    ? 'image/png'
    : lowerName.endsWith('.bmp')
      ? 'image/bmp'
      : 'image/jpeg'

  return `data:${mediaType};base64,${file.contentBase64}`
}

/** Edit the five BambuStudio attachment folders and their root-project metadata as one draft. */
export function ProjectAuxiliariesDialog({
  auxiliaries,
  loading = false,
  loadError = null,
  onRetry,
  onClose,
  onApply
}: {
  auxiliaries?: ProjectAuxiliaries
  loading?: boolean
  loadError?: string | null
  onRetry?: () => void
  onClose: () => void
  onApply: (auxiliaries: ProjectAuxiliaries) => void
}): JSX.Element {
  const [draft, setDraft] = useState(() => cloneProjectAuxiliaries(auxiliaries ?? EMPTY_AUXILIARIES))
  const [activeTab, setActiveTab] = useState<string>('Details')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const { promptText } = usePromptDialog()
  useEffect(() => {
    if (auxiliaries) setDraft(cloneProjectAuxiliaries(auxiliaries))
  }, [auxiliaries])
  const activeCategory = PROJECT_AUXILIARY_CATEGORIES.find((category) => category === activeTab)
  const activeFiles = useMemo(
    () => activeCategory ? draft.files.filter((file) => file.category === activeCategory) : [],
    [activeCategory, draft.files]
  )

  const addFiles = async (category: ProjectAuxiliaryCategory, picked: FileList): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const duplicate = [...picked].find((pickedFile) => draft.files.some((file) => (
        file.category === category && file.name.toLowerCase() === pickedFile.name.toLowerCase()
      )))
      if (duplicate) throw new Error(`${duplicate.name} already exists in this folder. Rename or remove it first.`)
      const additions = await Promise.all([...picked].map((file) => projectAuxiliaryFileFromFile(category, file)))
      setDraft((current) => {
        return {
          ...current,
          files: [...current.files, ...additions]
        }
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The attachment could not be added.')
    } finally {
      setBusy(false)
    }
  }

  const setCover = async (category: ProjectAuxiliaryCategory, name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const selected = draft.files.find((file) => file.category === category && file.name === name)
      if (!selected) return
      const coverThumbnails = category === 'Model Pictures'
        ? await generateProjectCoverThumbnails(new File(
            [decodeProjectAuxiliaryBase64(selected.contentBase64) as BlobPart],
            selected.name
          ))
        : draft.coverThumbnails
      setDraft((current) => ({
        ...current,
        files: current.files.map((file) => file.category === category
          ? { ...file, cover: file.name === name }
          : file),
        ...(coverThumbnails ? { coverThumbnails } : {})
      }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The cover image could not be prepared.')
    } finally {
      setBusy(false)
    }
  }

  const rename = async (category: ProjectAuxiliaryCategory, name: string): Promise<void> => {
    const nextName = await promptText({
      title: 'Rename attachment',
      label: 'File name',
      initialValue: name,
      confirmLabel: 'Rename'
    })
    if (!nextName?.trim() || nextName.trim() === name) return
    const trimmed = nextName.trim()
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      setError('Attachment names cannot contain path separators.')
      return
    }
    if (!projectAuxiliaryFileNameAllowed(category, trimmed)) {
      setError(`The renamed file must keep a supported ${category.toLowerCase()} extension.`)
      return
    }
    if (draft.files.some((file) => file.category === category && file.name.toLowerCase() === trimmed.toLowerCase())) {
      setError('An attachment with that name already exists in this folder.')
      return
    }
    setDraft((current) => ({
      ...current,
      files: current.files.map((file) => file.category === category && file.name === name
        ? { ...file, name: trimmed }
        : file)
    }))
  }

  const remove = (category: ProjectAuxiliaryCategory, name: string): void => {
    setDraft((current) => {
      const removed = current.files.find((file) => file.category === category && file.name === name)
      const files = current.files.filter((file) => file !== removed)
      return {
        ...current,
        files,
        ...((removed?.cover && category === 'Model Pictures') ? { coverThumbnails: undefined } : {})
      }
    })
  }

  const submit = (): void => {
    const parsed = projectAuxiliariesSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Project attachments are invalid.')
      return
    }
    onApply(parsed.data)
    onClose()
  }

  const metadataField = (key: keyof ProjectAuxiliaries['metadata'], value: string): void => {
    setDraft((current) => ({ ...current, metadata: { ...current.metadata, [key]: value } }))
  }

  return (<>
    <FormDialog
      onClose={onClose}
      title="Project files and details"
      description="Store reference images, bills of materials, assembly guides and notes inside the 3MF. These files travel with the project."
      error={error ?? loadError}
      submitLabel="Apply"
      busy={busy}
      submitDisabled={loading || Boolean(loadError && !auxiliaries)}
      onSubmit={submit}
      width="min(880px, 100%)"
    >
      {loading ? (
        <Stack alignItems="center" spacing={1} sx={{ py: 6 }}>
          <CircularProgress />
          <Typography level="body-sm">Loading project files…</Typography>
        </Stack>
      ) : loadError && !auxiliaries ? (
        <Stack alignItems="flex-start" spacing={1} sx={{ py: 2 }}>
          <Typography level="body-sm">The project files could not be loaded.</Typography>
          {onRetry && <Button size="sm" variant="soft" onClick={onRetry}>Retry</Button>}
        </Stack>
      ) : (<>
        {activeCategory && (
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept={PROJECT_AUXILIARY_ACCEPT[activeCategory].join(',')}
          onChange={(event) => {
            if (event.target.files) void addFiles(activeCategory, event.target.files)
            event.target.value = ''
          }}
        />
        )}
        <Tabs value={activeTab} onChange={(_event, value) => setActiveTab(String(value))}>
        <Box sx={{ overflowX: 'auto' }}>
          <TabList sx={{ minWidth: 'max-content' }}>
            <Tab value="Details">Details</Tab>
            {PROJECT_AUXILIARY_CATEGORIES.map((category) => (
              <Tab key={category} value={category}>{category}</Tab>
            ))}
          </TabList>
        </Box>

        <TabPanel value="Details" sx={{ px: 0, pb: 0 }}>
          <Stack spacing={2}>
            <Typography level="title-sm">Model</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <MetadataInput label="Name" value={draft.metadata.modelName} onChange={(value) => metadataField('modelName', value)} />
              <MetadataInput label="Author" value={draft.metadata.modelAuthor} onChange={(value) => metadataField('modelAuthor', value)} />
              <MetadataInput label="Model ID" value={draft.metadata.modelId} onChange={(value) => metadataField('modelId', value)} />
            </Stack>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Textarea minRows={3} value={draft.metadata.modelDescription} onChange={(event) => metadataField('modelDescription', event.target.value)} />
            </FormControl>
            <Typography level="title-sm">Print profile</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <MetadataInput label="Title" value={draft.metadata.profileName} onChange={(value) => metadataField('profileName', value)} />
              <MetadataInput label="Author" value={draft.metadata.profileAuthor} onChange={(value) => metadataField('profileAuthor', value)} />
            </Stack>
            <FormControl>
              <FormLabel>Description</FormLabel>
              <Textarea minRows={3} value={draft.metadata.profileDescription} onChange={(event) => metadataField('profileDescription', event.target.value)} />
            </FormControl>
          </Stack>
        </TabPanel>

        {PROJECT_AUXILIARY_CATEGORIES.map((category) => (
          <TabPanel key={category} value={category} sx={{ px: 0, pb: 0 }}>
            <Stack spacing={1.5}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between">
                <Typography level="body-sm" textColor="text.tertiary">
                  Accepted: {PROJECT_AUXILIARY_ACCEPT[category].join(', ')}
                </Typography>
                <Button size="sm" startDecorator={<AddRoundedIcon />} onClick={() => inputRef.current?.click()} loading={busy}>
                  Add files
                </Button>
              </Stack>
              {activeFiles.length === 0 ? (
                <Box sx={{ py: 4, textAlign: 'center' }}>
                  <Typography level="body-sm" textColor="text.tertiary">No files in this folder.</Typography>
                </Box>
              ) : activeFiles.map((file) => {
                const isImage = category === 'Model Pictures' || category === 'Profile Pictures'
                const imageUrl = isImage ? projectAuxiliaryImageUrl(file) : null

                return (
                  <Stack key={file.name} direction="row" spacing={1} alignItems="center" sx={{ py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
                    {imageUrl ? (
                      <Box
                        component="button"
                        type="button"
                        aria-label={`Preview ${file.name}`}
                        onClick={() => setPreviewImage({ src: imageUrl, name: file.name })}
                        sx={{
                          width: 64,
                          minWidth: 64,
                          p: 0,
                          border: 0,
                          borderRadius: 'sm',
                          background: 'transparent',
                          cursor: 'pointer',
                          '&:focus-visible': {
                            outline: '2px solid',
                            outlineColor: 'primary.500',
                            outlineOffset: 2
                          }
                        }}
                      >
                        <SquareImageFrame
                          src={imageUrl}
                          alt=""
                          loading="eager"
                          imgSx={{ objectFit: 'contain' }}
                        />
                      </Box>
                    ) : (
                      <ImageRoundedIcon fontSize="small" />
                    )}
                    <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography level="body-sm" noWrap>{file.name}</Typography>
                      {file.cover && <Chip size="sm" color="primary" variant="soft" sx={{ alignSelf: 'flex-start' }}>Cover</Chip>}
                    </Stack>
                    <Stack direction="row" spacing={0.25} alignItems="center" sx={{ flexShrink: 0 }}>
                      {isImage && !file.cover && (
                        <Button size="sm" variant="plain" onClick={() => void setCover(category, file.name)} disabled={busy}>Set cover</Button>
                      )}
                      <Tooltip title="Rename">
                        <IconButton size="sm" variant="plain" onClick={() => void rename(category, file.name)} aria-label={`Rename ${file.name}`}>
                          <DriveFileRenameOutlineRoundedIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Remove">
                        <IconButton size="sm" variant="plain" color="danger" onClick={() => remove(category, file.name)} aria-label={`Remove ${file.name}`}>
                          <DeleteOutlineRoundedIcon />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                )
              })}
            </Stack>
          </TabPanel>
        ))}
        </Tabs>
      </>)}
    </FormDialog>
    {previewImage && (
      <ImageLightbox
        src={previewImage.src}
        alt={previewImage.name}
        title={previewImage.name}
        onClose={() => setPreviewImage(null)}
      />
    )}
  </>)
}

function MetadataInput({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <FormControl sx={{ flex: 1 }}>
      <FormLabel>{label}</FormLabel>
      <Input value={value} onChange={(event) => onChange(event.target.value)} />
    </FormControl>
  )
}
