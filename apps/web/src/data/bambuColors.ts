/**
 * First-party Bambu Lab filament color swatches.
 *
 * Sourced from Bambu Lab's official hex code PDFs and store pages
 * (mirrored from the Bambuddy `catalog_defaults.py` reference table),
 * with additional single-color material variants from BambuStudio's
 * `filaments_color_codes.json` catalog.
 *
 * Grouped by `material` so the AMS slot editor can show only the
 * swatches that apply to a selected preset (e.g. PLA Basic vs. PLA Silk).
 */

export interface BambuColorSwatch {
  /** Bambu's display name (e.g. "Jade White"). */
  name: string
  /** Upper-case hex like `#RRGGBB`. */
  hex: string
  /** Bambu material family (e.g. "PLA Basic", "PETG HF"). */
  material: string
}

export const BAMBU_COLOR_SWATCHES: BambuColorSwatch[] = [
  { name: 'Jade White', hex: '#FFFFFF', material: 'PLA Basic' },
  { name: 'Black', hex: '#000000', material: 'PLA Basic' },
  { name: 'Silver', hex: '#A6A9AA', material: 'PLA Basic' },
  { name: 'Light Gray', hex: '#D1D3D5', material: 'PLA Basic' },
  { name: 'Gray', hex: '#8E9089', material: 'PLA Basic' },
  { name: 'Dark Gray', hex: '#545454', material: 'PLA Basic' },
  { name: 'Red', hex: '#C12E1F', material: 'PLA Basic' },
  { name: 'Maroon Red', hex: '#9D2235', material: 'PLA Basic' },
  { name: 'Magenta', hex: '#EC008C', material: 'PLA Basic' },
  { name: 'Hot Pink', hex: '#F5547C', material: 'PLA Basic' },
  { name: 'Pink', hex: '#F55A74', material: 'PLA Basic' },
  { name: 'Beige', hex: '#F7E6DE', material: 'PLA Basic' },
  { name: 'Yellow', hex: '#F4EE2A', material: 'PLA Basic' },
  { name: 'Sunflower Yellow', hex: '#FEC600', material: 'PLA Basic' },
  { name: 'Gold', hex: '#E4BD68', material: 'PLA Basic' },
  { name: 'Orange', hex: '#FF6A13', material: 'PLA Basic' },
  { name: 'Pumpkin Orange', hex: '#FF9016', material: 'PLA Basic' },
  { name: 'Bright Green', hex: '#BECF00', material: 'PLA Basic' },
  { name: 'Bambu Green', hex: '#00AE42', material: 'PLA Basic' },
  { name: 'Mistletoe Green', hex: '#3F8E43', material: 'PLA Basic' },
  { name: 'Turquoise', hex: '#00B1B7', material: 'PLA Basic' },
  { name: 'Cyan', hex: '#0086D6', material: 'PLA Basic' },
  { name: 'Cyan', hex: '#00FFFF', material: 'PLA Basic' },
  { name: 'Blue', hex: '#0A2989', material: 'PLA Basic' },
  { name: 'Blue Grey', hex: '#5B6579', material: 'PLA Basic' },
  { name: 'Cobalt Blue', hex: '#0056B8', material: 'PLA Basic' },
  { name: 'Purple', hex: '#5E43B7', material: 'PLA Basic' },
  { name: 'Indigo Purple', hex: '#482960', material: 'PLA Basic' },
  { name: 'Brown', hex: '#9D432C', material: 'PLA Basic' },
  { name: 'Cocoa Brown', hex: '#6F5034', material: 'PLA Basic' },
  { name: 'Bronze', hex: '#847D48', material: 'PLA Basic' },
  { name: 'Ivory White', hex: '#FFFFFF', material: 'PLA Matte' },
  { name: 'Bone White', hex: '#CBC6B8', material: 'PLA Matte' },
  { name: 'Desert Tan', hex: '#E8DBB7', material: 'PLA Matte' },
  { name: 'Latte Brown', hex: '#D3B7A7', material: 'PLA Matte' },
  { name: 'Caramel', hex: '#AE835B', material: 'PLA Matte' },
  { name: 'Terracotta', hex: '#B15533', material: 'PLA Matte' },
  { name: 'Dark Brown', hex: '#7D6556', material: 'PLA Matte' },
  { name: 'Dark Chocolate', hex: '#4D3324', material: 'PLA Matte' },
  { name: 'Lilac Purple', hex: '#AE96D4', material: 'PLA Matte' },
  { name: 'Sakura Pink', hex: '#E8AFCF', material: 'PLA Matte' },
  { name: 'Mandarin Orange', hex: '#F99963', material: 'PLA Matte' },
  { name: 'Lemon Yellow', hex: '#F7D959', material: 'PLA Matte' },
  { name: 'Plum', hex: '#950051', material: 'PLA Matte' },
  { name: 'Scarlet Red', hex: '#DE4343', material: 'PLA Matte' },
  { name: 'Dark Red', hex: '#BB3D43', material: 'PLA Matte' },
  { name: 'Dark Green', hex: '#68724D', material: 'PLA Matte' },
  { name: 'Grass Green', hex: '#61C680', material: 'PLA Matte' },
  { name: 'Apple Green', hex: '#C2E189', material: 'PLA Matte' },
  { name: 'Ice Blue', hex: '#A3D8E1', material: 'PLA Matte' },
  { name: 'Sky Blue', hex: '#56B7E6', material: 'PLA Matte' },
  { name: 'Marine Blue', hex: '#0078BF', material: 'PLA Matte' },
  { name: 'Dark Blue', hex: '#042F56', material: 'PLA Matte' },
  { name: 'Ash Gray', hex: '#9B9EA0', material: 'PLA Matte' },
  { name: 'Nardo Gray', hex: '#757575', material: 'PLA Matte' },
  { name: 'Charcoal', hex: '#000000', material: 'PLA Matte' },
  { name: 'Gold', hex: '#F4A925', material: 'PLA Silk' },
  { name: 'Silver', hex: '#C8C8C8', material: 'PLA Silk' },
  { name: 'Titan Gray', hex: '#5F6367', material: 'PLA Silk' },
  { name: 'Blue', hex: '#008BDA', material: 'PLA Silk' },
  { name: 'Purple', hex: '#8671CB', material: 'PLA Silk' },
  { name: 'Candy Red', hex: '#D02727', material: 'PLA Silk' },
  { name: 'Candy Green', hex: '#018814', material: 'PLA Silk' },
  { name: 'Rose Gold', hex: '#BA9594', material: 'PLA Silk' },
  { name: 'Baby Blue', hex: '#A8C6EE', material: 'PLA Silk' },
  { name: 'Pink', hex: '#F7ADA6', material: 'PLA Silk' },
  { name: 'Mint', hex: '#96DCB9', material: 'PLA Silk' },
  { name: 'Champagne', hex: '#F3CFB2', material: 'PLA Silk' },
  { name: 'White', hex: '#FFFFFF', material: 'PLA Silk' },
  { name: 'Classic Gold Sparkle', hex: '#CEA629', material: 'PLA Sparkle' },
  { name: 'Slate Gray Sparkle', hex: '#8E9089', material: 'PLA Sparkle' },
  { name: 'Crimson Red Sparkle', hex: '#792B36', material: 'PLA Sparkle' },
  { name: 'Royal Purple Sparkle', hex: '#483D8B', material: 'PLA Sparkle' },
  { name: 'Alpine Green Sparkle', hex: '#3F5443', material: 'PLA Sparkle' },
  { name: 'Onyx Black Sparkle', hex: '#2D2B28', material: 'PLA Sparkle' },
  { name: 'Teal', hex: '#009FA1', material: 'PLA Translucent' },
  { name: 'Light Jade', hex: '#96D8AF', material: 'PLA Translucent' },
  { name: 'Blue', hex: '#0047BB', material: 'PLA Translucent' },
  { name: 'Mellow Yellow', hex: '#F5DBAB', material: 'PLA Translucent' },
  { name: 'Purple', hex: '#8344B0', material: 'PLA Translucent' },
  { name: 'Cherry Pink', hex: '#F5B6CD', material: 'PLA Translucent' },
  { name: 'Orange', hex: '#F74E02', material: 'PLA Translucent' },
  { name: 'Ice Blue', hex: '#B8CDE9', material: 'PLA Translucent' },
  { name: 'Red', hex: '#B50011', material: 'PLA Translucent' },
  { name: 'Lavender', hex: '#B8ACD6', material: 'PLA Translucent' },
  { name: 'Glow Green', hex: '#A1FFAC', material: 'PLA Glow' },
  { name: 'Glow Yellow', hex: '#F8FF80', material: 'PLA Glow' },
  { name: 'Glow Pink', hex: '#F17B8F', material: 'PLA Glow' },
  { name: 'Glow Blue', hex: '#7AC0E9', material: 'PLA Glow' },
  { name: 'Glow Orange', hex: '#FF9D5B', material: 'PLA Glow' },
  { name: 'Brown', hex: '#684A43', material: 'PLA Galaxy' },
  { name: 'Green', hex: '#3B665E', material: 'PLA Galaxy' },
  { name: 'Nebulae', hex: '#424379', material: 'PLA Galaxy' },
  { name: 'Purple', hex: '#594177', material: 'PLA Galaxy' },
  { name: 'Iridium Gold Metallic', hex: '#B39B84', material: 'PLA Metal' },
  { name: 'Copper Brown Metallic', hex: '#AA6443', material: 'PLA Metal' },
  { name: 'Oxide Green Metallic', hex: '#1D7C6A', material: 'PLA Metal' },
  { name: 'Cobalt Blue Metallic', hex: '#39699E', material: 'PLA Metal' },
  { name: 'Iron Gray Metallic', hex: '#43403D', material: 'PLA Metal' },
  { name: 'White Marble', hex: '#F7F3F0', material: 'PLA Marble' },
  { name: 'Red Granite', hex: '#AD4E38', material: 'PLA Marble' },
  { name: 'Black Walnut', hex: '#4F3F24', material: 'PLA Wood' },
  { name: 'Rosewood', hex: '#4C241C', material: 'PLA Wood' },
  { name: 'Clay Brown', hex: '#995F11', material: 'PLA Wood' },
  { name: 'Classic Birch', hex: '#918669', material: 'PLA Wood' },
  { name: 'White Oak', hex: '#D6CCA3', material: 'PLA Wood' },
  { name: 'Ochre Yellow', hex: '#C98935', material: 'PLA Wood' },
  { name: 'White', hex: '#FFFFFF', material: 'PLA Tough' },
  { name: 'Gray', hex: '#AFB1AE', material: 'PLA Tough' },
  { name: 'Black', hex: '#000000', material: 'PLA Tough' },
  { name: 'Silver', hex: '#959698', material: 'PLA Tough' },
  { name: 'Yellow', hex: '#F4D53F', material: 'PLA Tough' },
  { name: 'Cyan', hex: '#009BD8', material: 'PLA Tough' },
  { name: 'Orange', hex: '#DC3A27', material: 'PLA Tough' },
  { name: 'Burgundy Red', hex: '#951E23', material: 'PLA-CF' },
  { name: 'Iris Purple', hex: '#69398E', material: 'PLA-CF' },
  { name: 'Matcha Green', hex: '#5C9748', material: 'PLA-CF' },
  { name: 'Jeans Blue', hex: '#6E88BC', material: 'PLA-CF' },
  { name: 'Royal Blue', hex: '#2842AD', material: 'PLA-CF' },
  { name: 'Lava Gray', hex: '#4D5054', material: 'PLA-CF' },
  { name: 'Black', hex: '#000000', material: 'PLA-CF' },
  { name: 'White', hex: '#FFFFFF', material: 'ABS' },
  { name: 'Desert Tan', hex: '#E8DBB7', material: 'ABS' },
  { name: 'Olive', hex: '#789D4A', material: 'ABS' },
  { name: 'Azure', hex: '#489FDF', material: 'ABS' },
  { name: 'Navy Blue', hex: '#0C2340', material: 'ABS' },
  { name: 'Blue', hex: '#0A2CA5', material: 'ABS' },
  { name: 'Tangerine Yellow', hex: '#FFC72C', material: 'ABS' },
  { name: 'Orange', hex: '#FF6A13', material: 'ABS' },
  { name: 'Red', hex: '#D32941', material: 'ABS' },
  { name: 'Purple', hex: '#AF1685', material: 'ABS' },
  { name: 'Silver', hex: '#87909A', material: 'ABS' },
  { name: 'Black', hex: '#000000', material: 'ABS' },
  { name: 'White', hex: '#FFFAF2', material: 'ASA' },
  { name: 'Gray', hex: '#8A949E', material: 'ASA' },
  { name: 'Red', hex: '#E02928', material: 'ASA' },
  { name: 'Green', hex: '#00A6A0', material: 'ASA' },
  { name: 'Blue', hex: '#2140B4', material: 'ASA' },
  { name: 'Black', hex: '#000000', material: 'ASA' },
  { name: 'Yellow', hex: '#FFD00B', material: 'PETG HF' },
  { name: 'Orange', hex: '#F75403', material: 'PETG HF' },
  { name: 'Green', hex: '#00AE42', material: 'PETG HF' },
  { name: 'Red', hex: '#EB3A3A', material: 'PETG HF' },
  { name: 'Blue', hex: '#002E96', material: 'PETG HF' },
  { name: 'Black', hex: '#000000', material: 'PETG HF' },
  { name: 'White', hex: '#FFFFFF', material: 'PETG HF' },
  { name: 'Cream', hex: '#F9DFB9', material: 'PETG HF' },
  { name: 'Lime Green', hex: '#6EE53C', material: 'PETG HF' },
  { name: 'Forest Green', hex: '#39541A', material: 'PETG HF' },
  { name: 'Lake Blue', hex: '#1F79E5', material: 'PETG HF' },
  { name: 'Peanut Brown', hex: '#875718', material: 'PETG HF' },
  { name: 'Gray', hex: '#ADB1B2', material: 'PETG HF' },
  { name: 'Dark Gray', hex: '#515151', material: 'PETG HF' },
  { name: 'Translucent Gray', hex: '#8E8E8E', material: 'PETG Translucent' },
  { name: 'Translucent Light Blue', hex: '#61B0FF', material: 'PETG Translucent' },
  { name: 'Translucent Olive', hex: '#748C45', material: 'PETG Translucent' },
  { name: 'Translucent Brown', hex: '#C9A381', material: 'PETG Translucent' },
  { name: 'Translucent Teal', hex: '#77EDD7', material: 'PETG Translucent' },
  { name: 'Translucent Orange', hex: '#FF911A', material: 'PETG Translucent' },
  { name: 'Translucent Purple', hex: '#D6ABFF', material: 'PETG Translucent' },
  { name: 'Translucent Pink', hex: '#F9C1BD', material: 'PETG Translucent' },
  { name: 'Brick Red', hex: '#9F332A', material: 'PETG-CF' },
  { name: 'Violet Purple', hex: '#583061', material: 'PETG-CF' },
  { name: 'Indigo Blue', hex: '#324585', material: 'PETG-CF' },
  { name: 'Malachite Green', hex: '#16B08E', material: 'PETG-CF' },
  { name: 'Black', hex: '#000000', material: 'PETG-CF' },
  { name: 'Titan Gray', hex: '#565656', material: 'PETG-CF' },
  { name: 'White', hex: '#FFFFFF', material: 'TPU 95A' },
  { name: 'Yellow', hex: '#F3E600', material: 'TPU 95A' },
  { name: 'Blue', hex: '#0072CE', material: 'TPU 95A' },
  { name: 'Red', hex: '#C8102E', material: 'TPU 95A' },
  { name: 'Gray', hex: '#898D8D', material: 'TPU 95A' },
  { name: 'Black', hex: '#101820', material: 'TPU 95A' },
  { name: 'Black', hex: '#000000', material: 'TPU 90A' },
  { name: 'White', hex: '#FFFFFF', material: 'TPU 90A' },
  { name: 'Grape Jelly', hex: '#D6ABFF', material: 'TPU 90A' },
  { name: 'Crystal Blue', hex: '#7EB4E1', material: 'TPU 90A' },
  { name: 'Cocoa Brown', hex: '#5C4738', material: 'TPU 90A' },
  { name: 'Black', hex: '#1A1A1A', material: 'PAHT-CF' },
  { name: 'Natural', hex: '#F5F5DC', material: 'PLA Support' },
  { name: 'Natural', hex: '#F5F5DC', material: 'PVA Support' },
  // Additional single-color entries from BambuStudio's encoded color catalog.
  { name: 'Bambu Green', hex: '#00AE42', material: 'ABS' },
  { name: 'Beige', hex: '#DFD1A7', material: 'ABS' },
  { name: 'Lavender', hex: '#7248BD', material: 'ABS' },
  { name: 'Mint', hex: '#7AE1BF', material: 'ABS' },
  { name: 'Yellow', hex: '#FCE900', material: 'ABS' },
  { name: 'Black', hex: '#000000', material: 'ABS-GF' },
  { name: 'Blue', hex: '#0C3B95', material: 'ABS-GF' },
  { name: 'Gray', hex: '#C6C6C6', material: 'ABS-GF' },
  { name: 'Green', hex: '#61BF36', material: 'ABS-GF' },
  { name: 'Orange', hex: '#F48438', material: 'ABS-GF' },
  { name: 'Red', hex: '#E83100', material: 'ABS-GF' },
  { name: 'White', hex: '#FFFFFF', material: 'ABS-GF' },
  { name: 'Yellow', hex: '#FFE133', material: 'ABS-GF' },
  { name: 'White', hex: '#F5F1DD', material: 'ASA Aero' },
  { name: 'Black', hex: '#000000', material: 'ASA-CF' },
  { name: 'Black', hex: '#000000', material: 'PA6-CF' },
  { name: 'Black', hex: '#000000', material: 'PA6-GF' },
  { name: 'Blue', hex: '#75AED8', material: 'PA6-GF' },
  { name: 'Brown', hex: '#5B492F', material: 'PA6-GF' },
  { name: 'Gray', hex: '#353533', material: 'PA6-GF' },
  { name: 'Lime', hex: '#C5ED48', material: 'PA6-GF' },
  { name: 'Orange', hex: '#FF4800', material: 'PA6-GF' },
  { name: 'White', hex: '#EAEAE4', material: 'PA6-GF' },
  { name: 'Yellow', hex: '#FFCE00', material: 'PA6-GF' },
  { name: 'Black', hex: '#000000', material: 'PC' },
  { name: 'Clear Black', hex: '#686865', material: 'PC' },
  { name: 'Transparent', hex: '#FFFFFF', material: 'PC' },
  { name: 'Black', hex: '#000000', material: 'PC FR' },
  { name: 'Gray', hex: '#A8A8AA', material: 'PC FR' },
  { name: 'White', hex: '#FFFFFF', material: 'PC FR' },
  { name: 'Black', hex: '#000000', material: 'PET-CF' },
  { name: 'Black', hex: '#000000', material: 'PETG Basic' },
  { name: 'Dark Beige', hex: '#DBC8B6', material: 'PETG Basic' },
  { name: 'Dark Brown', hex: '#4F2C1D', material: 'PETG Basic' },
  { name: 'Gray', hex: '#7F7E83', material: 'PETG Basic' },
  { name: 'Green', hex: '#009639', material: 'PETG Basic' },
  { name: 'Misty Blue', hex: '#688197', material: 'PETG Basic' },
  { name: 'Navy Blue', hex: '#0086D6', material: 'PETG Basic' },
  { name: 'Orange', hex: '#FF671F', material: 'PETG Basic' },
  { name: 'Pine Green', hex: '#034638', material: 'PETG Basic' },
  { name: 'Red', hex: '#D6001C', material: 'PETG Basic' },
  { name: 'Reflex Blue', hex: '#001489', material: 'PETG Basic' },
  { name: 'White', hex: '#FFFFFF', material: 'PETG Basic' },
  { name: 'Yellow', hex: '#FCE300', material: 'PETG Basic' },
  { name: 'Red', hex: '#BC0900', material: 'PETG HF' },
  { name: 'Clear', hex: '#FFFFFF', material: 'PETG Translucent' },
  { name: 'Black', hex: '#000000', material: 'PLA Aero' },
  { name: 'Gray', hex: '#CDCECA', material: 'PLA Aero' },
  { name: 'White', hex: '#FFFFFF', material: 'PLA Aero' },
  { name: 'Green', hex: '#164B35', material: 'PLA Basic' },
  { name: 'UV Color Changing - White to Coral', hex: '#FFFFFF', material: 'PLA Dynamic' },
  { name: 'Black', hex: '#000000', material: 'PLA Lite' },
  { name: 'Blue', hex: '#004EA8', material: 'PLA Lite' },
  { name: 'Cocoa Brown', hex: '#745335', material: 'PLA Lite' },
  { name: 'Cyan', hex: '#4DAFDA', material: 'PLA Lite' },
  { name: 'Dark Gray', hex: '#8C8B8C', material: 'PLA Lite' },
  { name: 'Gray', hex: '#999D9D', material: 'PLA Lite' },
  { name: 'Green', hex: '#00BB31', material: 'PLA Lite' },
  { name: 'Matte Beige', hex: '#ECC3B2', material: 'PLA Lite' },
  { name: 'Orange', hex: '#FF671F', material: 'PLA Lite' },
  { name: 'Red', hex: '#C6001A', material: 'PLA Lite' },
  { name: 'Sunflower Yellow', hex: '#FFB549', material: 'PLA Lite' },
  { name: 'White', hex: '#FFFFFF', material: 'PLA Lite' },
  { name: 'Yellow', hex: '#EFE255', material: 'PLA Lite' },
  { name: 'Blue', hex: '#147BD1', material: 'PLA Silk' },
  { name: 'Copper', hex: '#5E4B3C', material: 'PLA Silk' },
  { name: 'Gold', hex: '#E5B03D', material: 'PLA Silk' },
  { name: 'Green', hex: '#4CE4A0', material: 'PLA Silk' },
  { name: 'Pink', hex: '#EEB1C1', material: 'PLA Silk' },
  { name: 'Purple', hex: '#854CE4', material: 'PLA Silk' },
  { name: 'Silver', hex: '#EAECEB', material: 'PLA Silk' },
  { name: 'Baby Blue', hex: '#A8C6EE', material: 'PLA Silk+' },
  { name: 'Blue', hex: '#008BDA', material: 'PLA Silk+' },
  { name: 'Candy Green', hex: '#018814', material: 'PLA Silk+' },
  { name: 'Candy Red', hex: '#D02727', material: 'PLA Silk+' },
  { name: 'Champagne', hex: '#F3CFB2', material: 'PLA Silk+' },
  { name: 'Gold', hex: '#F4A925', material: 'PLA Silk+' },
  { name: 'Mint', hex: '#96DCB9', material: 'PLA Silk+' },
  { name: 'Pink', hex: '#F7ADA6', material: 'PLA Silk+' },
  { name: 'Purple', hex: '#8671CB', material: 'PLA Silk+' },
  { name: 'Rose Gold', hex: '#BA9594', material: 'PLA Silk+' },
  { name: 'Silver', hex: '#C8C8C8', material: 'PLA Silk+' },
  { name: 'Titan Gray', hex: '#5F6367', material: 'PLA Silk+' },
  { name: 'White', hex: '#FFFFFF', material: 'PLA Silk+' },
  { name: 'Black', hex: '#25282A', material: 'PLA Tough' },
  { name: 'Gray', hex: '#515A6C', material: 'PLA Tough' },
  { name: 'Lavender Blue', hex: '#6667AB', material: 'PLA Tough' },
  { name: 'Light Blue', hex: '#0085AD', material: 'PLA Tough' },
  { name: 'Orange', hex: '#FF7F41', material: 'PLA Tough' },
  { name: 'Pine Green', hex: '#00482B', material: 'PLA Tough' },
  { name: 'Silver', hex: '#898D8D', material: 'PLA Tough' },
  { name: 'Vermilion Red', hex: '#DD3C22', material: 'PLA Tough' },
  { name: 'White', hex: '#F9F7F4', material: 'PLA Tough' },
  { name: 'Yellow', hex: '#FEDB00', material: 'PLA Tough' },
  { name: 'Black', hex: '#000000', material: 'PLA Tough+' },
  { name: 'Cyan', hex: '#009BD8', material: 'PLA Tough+' },
  { name: 'Gray', hex: '#AFB1AE', material: 'PLA Tough+' },
  { name: 'Orange', hex: '#DC3A27', material: 'PLA Tough+' },
  { name: 'Silver', hex: '#959698', material: 'PLA Tough+' },
  { name: 'White', hex: '#FFFFFF', material: 'PLA Tough+' },
  { name: 'Yellow', hex: '#F4D53F', material: 'PLA Tough+' },
  { name: 'Black', hex: '#000000', material: 'PPA-CF' },
  { name: 'Black', hex: '#000000', material: 'PPS-CF' },
  { name: 'Clear', hex: '#F0F1A8', material: 'PVA' },
  { name: 'White', hex: '#FFFFFF', material: 'Support for ABS' },
  { name: 'Green', hex: '#C0DF16', material: 'Support for PA/PET' },
  { name: 'Black', hex: '#000000', material: 'Support for PLA' },
  { name: 'White', hex: '#FFFFFF', material: 'Support for PLA' },
  { name: 'Nature', hex: '#000000', material: 'Support for PLA/PETG' },
  { name: 'Black', hex: '#000000', material: 'TPU 85A' },
  { name: 'Flesh', hex: '#F3CFB2', material: 'TPU 85A' },
  { name: 'Light Cyan', hex: '#C3E2D6', material: 'TPU 85A' },
  { name: 'Lime Green', hex: '#CDEA80', material: 'TPU 85A' },
  { name: 'Neon Orange', hex: '#F68B1B', material: 'TPU 85A' },
  { name: 'Quicksilver', hex: '#9EA2A2', material: 'TPU 90A' },
  { name: 'Black', hex: '#000000', material: 'TPU 95A' },
  { name: 'Black', hex: '#101820', material: 'TPU 95A HF' },
  { name: 'Blue', hex: '#0072CE', material: 'TPU 95A HF' },
  { name: 'Gray', hex: '#898D8D', material: 'TPU 95A HF' },
  { name: 'Red', hex: '#C8102E', material: 'TPU 95A HF' },
  { name: 'White', hex: '#FFFFFF', material: 'TPU 95A HF' },
  { name: 'Yellow', hex: '#F3E600', material: 'TPU 95A HF' },
  { name: 'Black', hex: '#000000', material: 'TPU for AMS' },
  { name: 'Blue', hex: '#5898DD', material: 'TPU for AMS' },
  { name: 'Gray', hex: '#939393', material: 'TPU for AMS' },
  { name: 'Neon Green', hex: '#90FF1A', material: 'TPU for AMS' },
  { name: 'Red', hex: '#ED0000', material: 'TPU for AMS' },
  { name: 'White', hex: '#FFFFFF', material: 'TPU for AMS' },
  { name: 'Yellow', hex: '#F9EF41', material: 'TPU for AMS' }
]

/**
 * Best-effort mapping from a Bambu preset display name (e.g. "Bambu PLA Silk+")
 * to the swatch material key (e.g. "PLA Silk"). Returns null when nothing
 * sensible matches; callers should fall back to type-based matching.
 */
export function bambuMaterialFromPresetName(name: string): string | null {
  const upper = name.toUpperCase()
  // Order matters: more specific matches first.
  if (upper.includes('SUPPORT FOR PLA/PETG')) return 'Support for PLA/PETG'
  if (upper.includes('SUPPORT FOR PA/PET')) return 'Support for PA/PET'
  if (upper.includes('SUPPORT FOR ABS')) return 'Support for ABS'
  if (upper.includes('SUPPORT FOR PLA')) return 'Support for PLA'
  if (upper.includes('PLA-CF') || upper.includes('PLA CF')) return 'PLA-CF'
  if (upper.includes('PETG-CF') || upper.includes('PETG CF')) return 'PETG-CF'
  if (upper.includes('PET-CF') || upper.includes('PET CF')) return 'PET-CF'
  if (upper.includes('ASA AERO')) return 'ASA Aero'
  if (upper.includes('ASA-CF') || upper.includes('ASA CF')) return 'ASA-CF'
  if (upper.includes('ABS-GF') || upper.includes('ABS GF')) return 'ABS-GF'
  if (upper.includes('PA6-GF') || upper.includes('PA6 GF')) return 'PA6-GF'
  if (upper.includes('PA6-CF') || upper.includes('PA6 CF')) return 'PA6-CF'
  if (upper.includes('PPA-CF') || upper.includes('PPA CF')) return 'PPA-CF'
  if (upper.includes('PPS-CF') || upper.includes('PPS CF')) return 'PPS-CF'
  if (upper.includes('PC FR') || upper.includes('PC-FR')) return 'PC FR'
  if (upper.includes('PC')) return 'PC'
  if (upper.includes('PETG TRANSLUCENT')) return 'PETG Translucent'
  if (upper.includes('PETG BASIC')) return 'PETG Basic'
  if (upper.includes('PETG HF')) return 'PETG HF'
  if (upper.includes('PLA TRANSLUCENT')) return 'PLA Translucent'
  if (upper.includes('PLA SILK+')) return 'PLA Silk+'
  if (upper.includes('PLA TOUGH+')) return 'PLA Tough+'
  if (upper.includes('PLA MATTE')) return 'PLA Matte'
  if (upper.includes('PLA METAL')) return 'PLA Metal'
  if (upper.includes('PLA SILK')) return 'PLA Silk'
  if (upper.includes('PLA SPARKLE')) return 'PLA Sparkle'
  if (upper.includes('PLA MARBLE')) return 'PLA Marble'
  if (upper.includes('PLA GLOW')) return 'PLA Glow'
  if (upper.includes('PLA GALAXY')) return 'PLA Galaxy'
  if (upper.includes('PLA WOOD')) return 'PLA Wood'
  if (upper.includes('PLA AERO')) return 'PLA Aero'
  if (upper.includes('PLA DYNAMIC')) return 'PLA Dynamic'
  if (upper.includes('PLA LITE')) return 'PLA Lite'
  if (upper.includes('PLA TOUGH')) return 'PLA Tough'
  if (upper.includes('PLA BASIC') || upper.includes('PLA HIGH SPEED') || upper === 'GENERIC PLA' || upper.includes('GENERIC PLA')) return 'PLA Basic'
  if (upper.includes('TPU FOR AMS')) return 'TPU for AMS'
  if (upper.includes('TPU 95') && upper.includes('HF')) return 'TPU 95A HF'
  if (upper.includes('TPU 90')) return 'TPU 90A'
  if (upper.includes('TPU 85')) return 'TPU 85A'
  if (upper.includes('TPU')) return 'TPU 95A'
  if (upper.includes('PETG')) return 'PETG HF'
  if (upper.includes('ABS')) return 'ABS'
  if (upper.includes('ASA')) return 'ASA'
  if (upper.includes('PAHT-CF') || upper.includes('PAHT CF')) return 'PAHT-CF'
  if (upper.includes('PA') && (upper.includes('CF') || upper.includes('GF') || upper.includes('PAHT') || upper.includes('PA6'))) return 'PAHT-CF'
  if (upper.includes('PVA')) return 'PVA'
  if (upper.includes('SUPPORT')) return 'PLA Support'
  return null
}

/**
 * Pick a swatch material based on a generic filament type (e.g. "PLA",
 * "PETG-CF", "TPU"). Used when the editor is in custom mode.
 */
export function bambuMaterialFromType(type: string): string | null {
  const upper = type.toUpperCase()
  if (upper === 'PLA-S') return 'Support for PLA'
  if (upper === 'PLA-CF') return 'PLA-CF'
  if (upper === 'PETG-CF') return 'PETG-CF'
  if (upper === 'PET-CF') return 'PET-CF'
  if (upper === 'PETG BASIC') return 'PETG Basic'
  if (upper === 'PETG' || upper === 'PCTG' || upper === 'PETG-ESD') return 'PETG HF'
  if (upper === 'PETG TRANSLUCENT') return 'PETG Translucent'
  if (upper === 'PLA') return 'PLA Basic'
  if (upper === 'PLA AERO') return 'PLA Aero'
  if (upper === 'PLA DYNAMIC') return 'PLA Dynamic'
  if (upper === 'PLA LITE') return 'PLA Lite'
  if (upper === 'PLA SILK+') return 'PLA Silk+'
  if (upper === 'PLA TOUGH+') return 'PLA Tough+'
  if (upper === 'PLA TOUGH') return 'PLA Tough'
  if (upper === 'ABS-GF') return 'ABS-GF'
  if (upper === 'ABS') return 'ABS'
  if (upper === 'ASA AERO') return 'ASA Aero'
  if (upper === 'ASA-CF') return 'ASA-CF'
  if (upper === 'ASA') return 'ASA'
  if (upper === 'PC FR' || upper === 'PC-FR') return 'PC FR'
  if (upper === 'PC') return 'PC'
  if (upper === 'PVA') return 'PVA'
  if (upper === 'TPU 85A') return 'TPU 85A'
  if (upper === 'TPU 90A') return 'TPU 90A'
  if (upper === 'TPU 95A') return 'TPU 95A'
  if (upper === 'TPU 95A HF') return 'TPU 95A HF'
  if (upper === 'TPU') return 'TPU 95A'
  if (upper === 'TPU FOR AMS') return 'TPU for AMS'
  if (upper === 'SUPPORT FOR ABS') return 'Support for ABS'
  if (upper === 'SUPPORT FOR PA/PET') return 'Support for PA/PET'
  if (upper === 'SUPPORT FOR PLA') return 'Support for PLA'
  if (upper === 'SUPPORT FOR PLA/PETG') return 'Support for PLA/PETG'
  if (upper === 'PAHT-CF') return 'PAHT-CF'
  if (upper === 'PA6-CF') return 'PA6-CF'
  if (upper === 'PA6-GF') return 'PA6-GF'
  if (upper === 'PPA-CF') return 'PPA-CF'
  if (upper === 'PPS-CF') return 'PPS-CF'
  if (upper.startsWith('PA')) return 'PAHT-CF'
  return null
}

export function bambuColorsForMaterial(material: string | null): BambuColorSwatch[] {
  if (!material) return []
  return BAMBU_COLOR_SWATCHES.filter((swatch) => swatch.material === material)
}

/**
 * Look up the full Bambu catalog swatch for a hex color, ignoring case
 * and any trailing alpha (printer/3MF colors are sometimes `RRGGBBAA`).
 * Returns `null` when the hex is not in the catalog.
 *
 * Many color names are reused across material families (e.g. "Black"
 * appears in both PLA Basic and PETG HF). When a material hint is
 * provided, prefer the swatch for that material before falling back
 * to the first global match.
 */
export function bambuSwatchForHex(hex: string | null | undefined, material: string | null | undefined = null): BambuColorSwatch | null {
  if (!hex) return null
  let normalized = hex.trim().toUpperCase()
  if (!normalized.startsWith('#')) normalized = `#${normalized}`
  // Strip alpha channel if present (#RRGGBBAA -> #RRGGBB).
  if (normalized.length === 9) normalized = normalized.slice(0, 7)
  if (!/^#[0-9A-F]{6}$/.test(normalized)) return null
  if (material) {
    const materialMatch = BAMBU_COLOR_SWATCHES.find(
      (swatch) => swatch.material === material && swatch.hex.toUpperCase() === normalized
    )
    if (materialMatch) return materialMatch
  }
  return BAMBU_COLOR_SWATCHES.find((swatch) => swatch.hex.toUpperCase() === normalized) ?? null
}

/** Convenience wrapper around {@link bambuSwatchForHex} that returns just the name. */
export function bambuColorName(hex: string | null | undefined, material: string | null | undefined = null): string | null {
  return bambuSwatchForHex(hex, material)?.name ?? null
}

/** Pick black or white text based on the perceived luminance of a `#RRGGBB` color. */
export function readableTextColor(hex: string): string {
  const value = hex.replace('#', '')
  if (value.length < 6) return '#fff'
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#1a1a1a' : '#fff'
}
