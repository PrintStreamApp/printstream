/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Regenerate with: node scripts/dev/generate-filament-blacklist.mjs
 * Source: BambuStudio `resources/printers/filaments_blacklist.json` (vendored at tmp/bambustudio-src)
 *
 * 37 rules (11 prohibition, 26 warning).
 * The matcher that runs these lives in `../filament-blacklist.ts`; read its header first.
 */

/** A rule either forbids the combination outright, or advises against it. */
export type FilamentBlacklistAction = 'prohibition' | 'warning'

/** Which value fills the description's `%s`. See the generator header for BambuStudio's rule. */
export type FilamentBlacklistSubstitution = 'filamentName' | 'filamentType' | 'nameSuffixOrFilamentName'

/**
 * One rule. Every predicate field is OPTIONAL and an absent field means "matches anything" -- that
 * is BambuStudio's semantics, not a shortcut, and there is no wildcard sentinel value.
 *
 * The string predicates are stored already lower-cased (the matcher lower-cases the query to suit),
 * with two exceptions that BambuStudio compares case-sensitively: `modelKeys` and
 * `whiteFilamentIds`.
 */
export interface FilamentBlacklistRule {
  action: FilamentBlacklistAction
  /** Raw English text, with `%s` still in it when `substitution` is set. */
  description: string
  substitution?: FilamentBlacklistSubstitution
  /** Bambu help-page URL, shown as a "learn more" affordance. */
  wiki?: string
  /** Printer models this rule applies to, as `PrinterModel` keys. */
  modelKeys?: readonly string[]
  nozzleFlows?: readonly string[]
  nozzleDiameters?: readonly number[]
  /** Either `bambu lab` or `third party`; the latter means "any vendor that is not Bambu". */
  vendor?: string
  calibMode?: string
  type?: string
  types?: readonly string[]
  typeSuffix?: string
  name?: string
  nameSuffix?: string
  usedForSupport?: boolean
  usedForObject?: boolean
  hasFilamentSwitch?: boolean
  /** `ams` matches a real AMS slot; `ext` matches an external spool (tray 254/255). */
  slot?: 'ams' | 'ext'
  extruderIds?: readonly number[]
  /** EXCLUSIONS: a filament whose name CONTAINS one of these escapes the rule. */
  whiteNames?: readonly string[]
  /** EXCLUSIONS: exact, case-sensitive filament ids that escape the rule. */
  whiteFilamentIds?: readonly string[]
}

export const FILAMENT_BLACKLIST_RULES: readonly FilamentBlacklistRule[] = [
  {
    "action": "prohibition",
    "description": "TPU is not supported by AMS.",
    "type": "tpu",
    "slot": "ams"
  },
  {
    "action": "prohibition",
    "description": "AMS does not support 'Bambu Lab PET-CF'.",
    "vendor": "bambu lab",
    "type": "pet-cf",
    "slot": "ams"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the E3D high-flow nozzle and can't be used.",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "pa6-gf"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the E3D high-flow nozzle and can't be used.",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "type": "pps-cf"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the E3D high-flow nozzle and can't be used.",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "type": "pla-aero"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the E3D high-flow nozzle and can't be used.",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "type": "asa-aero"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the E3D high-flow nozzle and can't be used.",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "tpu 85a"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the E3D high-flow nozzle and can't be used.",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "tpu 90a"
  },
  {
    "action": "prohibition",
    "description": "The current filament doesn't support the TPU high-flow nozzle and can't be used.",
    "modelKeys": [
      "H2D",
      "H2DPRO"
    ],
    "nozzleFlows": [
      "tpu-high"
    ],
    "whiteFilamentIds": [
      "GFU04",
      "GFU03",
      "GFU01",
      "GFU00",
      "GFU99"
    ]
  },
  {
    "action": "prohibition",
    "description": "Auto dynamic flow calibration is not supported for TPU filament.",
    "modelKeys": [
      "H2D",
      "H2DPRO"
    ],
    "calibMode": "auto_pa",
    "type": "tpu"
  },
  {
    "action": "prohibition",
    "description": "Bambu TPU 85A is not supported for printing with 0.4 mm Standard or High Flow nozzles.",
    "modelKeys": [
      "H2D",
      "H2DPRO"
    ],
    "nozzleFlows": [
      "standard",
      "high"
    ],
    "nozzleDiameters": [
      0.4
    ],
    "nameSuffix": "bambu tpu 85a"
  },
  {
    "action": "warning",
    "description": "How to feed TPU filament on X2D.",
    "wiki": "https://e.bambulab.com/t?c=PAxXqQu2zBgvN3ea",
    "modelKeys": [
      "X2D"
    ],
    "types": [
      "tpu"
    ]
  },
  {
    "action": "warning",
    "description": "How to feed TPU filament.",
    "wiki": "https://e.bambulab.com/t?c=blx2TDu3uoRdfyIx",
    "modelKeys": [
      "P2S"
    ],
    "types": [
      "tpu",
      "tpu-ams"
    ]
  },
  {
    "action": "warning",
    "description": "How to feed TPU filament.",
    "wiki": "https://e.bambulab.com/t?c=fwWqpBg37Liel92N",
    "modelKeys": [
      "H2D"
    ],
    "types": [
      "tpu"
    ]
  },
  {
    "action": "warning",
    "description": "How to feed TPU filament.",
    "wiki": "https://e.bambulab.com/t?c=fwWqpBg37Liel92N",
    "modelKeys": [
      "H2DPRO"
    ],
    "types": [
      "tpu"
    ]
  },
  {
    "action": "warning",
    "description": "How to feed TPU filament.",
    "wiki": "https://e.bambulab.com/t?c=Db9YyP5qg3MHbSHD",
    "modelKeys": [
      "H2C"
    ],
    "types": [
      "tpu"
    ]
  },
  {
    "action": "warning",
    "description": "How to feed TPU filament.",
    "wiki": "https://e.bambulab.com/t?c=L45sIEpzy1Wz0tsV",
    "modelKeys": [
      "H2S"
    ],
    "types": [
      "tpu"
    ]
  },
  {
    "action": "warning",
    "description": "Please cold pull before printing TPU to avoid clogging. You may use cold pull maintenance on the printer.",
    "types": [
      "tpu",
      "tpu-ams"
    ]
  },
  {
    "action": "warning",
    "description": "Damp PVA will become flexible and get stuck inside AMS,please take care to dry it before use.",
    "type": "pva",
    "slot": "ams"
  },
  {
    "action": "warning",
    "description": "Damp PVA is flexible and may get stuck in extruder. Dry it before use.",
    "type": "pva",
    "slot": "ext"
  },
  {
    "action": "warning",
    "description": "PPS-CF is brittle and could break in bended PTFE tube above Toolhead.",
    "wiki": "https://e.bambulab.com/t?c=UC64kdlpHxN3Mb15",
    "modelKeys": [
      "H2S"
    ],
    "type": "pps-cf"
  },
  {
    "action": "warning",
    "description": "PPA-CF is brittle and could break in bended PTFE tube above Toolhead.",
    "wiki": "https://e.bambulab.com/t?c=UC64kdlpHxN3Mb15",
    "modelKeys": [
      "H2S"
    ],
    "type": "ppa-cf"
  },
  {
    "action": "warning",
    "description": "PLA Glow may wear the AMS first stage feeder. Use an external spool instead.",
    "vendor": "bambu lab",
    "type": "pla",
    "name": "bambu pla glow",
    "slot": "ams"
  },
  {
    "action": "warning",
    "description": "%s may fail to load or unload due to the Filament Track Switch. If you wish to continue.",
    "substitution": "filamentName",
    "wiki": "https://e.bambulab.com/t?c=s0CgMOrctZiPablB",
    "type": "pla",
    "nameSuffix": "pla silk",
    "hasFilamentSwitch": true,
    "slot": "ams"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "pc fr"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "pla silk"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "support for pa/pet"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "pva"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "support for pla"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "support for pla/petg"
  },
  {
    "action": "warning",
    "description": "Default settings may affect print quality. Adjust as needed for best results.",
    "wiki": "https://wiki.bambulab.com/en/accessories/e3d-hotend",
    "modelKeys": [
      "P1P",
      "P1S",
      "X1C"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nameSuffix": "support for abs"
  },
  {
    "action": "warning",
    "description": "%s has a risk of nozzle clogging when using 0.4mm high-flow nozzles. Use with caution.",
    "substitution": "filamentName",
    "modelKeys": [
      "H2D",
      "H2S",
      "H2DPRO",
      "H2C",
      "H2C",
      "P2S"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nozzleDiameters": [
      0.4
    ],
    "typeSuffix": "cf",
    "slot": "ext"
  },
  {
    "action": "warning",
    "description": "%s has a risk of nozzle clogging when using 0.4mm high-flow nozzles. Use with caution.",
    "substitution": "filamentName",
    "modelKeys": [
      "H2D",
      "H2S",
      "H2DPRO",
      "H2C",
      "H2C",
      "P2S",
      "X2D"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nozzleDiameters": [
      0.4
    ],
    "nameSuffix": "pa6-gf",
    "slot": "ext"
  },
  {
    "action": "warning",
    "description": "%s filaments are hard and brittle and could break in AMS, and there is also a risk of nozzle clogging when using 0.4mm high-flow nozzles. Use with caution.",
    "substitution": "filamentType",
    "modelKeys": [
      "H2D",
      "H2S",
      "H2DPRO",
      "H2C",
      "H2C",
      "P2S",
      "X2D"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nozzleDiameters": [
      0.4
    ],
    "typeSuffix": "cf",
    "slot": "ams"
  },
  {
    "action": "warning",
    "description": "%s filaments are hard and brittle and could break in AMS, and there is also a risk of nozzle clogging when using 0.4mm high-flow nozzles. Use with caution.",
    "substitution": "filamentType",
    "modelKeys": [
      "H2D",
      "H2S",
      "H2DPRO",
      "H2C",
      "H2C",
      "P2S",
      "X2D"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nozzleDiameters": [
      0.4
    ],
    "nameSuffix": "pa6-gf",
    "slot": "ams"
  },
  {
    "action": "warning",
    "description": "%s has a risk of nozzle clogging when using 0.4, 0.6, 0.8mm high-flow nozzles. Use with caution.",
    "substitution": "filamentName",
    "modelKeys": [
      "H2D",
      "H2S",
      "H2DPRO",
      "H2C",
      "H2C",
      "P2S",
      "X2D"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nozzleDiameters": [
      0.4,
      0.6,
      0.8
    ],
    "nameSuffix": "tpu 85a",
    "slot": "ext"
  },
  {
    "action": "warning",
    "description": "%s has a risk of nozzle clogging when using 0.4, 0.6, 0.8mm high-flow nozzles. Use with caution.",
    "substitution": "filamentName",
    "modelKeys": [
      "H2D",
      "H2S",
      "H2DPRO",
      "H2C",
      "H2C",
      "P2S",
      "X2D"
    ],
    "nozzleFlows": [
      "high"
    ],
    "nozzleDiameters": [
      0.4,
      0.6,
      0.8
    ],
    "nameSuffix": "tpu 90a",
    "slot": "ext"
  }
]

/**
 * Bambu's internal model code -> our `PrinterModel` key, derived from BambuStudio's own
 * `resources/printers/<code>.json` display names.
 *
 * `bambu-model-keys.ts` carries the same mapping for the app's own name matching;
 * `filament-blacklist.test.ts` asserts the two agree, so a future edit cannot leave the rules
 * targeting one model while the rest of the app resolves the code to another.
 */
export const BAMBU_MODEL_CODE_TO_MODEL_KEY: Readonly<Record<string, string>> = {
  "BL-P001": "X1C",
  "BL-P002": "X1",
  "C11": "P1P",
  "C12": "P1S",
  "C13": "X1E",
  "N1": "A1mini",
  "N2S": "A1",
  "N6": "X2D",
  "N7": "P2S",
  "N9": "A2L",
  "O1C": "H2C",
  "O1C2": "H2C",
  "O1D": "H2D",
  "O1E": "H2DPRO",
  "O1S": "H2S"
}
