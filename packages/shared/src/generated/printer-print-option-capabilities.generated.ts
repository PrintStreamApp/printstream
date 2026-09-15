/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Regenerate with: node scripts/dev/generate-printer-print-option-capabilities.mjs
 * Source: BambuStudio `resources/printers/*.json` (vendored at tmp/bambustudio-src)
 *
 * BambuStudio applies the last snapshot whose minimum version is not newer than the printer's OTA
 * firmware. The resolver lives in `../printer-capabilities.ts`.
 */

export interface BambuStudioPrintOptionConfig {
  aiMonitoring: boolean
  autoRecovery: boolean
  buildPlateDetection: boolean
  buildPlateDetectionType: 0 | 1 | 2 | null
  firstLayerInspection: boolean
  promptSound: boolean
  storeSentFilesOnExternalStorage: boolean
}

export interface BambuStudioPrintOptionCapabilitySnapshot {
  minimumFirmwareVersion: string
  config: BambuStudioPrintOptionConfig
}

export const BAMBU_STUDIO_PRINT_OPTION_CAPABILITIES: Readonly<
  Record<string, readonly BambuStudioPrintOptionCapabilitySnapshot[]>
> = {
  "A1": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": true,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": false,
        "promptSound": true,
        "storeSentFilesOnExternalStorage": false
      }
    }
  ],
  "A1mini": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": true,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": false,
        "promptSound": true,
        "storeSentFilesOnExternalStorage": false
      }
    }
  ],
  "A2L": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": true,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": false,
        "promptSound": true,
        "storeSentFilesOnExternalStorage": false
      }
    }
  ],
  "H2C": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 2,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "H2D": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 2,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "H2DPRO": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 2,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "H2S": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 2,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "P1P": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": true,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": false
      }
    }
  ],
  "P1S": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": true,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": false
      }
    }
  ],
  "P2S": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 2,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "X1": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": false,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": true,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    },
    {
      "minimumFirmwareVersion": "01.01.01.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 1,
        "firstLayerInspection": true,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "X1C": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": false,
        "autoRecovery": false,
        "buildPlateDetection": false,
        "buildPlateDetectionType": null,
        "firstLayerInspection": true,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    },
    {
      "minimumFirmwareVersion": "01.01.01.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 1,
        "firstLayerInspection": true,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ],
  "X1E": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 1,
        "firstLayerInspection": true,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": false
      }
    }
  ],
  "X2D": [
    {
      "minimumFirmwareVersion": "00.00.00.00",
      "config": {
        "aiMonitoring": true,
        "autoRecovery": true,
        "buildPlateDetection": true,
        "buildPlateDetectionType": 2,
        "firstLayerInspection": false,
        "promptSound": false,
        "storeSentFilesOnExternalStorage": true
      }
    }
  ]
}
