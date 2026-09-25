export const slicerTargets = [
  {
    id: 'bambustudio-2-6-0-51',
    label: 'Bambu Studio 2.6.0.51',
    family: 'bambustudio',
    version: '2.6.0.51',
    slicerName: 'Bambu Studio',
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.06.00.51/BambuStudio_ubuntu-22.04-v02.06.00.51-20260417160415.AppImage'
  },
  {
    id: 'bambustudio-2-6-1-55',
    label: 'Bambu Studio 2.6.1.55',
    family: 'bambustudio',
    version: '2.6.1.55',
    slicerName: 'Bambu Studio',
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.06.01.55/BambuStudio_ubuntu22.04-v02.06.01.55-20260429100944.AppImage'
  },
  {
    id: 'bambustudio-2-7-0-55',
    label: 'Bambu Studio 2.7.0.55',
    family: 'bambustudio',
    version: '2.7.0.55',
    slicerName: 'Bambu Studio',
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.07.00.55/BambuStudio_ubuntu-22.04-v02.07.00.55-20260514170313.AppImage'
  },
  {
    id: 'bambustudio-2-7-1-57',
    label: 'Bambu Studio 2.7.1.57',
    family: 'bambustudio',
    version: '2.7.1.57',
    slicerName: 'Bambu Studio',
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.07.01.57/BambuStudio_ubuntu-24.04-v02.07.01.57-20260601192128.AppImage'
  },
  {
    id: 'bambustudio-2-7-1-62',
    label: 'Bambu Studio 2.7.1.62',
    family: 'bambustudio',
    version: '2.7.1.62',
    slicerName: 'Bambu Studio',
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.07.01.62/BambuStudio_ubuntu24.04-v02.07.01.62-20260616195227.AppImage'
  },
  {
    id: 'bambustudio-2-8-2-60',
    label: 'Bambu Studio 2.8.2.60',
    family: 'bambustudio',
    version: '2.8.2.60',
    slicerName: 'Bambu Studio',
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.60/BambuStudio_ubuntu24.04-v02.08.02.60-20260814171356.AppImage'
  },
  {
    id: 'bambustudio-2-8-2-61',
    label: 'Bambu Studio 2.8.2.61',
    family: 'bambustudio',
    version: '2.8.2.61',
    slicerName: 'Bambu Studio',
    isDefault: true,
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.02.61/BambuStudio_ubuntu24.04-v02.08.02.61-20260820225108.AppImage'
  },
  // BETAS. Bambu ships these as GitHub PRE-releases, and BambuStudio's own file-version refusal
  // tells users a 3MF should come from "the official version ... not a beta version". They exist
  // only so a project saved by a beta desktop build can be sliced at all: `prerelease: true` keeps
  // them out of the default selection, and nothing may set `isDefault` on them.
  //
  // 2.8.0 and 2.8.1 are kept even though the public 2.8.2 supersedes them: a project saved by one
  // of those beta desktop builds still has to be sliceable by the engine that wrote it.
  {
    id: 'bambustudio-2-8-0-50',
    label: 'Bambu Studio 2.8.0.50 (beta)',
    family: 'bambustudio',
    version: '2.8.0.50',
    slicerName: 'Bambu Studio',
    prerelease: true,
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.00.50/BambuStudio_ubuntu24.04-v02.08.00.50-20260625193201.AppImage'
  },
  {
    id: 'bambustudio-2-8-1-55',
    label: 'Bambu Studio 2.8.1.55 (beta)',
    family: 'bambustudio',
    version: '2.8.1.55',
    slicerName: 'Bambu Studio',
    prerelease: true,
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.01.55/BambuStudio_ubuntu24.04-v02.08.01.55-20260715113557.AppImage'
  },
  {
    id: 'bambustudio-2-8-4-57',
    label: 'Bambu Studio 2.8.4.57 (beta)',
    family: 'bambustudio',
    version: '2.8.4.57',
    slicerName: 'Bambu Studio',
    prerelease: true,
    downloadUrl: 'https://github.com/bambulab/BambuStudio/releases/download/v02.08.04.57/BambuStudio_ubu24-v02.08.04.57-20260922164607.AppImage'
  }
]
