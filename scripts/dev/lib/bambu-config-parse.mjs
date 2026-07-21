/**
 * Shared BambuStudio `PrintConfig.cpp` parsing for the settings-catalog generators.
 *
 * Owns the C++-to-metadata extraction the process AND filament catalog generators both need:
 * option-definition indexing (`this->add("key", coType) ... def->...`), the ConfigOption type map,
 * enum key-map resolution, and per-block metadata parsing. The generators
 * (`generate-process-settings.mjs`, `generate-filament-settings.mjs`) own only their tab LAYOUT
 * (transcribed from `TabPrint::build()` / `TabFilament::build()`); everything language-level lives
 * here so the two stay faithful to the same slicer source. Build-time only — never imported by app
 * code.
 */

export const MODE_MAP = { comSimple: 'simple', comAdvanced: 'advanced', comDevelop: 'develop' }

/** Map a BambuStudio ConfigOption C++ type to a UI field type + vector flag. */
export function mapType(coType) {
  const vector = /s$|sNullable$/.test(coType) && coType !== 'coFloatOrPercent'
  const base = coType.replace(/Nullable$/, '').replace(/s$/, '')
  let fieldType
  switch (base) {
    case 'coBool': fieldType = 'bool'; break
    case 'coInt': fieldType = 'int'; break
    case 'coFloat': fieldType = 'float'; break
    case 'coPercent': fieldType = 'percent'; break
    case 'coFloatOrPercent': fieldType = 'floatOrPercent'; break
    case 'coEnum': fieldType = 'enum'; break
    case 'coString': fieldType = 'string'; break
    case 'coPoint': fieldType = 'point'; break
    case 'coPoint3': fieldType = 'point'; break
    default: fieldType = 'string'; break
  }
  return { fieldType, vector }
}

/** Remove preprocessor directive lines; drop `#if 0`/`#if !1` blocks entirely, keep other directives' content. */
export function stripPreprocessor(code) {
  const lines = code.split('\n')
  const out = []
  let skipDepth = 0
  for (const line of lines) {
    const t = line.trim()
    if (/^#\s*if\s+(0|!\s*1)\b/.test(t)) { skipDepth++; continue }
    if (skipDepth > 0) {
      if (/^#\s*if/.test(t)) skipDepth++
      else if (/^#\s*endif/.test(t)) skipDepth--
      continue
    }
    if (/^#/.test(t)) continue
    out.push(line)
  }
  return out.join('\n')
}

/** Split C++ code into statements on top-level `;`, respecting string literals and line comments. */
export function splitStatements(rawCode) {
  const code = stripPreprocessor(rawCode)
  const stmts = []
  let cur = ''
  let i = 0
  let inStr = false
  let strCh = ''
  while (i < code.length) {
    const c = code[i]
    if (inStr) {
      cur += c
      if (c === '\\') { cur += code[i + 1] ?? ''; i += 2; continue }
      if (c === strCh) inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; strCh = c; cur += c; i++; continue }
    if (c === '/' && code[i + 1] === '/') { while (i < code.length && code[i] !== '\n') i++; continue }
    if (c === '/' && code[i + 1] === '*') { i += 2; while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++; i += 2; continue }
    if (c === ';') { stmts.push(cur); cur = ''; i++; continue }
    cur += c
    i++
  }
  if (cur.trim()) stmts.push(cur)
  return stmts
}

/** Concatenate adjacent C++ string literals in an expression, decoding escapes; ignores L() wrappers. */
export function extractString(expr) {
  const parts = []
  let i = 0
  let inStr = false
  let cur = ''
  while (i < expr.length) {
    const c = expr[i]
    if (inStr) {
      if (c === '\\') {
        const n = expr[i + 1]
        const map = { n: '\n', t: '\t', r: '', '"': '"', "'": "'", '\\': '\\' }
        cur += Object.hasOwn(map, n) ? map[n] : n
        i += 2
        continue
      }
      if (c === '"') { inStr = false; parts.push(cur); cur = ''; i++; continue }
      cur += c
      i++
      continue
    }
    if (c === '"') { inStr = true; i++; continue }
    i++
  }
  return parts.join('')
}

export function parseNumber(expr) {
  const m = /-?\d+(?:\.\d+)?/.exec(expr)
  return m ? Number(m[0]) : undefined
}

/** Parse a single option-definition block's statements into metadata. */
export function parseBlock(coType, block) {
  const { fieldType, vector } = mapType(coType)
  const opt = {
    type: fieldType,
    vector,
    label: '',
    tooltip: '',
    sidetext: '',
    category: '',
    enumValues: [],
    enumLabels: [],
    mode: 'simple',
    fullWidth: false,
    isCode: false,
    height: undefined,
    min: undefined,
    max: undefined,
    default: undefined,
    guiType: undefined
  }
  for (const stmt of splitStatements(block)) {
    const s = stmt.trim()
    if (!s.startsWith('def->')) continue
    if (s.startsWith('def->label')) opt.label = extractString(s)
    else if (s.startsWith('def->tooltip')) opt.tooltip = extractString(s)
    else if (s.startsWith('def->sidetext')) opt.sidetext = extractString(s)
    else if (s.startsWith('def->category')) opt.category = extractString(s)
    else if (s.startsWith('def->enum_values.push_back') || s.startsWith('def->enum_values.emplace_back')) opt.enumValues.push(extractString(s))
    else if (s.startsWith('def->enum_labels.push_back') || s.startsWith('def->enum_labels.emplace_back')) opt.enumLabels.push(extractString(s))
    else if (/^def->enum_values\s*=/.test(s)) {
      const ref = /(\w+)->enum_values/.exec(s.split('=')[1] ?? '')
      if (ref) opt.enumRefVar = ref[1]
    } else if (s.startsWith('def->mode')) {
      const m = /com\w+/.exec(s)
      if (m) opt.mode = MODE_MAP[m[0]] ?? 'simple'
    } else if (s.startsWith('def->min')) opt.min = parseNumber(s.split('=')[1] ?? '')
    else if (s.startsWith('def->max') && !s.startsWith('def->max_literal')) opt.max = parseNumber(s.split('=')[1] ?? '')
    else if (s.startsWith('def->full_width')) opt.fullWidth = /true/.test(s)
    else if (s.startsWith('def->is_code')) opt.isCode = /true/.test(s)
    else if (s.startsWith('def->height')) opt.height = parseNumber(s.split('=')[1] ?? '')
    else if (s.startsWith('def->gui_type')) {
      const m = /GUIType::(\w+)/.exec(s)
      if (m) opt.guiType = m[1]
    } else if (s.startsWith('def->set_default_value')) {
      if (fieldType === 'enum') {
        // Enum defaults reference a C++ symbol (e.g. ipRectilinear or
        // WallSequence::InnerOuter). Capture it now and resolve to the
        // serialized string via the s_keys_map_<Type> tables in resolveEnumDefaults.
        const em = /ConfigOptionEnum<(\w+)>\s*\(\s*([\w:]+)\s*\)/.exec(s)
        if (em) { opt.enumDefaultType = em[1]; opt.enumDefaultSymbol = em[2] }
      } else {
        opt.default = parseDefault(s, fieldType)
      }
    }
  }
  // Drop empties to keep generated data lean.
  if (!opt.sidetext) delete opt.sidetext
  if (!opt.category) delete opt.category
  if (opt.enumValues.length === 0 && !opt.enumRefVar) { delete opt.enumValues; delete opt.enumLabels }
  if (opt.min === undefined) delete opt.min
  if (opt.max === undefined) delete opt.max
  if (opt.height === undefined) delete opt.height
  if (opt.default === undefined) delete opt.default
  if (!opt.guiType) delete opt.guiType
  if (!opt.fullWidth) delete opt.fullWidth
  if (!opt.isCode) delete opt.isCode
  if (!opt.vector) delete opt.vector
  return opt
}

/**
 * Parses every `static t_config_enum_values s_keys_map_<Type> { ... }` table in
 * PrintConfig.cpp into a map of normalized C++ symbol -> serialized string, so
 * enum `set_default_value(...)` symbols can be turned into the string a preset
 * would store. Map values come in two forms: a bare symbol (`btAutoBrim`) or an
 * `int(Type::Member)` wrapper; both normalize to the trailing identifier.
 */
export function parseEnumKeyMaps(content) {
  const maps = new Map()
  const re = /t_config_enum_values\s+s_keys_map_(\w+)\s*(?:=)?\s*\{([\s\S]*?)\}\s*;/g
  let m
  while ((m = re.exec(content)) !== null) {
    const type = m[1]
    const entryRe = /\{\s*"([^"]*)"\s*,\s*([^}]+?)\s*\}/g
    const map = new Map()
    let e
    while ((e = entryRe.exec(m[2])) !== null) {
      const norm = normalizeEnumSymbol(e[2])
      if (!map.has(norm)) map.set(norm, e[1])
    }
    maps.set(type, map)
  }
  return maps
}

/** Reduces an enum value/symbol to its trailing identifier for cross-form matching. */
export function normalizeEnumSymbol(raw) {
  let s = raw.trim().replace(/^int\s*\(\s*/, '').replace(/\)\s*$/, '').trim()
  const idx = s.lastIndexOf('::')
  if (idx >= 0) s = s.slice(idx + 2)
  return s.trim()
}

/** Best-effort extraction of a serialized default value from set_default_value(...). */
export function parseDefault(stmt, fieldType) {
  const inner = stmt.slice(stmt.indexOf('(') + 1)
  if (fieldType === 'bool') {
    if (/\b(true|1)\b/.test(inner)) return '1'
    if (/\b(false|0)\b/.test(inner)) return '0'
    return undefined
  }
  if (fieldType === 'enum') {
    return undefined // handled separately via enum key maps (see resolveEnumDefaults)
  }
  if (fieldType === 'string') {
    if (/ConfigOptionString[^(]*\(\s*"/.test(inner)) return extractString(inner)
    return undefined
  }
  if (fieldType === 'percent') {
    const n = parseNumber(inner)
    return n === undefined ? undefined : `${n}%`
  }
  if (fieldType === 'floatOrPercent') {
    const n = parseNumber(inner)
    if (n === undefined) return undefined
    // The SECOND constructor argument is the percent flag — `ConfigOptionFloatOrPercent(400, true)`
    // and `ConfigOptionFloatsOrPercents{FloatOrPercent(10, true)}` both mean "400%"/"10%", not
    // 400 mm/10 mm. Dropping it made the catalog default a length, so a settings-dialog reset
    // silently converted an anchor length from 400% of the line width to 400 mm.
    const flagged = /\(\s*-?[\d.]+(?:e-?\d+)?\s*,\s*(true|1)\s*\)/i.test(inner)
    return flagged ? `${n}%` : String(n)
  }
  const n = parseNumber(inner)
  return n === undefined ? undefined : String(n)
}

/**
 * Index every option-definition block in `PrintConfig.cpp` by key, plus a var->key map so enum
 * copy-assignments (`def->enum_values = other_def->enum_values`) can be resolved. Returns
 * `{ blocks: Map<key,{coType,block}>, varToKey: Map<var,key> }`.
 */
export function indexOptionBlocks(content) {
  const addRe = /def\s*=\s*this->add(?:_nullable)?\(\s*"([^"]+)"\s*,\s*(co\w+)/g
  const matches = []
  let m
  while ((m = addRe.exec(content)) !== null) {
    matches.push({ key: m[1], coType: m[2], start: m.index })
  }
  const varToKey = new Map()
  const varRe = /(?:auto\s+)?(\w+)\s*=\s*def\s*=\s*this->add\(\s*"([^"]+)"/g
  let vm
  while ((vm = varRe.exec(content)) !== null) {
    if (vm[1] !== 'def') varToKey.set(vm[1], vm[2])
  }
  const blocks = new Map()
  for (let i = 0; i < matches.length; i++) {
    const next = matches[i + 1]?.start ?? content.length
    blocks.set(matches[i].key, { coType: matches[i].coType, block: content.slice(matches[i].start, next) })
  }
  return { blocks, varToKey }
}

/**
 * Resolve enum copy-assignments (`opt.enumRefVar`) and enum defaults (`opt.enumDefaultSymbol`) in
 * place across an options map, using the var->key map and the file's `s_keys_map_<Type>` tables.
 * The preset inheritance chain leaves many enum options unset, so without the default resolution
 * they render blank even though BambuStudio shows the PrintConfig default.
 */
export function resolveEnums(options, varToKey, content) {
  for (const opt of Object.values(options)) {
    if (opt.enumRefVar) {
      const sourceKey = varToKey.get(opt.enumRefVar)
      const source = sourceKey ? options[sourceKey] : undefined
      if (source && source.enumValues) {
        opt.enumValues = [...source.enumValues]
        opt.enumLabels = [...(source.enumLabels ?? [])]
      }
      delete opt.enumRefVar
    }
  }
  const enumMaps = parseEnumKeyMaps(content)
  for (const opt of Object.values(options)) {
    if (opt.enumDefaultSymbol) {
      const map = enumMaps.get(opt.enumDefaultType)
      const str = map?.get(normalizeEnumSymbol(opt.enumDefaultSymbol))
      if (str !== undefined) opt.default = str
      delete opt.enumDefaultType
      delete opt.enumDefaultSymbol
    }
  }
}
