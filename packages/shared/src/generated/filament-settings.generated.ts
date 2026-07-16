/**
 * GENERATED FILE - DO NOT EDIT.
 * Produced by scripts/dev/generate-filament-settings.mjs from the BambuStudio
 * source (Tab.cpp TabFilament layout + PrintConfig.cpp metadata). Re-run the
 * generator to update. See packages/shared/src/filament-settings.ts for the
 * consuming types (shared with the process catalog).
 */
import type { ProcessSettingsCatalog } from '../process-settings.js'

export const filamentSettingsCatalog: ProcessSettingsCatalog = {
  "pages": [
    {
      "id": "filament",
      "title": "Filament",
      "groups": [
        {
          "title": "Basic information",
          "lines": [
            {
              "keys": [
                "filament_type"
              ]
            },
            {
              "keys": [
                "filament_vendor"
              ]
            },
            {
              "keys": [
                "filament_soluble"
              ]
            },
            {
              "keys": [
                "filament_is_support"
              ]
            },
            {
              "keys": [
                "impact_strength_z"
              ]
            },
            {
              "keys": [
                "required_nozzle_HRC"
              ]
            },
            {
              "keys": [
                "default_filament_colour"
              ]
            },
            {
              "keys": [
                "filament_diameter"
              ]
            },
            {
              "keys": [
                "filament_adhesiveness_category"
              ]
            },
            {
              "keys": [
                "filament_metal_stickiness"
              ]
            },
            {
              "keys": [
                "filament_flow_ratio"
              ]
            },
            {
              "keys": [
                "enable_pressure_advance"
              ]
            },
            {
              "keys": [
                "pressure_advance"
              ]
            },
            {
              "keys": [
                "filament_density"
              ]
            },
            {
              "keys": [
                "filament_shrink"
              ]
            },
            {
              "keys": [
                "filament_velocity_adaptation_factor"
              ]
            },
            {
              "keys": [
                "filament_cost"
              ]
            },
            {
              "keys": [
                "temperature_vitrification"
              ]
            },
            {
              "keys": [
                "filament_printable"
              ]
            },
            {
              "keys": [
                "filament_cooling_before_tower"
              ]
            },
            {
              "keys": [
                "filament_tower_interface_pre_extrusion_dist"
              ]
            },
            {
              "keys": [
                "filament_tower_interface_pre_extrusion_length"
              ]
            },
            {
              "keys": [
                "filament_tower_ironing_area"
              ]
            },
            {
              "keys": [
                "filament_tower_interface_purge_volume"
              ]
            },
            {
              "keys": [
                "filament_tower_interface_print_temp"
              ]
            },
            {
              "label": "Filament prime volume",
              "keys": [
                "filament_prime_volume",
                "filament_prime_volume_nc"
              ]
            },
            {
              "label": "Filament ramming length",
              "keys": [
                "filament_change_length",
                "filament_change_length_nc"
              ]
            },
            {
              "label": "Travel time after ramming",
              "keys": [
                "filament_ramming_travel_time",
                "filament_ramming_travel_time_nc"
              ]
            },
            {
              "label": "Precooling target temperature",
              "keys": [
                "filament_pre_cooling_temperature",
                "filament_pre_cooling_temperature_nc"
              ]
            },
            {
              "label": "Recommended nozzle temperature",
              "keys": [
                "nozzle_temperature_range_low",
                "nozzle_temperature_range_high"
              ]
            }
          ]
        },
        {
          "title": "Print temperature",
          "lines": [
            {
              "keys": [
                "chamber_temperatures"
              ]
            },
            {
              "label": "Bambu Cool Plate SuperTack",
              "keys": [
                "supertack_plate_temp_initial_layer",
                "supertack_plate_temp"
              ]
            },
            {
              "label": "Cool Plate",
              "keys": [
                "cool_plate_temp_initial_layer",
                "cool_plate_temp"
              ]
            },
            {
              "label": "Engineering Plate",
              "keys": [
                "eng_plate_temp_initial_layer",
                "eng_plate_temp"
              ]
            },
            {
              "label": "Smooth PEI Plate / High Temp Plate",
              "keys": [
                "hot_plate_temp_initial_layer",
                "hot_plate_temp"
              ]
            },
            {
              "label": "Textured PEI Plate",
              "keys": [
                "textured_plate_temp_initial_layer",
                "textured_plate_temp"
              ]
            },
            {
              "label": "Nozzle",
              "keys": [
                "nozzle_temperature_initial_layer",
                "nozzle_temperature"
              ]
            }
          ]
        },
        {
          "title": "Volumetric speed limitation",
          "lines": [
            {
              "keys": [
                "filament_adaptive_volumetric_speed"
              ]
            },
            {
              "keys": [
                "filament_max_volumetric_speed"
              ]
            },
            {
              "label": "Ramming volumetric speed",
              "keys": [
                "filament_ramming_volumetric_speed",
                "filament_ramming_volumetric_speed_nc"
              ]
            }
          ]
        },
        {
          "title": "Filament scarf seam settings",
          "lines": [
            {
              "keys": [
                "filament_scarf_seam_type"
              ]
            },
            {
              "keys": [
                "filament_scarf_height"
              ]
            },
            {
              "keys": [
                "filament_scarf_gap"
              ]
            },
            {
              "keys": [
                "filament_scarf_length"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "cooling",
      "title": "Cooling",
      "groups": [
        {
          "title": "Part cooling fan",
          "lines": [
            {
              "label": "Initial layer fan",
              "keys": [
                "close_fan_the_first_x_layers",
                "first_x_layer_part_fan_speed"
              ]
            },
            {
              "label": "Linear ramp up to",
              "keys": [
                "full_fan_speed_layer"
              ]
            },
            {
              "label": "Min fan speed threshold",
              "keys": [
                "fan_min_speed",
                "fan_cooling_layer_time"
              ]
            },
            {
              "label": "Max fan speed threshold",
              "keys": [
                "fan_max_speed",
                "slow_down_layer_time"
              ]
            },
            {
              "keys": [
                "reduce_fan_stop_start_freq"
              ]
            },
            {
              "keys": [
                "slow_down_for_layer_cooling"
              ]
            },
            {
              "keys": [
                "no_slow_down_for_cooling_on_outwalls"
              ]
            },
            {
              "keys": [
                "cooling_slowdown_logic"
              ]
            },
            {
              "keys": [
                "cooling_perimeter_transition_distance"
              ]
            },
            {
              "keys": [
                "slow_down_min_speed"
              ]
            },
            {
              "keys": [
                "enable_overhang_bridge_fan"
              ]
            },
            {
              "keys": [
                "overhang_fan_threshold"
              ]
            },
            {
              "keys": [
                "overhang_threshold_participating_cooling"
              ]
            },
            {
              "keys": [
                "overhang_fan_speed"
              ]
            },
            {
              "keys": [
                "pre_start_fan_time"
              ]
            },
            {
              "keys": [
                "ironing_fan_speed"
              ]
            }
          ]
        },
        {
          "title": "Auxiliary part cooling fan",
          "lines": [
            {
              "label": "Initial layer fan",
              "keys": [
                "close_additional_fan_first_x_layers",
                "first_x_layer_fan_speed"
              ]
            },
            {
              "label": "Linear ramp up",
              "keys": [
                "additional_fan_full_speed_layer",
                "additional_cooling_fan_speed"
              ]
            }
          ]
        },
        {
          "title": "Exhaust fan",
          "lines": [
            {
              "keys": [
                "activate_air_filtration"
              ]
            },
            {
              "label": "During print",
              "keys": [
                "during_print_exhaust_fan_speed"
              ]
            },
            {
              "label": "Complete print",
              "keys": [
                "complete_print_exhaust_fan_speed"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "setting-overrides",
      "title": "Setting Overrides",
      "groups": [
        {
          "title": "Retraction",
          "lines": [
            {
              "keys": [
                "filament_retraction_length"
              ]
            },
            {
              "keys": [
                "filament_z_hop"
              ]
            },
            {
              "keys": [
                "filament_z_hop_types"
              ]
            },
            {
              "keys": [
                "filament_retraction_speed"
              ]
            },
            {
              "keys": [
                "filament_deretraction_speed"
              ]
            },
            {
              "keys": [
                "filament_retract_length_nc"
              ]
            },
            {
              "keys": [
                "filament_retract_restart_extra"
              ]
            },
            {
              "keys": [
                "filament_retraction_minimum_travel"
              ]
            },
            {
              "keys": [
                "filament_retract_when_changing_layer"
              ]
            },
            {
              "keys": [
                "filament_wipe"
              ]
            },
            {
              "keys": [
                "filament_wipe_distance"
              ]
            },
            {
              "keys": [
                "filament_retract_before_wipe"
              ]
            },
            {
              "keys": [
                "filament_long_retractions_when_cut"
              ]
            },
            {
              "keys": [
                "filament_retraction_distances_when_cut"
              ]
            }
          ]
        },
        {
          "title": "Speed",
          "lines": [
            {
              "keys": [
                "override_process_overhang_speed"
              ]
            },
            {
              "keys": [
                "filament_enable_overhang_speed"
              ]
            },
            {
              "keys": [
                "filament_overhang_1_4_speed"
              ]
            },
            {
              "keys": [
                "filament_overhang_2_4_speed"
              ]
            },
            {
              "keys": [
                "filament_overhang_3_4_speed"
              ]
            },
            {
              "keys": [
                "filament_overhang_4_4_speed"
              ]
            },
            {
              "keys": [
                "filament_overhang_totally_speed"
              ]
            },
            {
              "keys": [
                "filament_bridge_speed"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "advanced",
      "title": "Advanced",
      "groups": [
        {
          "title": "Filament start G-code",
          "lines": [
            {
              "keys": [
                "filament_start_gcode"
              ],
              "fullWidth": true,
              "code": true,
              "height": 15
            }
          ]
        },
        {
          "title": "Filament end G-code",
          "lines": [
            {
              "keys": [
                "filament_end_gcode"
              ],
              "fullWidth": true,
              "code": true,
              "height": 15
            }
          ]
        }
      ]
    },
    {
      "id": "notes",
      "title": "Notes",
      "groups": [
        {
          "title": "Notes",
          "lines": [
            {
              "keys": [
                "filament_notes"
              ],
              "fullWidth": true,
              "height": 25
            }
          ]
        }
      ]
    },
    {
      "id": "multi-filament",
      "title": "Multi Filament",
      "groups": [
        {
          "title": "Multi Filament",
          "lines": [
            {
              "keys": [
                "filament_flush_temp"
              ]
            },
            {
              "keys": [
                "filament_flush_temp_fast"
              ]
            },
            {
              "keys": [
                "filament_flush_volumetric_speed"
              ]
            },
            {
              "keys": [
                "long_retractions_when_ec"
              ]
            },
            {
              "keys": [
                "retraction_distances_when_ec"
              ]
            }
          ]
        }
      ]
    }
  ],
  "options": {
    "filament_type": {
      "type": "string",
      "vector": true,
      "label": "Type",
      "tooltip": "The material type of filament",
      "enumValues": [
        "PLA",
        "ABS",
        "ASA",
        "ASA-CF",
        "PETG",
        "PCTG",
        "TPU",
        "TPU-AMS",
        "PC",
        "PA",
        "PA-CF",
        "PA-GF",
        "PA6-CF",
        "PLA-CF",
        "PET-CF",
        "PETG-CF",
        "PVA",
        "HIPS",
        "PLA-AERO",
        "PPS",
        "PPS-CF",
        "PPA-CF",
        "PPA-GF",
        "ABS-GF",
        "ASA-AERO",
        "PE",
        "PP",
        "EVA",
        "PHA",
        "BVOH",
        "PE-CF",
        "PP-CF",
        "PP-GF"
      ],
      "enumLabels": [],
      "mode": "simple",
      "guiType": "f_enum_open"
    },
    "filament_vendor": {
      "type": "string",
      "vector": true,
      "label": "Vendor",
      "tooltip": "Vendor of filament. For show only",
      "mode": "advanced",
      "default": "(Undefined)"
    },
    "filament_soluble": {
      "type": "bool",
      "vector": true,
      "label": "Soluble material",
      "tooltip": "Soluble material is commonly used to print support and support interface",
      "mode": "develop",
      "default": "0"
    },
    "filament_is_support": {
      "type": "bool",
      "vector": true,
      "label": "Support material",
      "tooltip": "Support material is commonly used to print support and support interface",
      "mode": "develop",
      "default": "0"
    },
    "impact_strength_z": {
      "type": "float",
      "vector": true,
      "label": "Impact Strength Z",
      "tooltip": "",
      "mode": "develop",
      "default": "0"
    },
    "required_nozzle_HRC": {
      "type": "int",
      "vector": true,
      "label": "Required nozzle HRC",
      "tooltip": "Minimum HRC of nozzle required to print the filament. Zero means no checking of nozzle's HRC.",
      "mode": "develop",
      "min": 0,
      "max": 500,
      "default": "0"
    },
    "default_filament_colour": {
      "type": "string",
      "vector": true,
      "label": "Default color",
      "tooltip": "Default filament color",
      "mode": "advanced",
      "guiType": "color"
    },
    "filament_diameter": {
      "type": "float",
      "vector": true,
      "label": "Diameter",
      "tooltip": "Filament diameter is used to calculate extrusion in gcode, so it's important and should be accurate",
      "sidetext": "mm",
      "mode": "simple",
      "min": 0,
      "default": "1.75"
    },
    "filament_adhesiveness_category": {
      "type": "int",
      "vector": true,
      "label": "Adhesiveness Category",
      "tooltip": "Filament category",
      "mode": "develop",
      "min": 0,
      "default": "0"
    },
    "filament_metal_stickiness": {
      "type": "enum",
      "vector": true,
      "label": "Metal stickiness",
      "tooltip": "Indicates how strongly the filament tends to stick to the metal nozzle and leave residue. \"None\" means untested or custom filament, behaves the same as Low. Low: e.g. PLA - retraction can be safely skipped in infill areas. Medium: moderate stickiness - use with caution. High: e.g. PETG - retraction should not be skipped to avoid oozing artifacts on outer walls.",
      "enumValues": [
        "None",
        "Low",
        "Medium",
        "High"
      ],
      "enumLabels": [
        "None",
        "Low",
        "Medium",
        "High"
      ],
      "mode": "advanced"
    },
    "filament_flow_ratio": {
      "type": "float",
      "vector": true,
      "label": "Flow ratio",
      "tooltip": "The material may have volumetric change after switching between molten state and crystalline state. This setting changes all extrusion flow of this filament in gcode proportionally. Recommended value range is between 0.95 and 1.05. Maybe you can tune this value to get nice flat surface when there has slight overflow or underflow",
      "mode": "advanced",
      "max": 2,
      "default": "1"
    },
    "enable_pressure_advance": {
      "type": "bool",
      "vector": true,
      "label": "Enable pressure advance",
      "tooltip": "Enable pressure advance, auto calibration result will be overwriten once enabled. Useless for Bambu Printer",
      "mode": "simple",
      "default": "0"
    },
    "pressure_advance": {
      "type": "float",
      "vector": true,
      "label": "Pressure advance",
      "tooltip": "Pressure advance(Klipper) AKA Linear advance factor(Marlin). Useless for Bambu Printer",
      "mode": "advanced",
      "max": 2,
      "default": "0.02"
    },
    "filament_density": {
      "type": "float",
      "vector": true,
      "label": "Density",
      "tooltip": "Filament density. For statistics only",
      "sidetext": "g/cm³",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_shrink": {
      "type": "percent",
      "vector": true,
      "label": "Shrinkage",
      "tooltip": "Enter the shrinkage percentage that the filament will get after cooling (94% if you measure 94mm instead of 100mm). The part will be scaled in xy to compensate. Only the filament used for the perimeter is taken into account.\nBe sure to allow enough space between objects, as this compensation is done after the checks.",
      "sidetext": "%",
      "mode": "advanced",
      "min": 10,
      "default": "100%"
    },
    "filament_velocity_adaptation_factor": {
      "type": "float",
      "vector": true,
      "label": "Velocity Adaptation Factor",
      "tooltip": "This parameter reflects the speed at which a material transitions from one state to another. It, along with the smooth coefficient, determines the final length of the transition zone. A larger value: requires a shorter transition zone. A smaller value: requires a longer transition zone to avoid flow instability.",
      "mode": "simple",
      "min": 0,
      "default": "1"
    },
    "filament_cost": {
      "type": "float",
      "vector": true,
      "label": "Price",
      "tooltip": "Filament price. For statistics only",
      "sidetext": "money/kg",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "temperature_vitrification": {
      "type": "int",
      "vector": true,
      "label": "Softening temperature",
      "tooltip": "The material softens at this temperature, so when the bed temperature is equal to or greater than it, it's highly recommended to open the front door and/or remove the upper glass to avoid cloggings.",
      "mode": "simple",
      "default": "100"
    },
    "filament_printable": {
      "type": "int",
      "vector": true,
      "label": "Filament printable",
      "tooltip": "The filament is printable in extruder",
      "mode": "develop",
      "default": "3"
    },
    "filament_cooling_before_tower": {
      "type": "float",
      "vector": true,
      "label": "Wipe tower cooling",
      "tooltip": "Temperature drop before entering filament tower",
      "sidetext": "°C",
      "mode": "develop",
      "default": "10"
    },
    "filament_tower_interface_pre_extrusion_dist": {
      "type": "float",
      "vector": true,
      "label": "Interface layer pre-extrusion distance",
      "tooltip": "Pre-extrusion distance for prime tower interface layer (where different materials meet).",
      "sidetext": "mm",
      "mode": "develop",
      "min": 0,
      "default": "10"
    },
    "filament_tower_interface_pre_extrusion_length": {
      "type": "float",
      "vector": true,
      "label": "Interface layer pre-extrusion length",
      "tooltip": "Pre-extrusion length for prime tower interface layer (where different materials meet).",
      "sidetext": "mm",
      "mode": "develop",
      "min": 0,
      "default": "0"
    },
    "filament_tower_ironing_area": {
      "type": "float",
      "vector": true,
      "label": "Tower ironing area",
      "tooltip": "Ironing area for prime tower interface layer (where different materials meet).",
      "sidetext": "mm²",
      "mode": "develop",
      "min": 0,
      "default": "4"
    },
    "filament_tower_interface_purge_volume": {
      "type": "float",
      "vector": true,
      "label": "Interface layer purge length",
      "tooltip": "Purge length for prime tower interface layer (where different materials meet).",
      "sidetext": "mm",
      "mode": "develop",
      "min": 0,
      "default": "20"
    },
    "filament_tower_interface_print_temp": {
      "type": "int",
      "vector": true,
      "label": "Interface layer print temperature",
      "tooltip": "Print temperature for prime tower interface layer (where different materials meet). If set to -1, use max recommended nozzle temperature.",
      "sidetext": "°C",
      "mode": "develop",
      "min": -1,
      "default": "-1"
    },
    "filament_prime_volume": {
      "type": "float",
      "vector": true,
      "label": "Filament change",
      "tooltip": "The volume of material required to prime the extruder on the tower, excluding a hotend change.",
      "sidetext": "mm³",
      "mode": "simple",
      "min": 1,
      "default": "45"
    },
    "filament_prime_volume_nc": {
      "type": "float",
      "vector": true,
      "label": "Hotend change",
      "tooltip": "The volume of material required to prime the extruder for a hotend change on the tower.",
      "sidetext": "mm³",
      "mode": "simple",
      "min": 1,
      "default": "60"
    },
    "filament_change_length": {
      "type": "float",
      "vector": true,
      "label": "Extruder change",
      "tooltip": "When changing the extruder, it is recommended to extrude a certain length of filament from the original extruder. This helps minimize nozzle oozing.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "filament_change_length_nc": {
      "type": "float",
      "vector": true,
      "label": "Hotend change",
      "tooltip": "When changing the hotend, it is recommended to extrude a certain length of filament from the original nozzle. This helps minimize nozzle oozing.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "filament_ramming_travel_time": {
      "type": "float",
      "vector": true,
      "label": "Extruder change",
      "tooltip": "To prevent oozing, the nozzle will perform a reverse travel movement for a certain period after the ramming is complete. The setting define the travel time.",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_ramming_travel_time_nc": {
      "type": "float",
      "vector": true,
      "label": "Hotend change",
      "tooltip": "To prevent oozing, the nozzle will perform a reverse travel movement for a certain period after the ramming is complete. The setting define the travel time.",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_pre_cooling_temperature": {
      "type": "int",
      "vector": true,
      "label": "Extruder change",
      "tooltip": "To prevent oozing, the nozzle temperature will be cooled during ramming. Therefore, the ramming time must be greater than the cooldown time. 0 means disabled.",
      "sidetext": "°C",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_pre_cooling_temperature_nc": {
      "type": "int",
      "vector": true,
      "label": "Hotend change",
      "tooltip": "To prevent oozing, the nozzle temperature will be cooled during ramming. Note: only a cooldown command and fan activation are triggered, reaching the target temperature is not guaranteed. 0 means disabled.",
      "sidetext": "°C",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "nozzle_temperature_range_low": {
      "type": "int",
      "vector": true,
      "label": "Min",
      "tooltip": "",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "default": "190"
    },
    "nozzle_temperature_range_high": {
      "type": "int",
      "vector": true,
      "label": "Max",
      "tooltip": "",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "default": "240"
    },
    "chamber_temperatures": {
      "type": "int",
      "vector": true,
      "label": "Chamber temperature",
      "tooltip": "Higher chamber temperature can help suppress or reduce warping and potentially lead to higher interlayer bonding strength for high temperature materials like ABS, ASA, PC, PA and so on.At the same time, the air filtration of ABS and ASA will get worse.While for PLA, PETG, TPU, PVA and other low temperature materials,the actual chamber temperature should not be high to avoid cloggings, so 0 which stands for turning off is highly recommended",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 80,
      "default": "0"
    },
    "supertack_plate_temp_initial_layer": {
      "type": "int",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Bed temperature of the initial layer. Value 0 means the filament does not support to print on the Bambu Cool Plate SuperTack",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "35"
    },
    "supertack_plate_temp": {
      "type": "int",
      "vector": true,
      "label": "Other layers",
      "tooltip": "Bed temperature for layers except the initial one. Value 0 means the filament does not support to print on the Cool Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "35"
    },
    "cool_plate_temp_initial_layer": {
      "type": "int",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Bed temperature of the initial layer. Value 0 means the filament does not support to print on the Cool Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "35"
    },
    "cool_plate_temp": {
      "type": "int",
      "vector": true,
      "label": "Other layers",
      "tooltip": "Bed temperature for layers except the initial one. Value 0 means the filament does not support to print on the Cool Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "35"
    },
    "eng_plate_temp_initial_layer": {
      "type": "int",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Bed temperature of the initial layer. Value 0 means the filament does not support to print on the Engineering Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "45"
    },
    "eng_plate_temp": {
      "type": "int",
      "vector": true,
      "label": "Other layers",
      "tooltip": "Bed temperature for layers except the initial one. Value 0 means the filament does not support to print on the Engineering Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "45"
    },
    "hot_plate_temp_initial_layer": {
      "type": "int",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Bed temperature of the initial layer. Value 0 means the filament does not support to print on the High Temp Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "45"
    },
    "hot_plate_temp": {
      "type": "int",
      "vector": true,
      "label": "Other layers",
      "tooltip": "Bed temperature for layers except the initial one. Value 0 means the filament does not support to print on the High Temp Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "45"
    },
    "textured_plate_temp_initial_layer": {
      "type": "int",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Bed temperature of the initial layer. Value 0 means the filament does not support to print on the Textured PEI Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "45"
    },
    "textured_plate_temp": {
      "type": "int",
      "vector": true,
      "label": "Other layers",
      "tooltip": "Bed temperature for layers except the initial one. Value 0 means the filament does not support to print on the Textured PEI Plate",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "max": 120,
      "default": "45"
    },
    "nozzle_temperature_initial_layer": {
      "type": "int",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Nozzle temperature to print initial layer when using this filament",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "default": "200"
    },
    "nozzle_temperature": {
      "type": "int",
      "vector": true,
      "label": "Other layers",
      "tooltip": "Nozzle temperature for layers after the initial one",
      "sidetext": "°C",
      "mode": "simple",
      "min": 0,
      "default": "200"
    },
    "filament_adaptive_volumetric_speed": {
      "type": "bool",
      "vector": true,
      "label": "Adaptive volumetric speed",
      "tooltip": "When enabled, the extrusion flow is limited by the smaller of the fitted value (calculated from line width and layer height) and the user-defined maximum flow. When disabled, only the user-defined maximum flow is applied.",
      "mode": "advanced",
      "default": "0"
    },
    "filament_max_volumetric_speed": {
      "type": "float",
      "vector": true,
      "label": "Max volumetric speed",
      "tooltip": "This setting stands for how much volume of filament can be melted and extruded per second. Printing speed is limited by max volumetric speed, in case of too high and unreasonable speed setting. Can't be zero",
      "sidetext": "mm³/s",
      "mode": "advanced",
      "min": 0,
      "max": 200,
      "default": "2"
    },
    "filament_ramming_volumetric_speed": {
      "type": "float",
      "vector": true,
      "label": "Extruder change",
      "tooltip": "The maximum volumetric speed for ramming before extruder change, where -1 means using the maximum volumetric speed.",
      "sidetext": "mm³/s",
      "mode": "advanced",
      "min": -1,
      "max": 200,
      "default": "-1"
    },
    "filament_ramming_volumetric_speed_nc": {
      "type": "float",
      "vector": true,
      "label": "Hotend change",
      "tooltip": "The maximum volumetric speed for ramming before a hotend change, where -1 means using the maximum volumetric speed.",
      "sidetext": "mm³/s",
      "mode": "advanced",
      "min": -1,
      "max": 200,
      "default": "-1"
    },
    "filament_scarf_seam_type": {
      "type": "enum",
      "vector": true,
      "label": "Scarf seam type",
      "tooltip": "Set scarf seam type for this filament. This setting could minimize seam visibiliy.",
      "enumValues": [
        "none",
        "external",
        "all"
      ],
      "enumLabels": [
        "None",
        "Contour",
        "Contour and hole"
      ],
      "mode": "advanced"
    },
    "filament_scarf_height": {
      "type": "string",
      "vector": true,
      "label": "Scarf start height",
      "tooltip": "This amount can be specified in millimeters or as a percentage of the current layer height.",
      "sidetext": "mm/%",
      "mode": "advanced",
      "min": 0
    },
    "filament_scarf_gap": {
      "type": "string",
      "vector": true,
      "label": "Scarf slope gap",
      "tooltip": "In order to reduce the visiblity of the seam in closed loop, the inner wall and outer wall are shortened by a specified amount.",
      "sidetext": "mm/%",
      "mode": "advanced",
      "min": 0
    },
    "filament_scarf_length": {
      "type": "float",
      "vector": true,
      "label": "Scarf length",
      "tooltip": "Length of the scarf. Setting this parameter to zero effectively disables the scarf.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "close_fan_the_first_x_layers": {
      "type": "int",
      "vector": true,
      "label": "For the first",
      "tooltip": "Set special cooling fan for the first certain layers.The part cooling fan of the first layer used to be closed to get better build plate adhesion and used for auto cooling function",
      "sidetext": "layers",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "1"
    },
    "first_x_layer_part_fan_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Part cooling fan speed for the first few layers. Set to 0 to disable the part cooling fan on the initial layers for better bed adhesion",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "full_fan_speed_layer": {
      "type": "int",
      "vector": true,
      "label": "Full fan speed at layer",
      "tooltip": "",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "0"
    },
    "fan_min_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Minimum speed for part cooling fan",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "20"
    },
    "fan_cooling_layer_time": {
      "type": "int",
      "vector": true,
      "label": "Layer time",
      "tooltip": "Part cooling fan will be enabled for layers of which estimated time is shorter than this value. Fan speed is interpolated between the minimum and maximum fan speeds according to layer printing time",
      "sidetext": "s",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "60"
    },
    "fan_max_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Part cooling fan speed may be increased when auto cooling is enabled. This is the maximum speed limitation of part cooling fan",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "100"
    },
    "slow_down_layer_time": {
      "type": "int",
      "vector": true,
      "label": "Layer time",
      "tooltip": "The printing speed in exported gcode will be slowed down, when the estimated layer time is shorter than this value, to get better cooling for these layers",
      "sidetext": "s",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "5"
    },
    "reduce_fan_stop_start_freq": {
      "type": "bool",
      "vector": true,
      "label": "Keep fan always on",
      "tooltip": "If enable this setting, part cooling fan will never be stopped and will run at least at minimum speed to reduce the frequency of starting and stopping",
      "mode": "simple",
      "default": "0"
    },
    "slow_down_for_layer_cooling": {
      "type": "bool",
      "vector": true,
      "label": "Slow printing down for better layer cooling",
      "tooltip": "Enable this option to slow printing speed down to make the final layer time not shorter than the layer time threshold in \"Max fan speed threshold\", so that layer can be cooled for a longer time. This can improve the cooling quality for needle and small details",
      "mode": "simple",
      "default": "1"
    },
    "no_slow_down_for_cooling_on_outwalls": {
      "type": "bool",
      "vector": true,
      "label": "Don't slow down outer walls",
      "tooltip": "If enabled, this setting will ensure external perimeters are not slowed down to meet the minimum layer time. This is particularly helpful in the below scenarios:\n1. To avoid changes in shine when printing glossy filaments\n2. To avoid changes in external wall speed which may create slight wall artifacts that appear like Z banding\n3. To avoid printing at speeds which cause VFAs (fine artifacts) on the external walls",
      "mode": "advanced",
      "default": "0"
    },
    "cooling_slowdown_logic": {
      "type": "enum",
      "vector": true,
      "label": "Cooling slowdown logic",
      "tooltip": "Determines how the printer slows down when minimum layer time isn't reached.\n\n'Uniform cooling' slows down all print features equally (current default behavior).\n\n'Consistent surface' prioritizes slowing infill and internal perimeters first, preserving external perimeter speed for better surface finish on glossy filaments. This helps reduce VFA (Vertical Fine Artifacts) and maintains consistent surface shine.",
      "enumValues": [
        "uniform_cooling",
        "consistent_surface"
      ],
      "enumLabels": [
        "Uniform cooling",
        "Consistent surface"
      ],
      "mode": "develop"
    },
    "cooling_perimeter_transition_distance": {
      "type": "float",
      "vector": true,
      "label": "Perimeter transition distance",
      "tooltip": "Distance in millimeters before the end of slowed perimeters where the original print speed is gradually restored. This reduces quality issues when transitioning from slowed features to fast external perimeter printing.\n\nOnly applies when 'Consistent surface' cooling logic is selected.\nRecommended value: 5-10mm. Set to 0 to disable.",
      "sidetext": "mm",
      "mode": "develop",
      "min": 0,
      "max": 50,
      "default": "10"
    },
    "slow_down_min_speed": {
      "type": "float",
      "vector": true,
      "label": "Min print speed",
      "tooltip": "The minimum printing speed when slow down for cooling",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "enable_overhang_bridge_fan": {
      "type": "bool",
      "vector": true,
      "label": "Force cooling for overhang and bridge",
      "tooltip": "Enable this option to optimize part cooling fan speed for overhang and bridge to get better cooling",
      "mode": "simple",
      "default": "1"
    },
    "overhang_fan_threshold": {
      "type": "enum",
      "vector": true,
      "label": "Cooling overhang threshold",
      "tooltip": "Force cooling fan to be specific speed when overhang degree of printed part exceeds this value. Expressed as percentage which indicides how much width of the line without support from lower layer. 0% means forcing cooling for all outer wall no matter how much overhang degree",
      "enumValues": [
        "0%",
        "10%",
        "25%",
        "50%",
        "75%",
        "95%"
      ],
      "enumLabels": [
        "0%",
        "10%",
        "25%",
        "50%",
        "75%",
        "95%"
      ],
      "mode": "advanced"
    },
    "overhang_threshold_participating_cooling": {
      "type": "enum",
      "vector": true,
      "label": "Overhang threshold for participating cooling",
      "tooltip": "Decide which overhang part join the cooling function to slow down the speed.Expressed as percentage which indicides how much width of the line without support from lower layer. 100% means forcing cooling for all outer wall no matter how much overhang degree",
      "enumValues": [
        "0%",
        "10%",
        "25%",
        "50%",
        "75%",
        "100%"
      ],
      "enumLabels": [
        "0%",
        "10%",
        "25%",
        "50%",
        "75%",
        "100%"
      ],
      "mode": "advanced"
    },
    "overhang_fan_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed for overhang",
      "tooltip": "Force part cooling fan to be at this speed when printing bridge or overhang wall which has large overhang degree. Forcing cooling for overhang and bridge can get better quality for these part",
      "sidetext": "%",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "100"
    },
    "pre_start_fan_time": {
      "type": "float",
      "vector": true,
      "label": "Pre start fan time",
      "tooltip": "Force fan start early(0-5 second) when encountering overhangs. This is because the fan needs time to physically increase its speed.",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "max": 5,
      "default": "0"
    },
    "ironing_fan_speed": {
      "type": "int",
      "vector": true,
      "label": "Ironing fan speed",
      "tooltip": "This part cooling fan speed is applied when ironing. Setting this parameter to a lower than regular speed reduces possible nozzle clogging due to the low volumetric flow rate, making the interface smoother. Set to -1 to disable it.",
      "sidetext": "%",
      "mode": "advanced",
      "min": -1,
      "max": 100,
      "default": "-1"
    },
    "close_additional_fan_first_x_layers": {
      "type": "int",
      "vector": true,
      "label": "For the first",
      "tooltip": "Set special auxiliary cooling fan for the first certain layers.",
      "sidetext": "layers",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "1"
    },
    "first_x_layer_fan_speed": {
      "type": "float",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Special auxiliary cooling fan speed, effective only for the first x layers",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "additional_fan_full_speed_layer": {
      "type": "int",
      "vector": true,
      "label": "Full fan speed at layer",
      "tooltip": "Auxiliary fan speed will be ramped up linearly from layer \"For the first\" to maximum at layer \"Full fan speed at layer\". \"Full fan speed at layer\" will be ignored if lower than \"For the first\", in which case the fan will be running at maximum allowed speed at layer \"For the first\" + 1.",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "0"
    },
    "additional_cooling_fan_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Speed of auxiliary part cooling fan. Auxiliary fan will run at this speed during printing except the first several layers which are defined by no cooling layers",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "activate_air_filtration": {
      "type": "bool",
      "vector": true,
      "label": "Activate air filtration",
      "tooltip": "Activate for better air filtration",
      "mode": "simple",
      "default": "0"
    },
    "during_print_exhaust_fan_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Speed of exhaust fan during printing.This speed will overwrite the speed in filament custom gcode",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "60"
    },
    "complete_print_exhaust_fan_speed": {
      "type": "int",
      "vector": true,
      "label": "Fan speed",
      "tooltip": "Speed of exhuast fan after printing completes",
      "sidetext": "%",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "80"
    },
    "filament_retraction_length": {
      "type": "float",
      "vector": true,
      "label": "Length",
      "tooltip": "Some amount of material in extruder is pulled back to avoid ooze during long travel. Set zero to disable retraction",
      "sidetext": "mm",
      "mode": "simple",
      "default": "0.8"
    },
    "filament_z_hop": {
      "type": "float",
      "vector": true,
      "label": "Z hop when retract",
      "tooltip": "Whenever the retraction is done, the nozzle is lifted a little to create clearance between nozzle and the print. It prevents nozzle from hitting the print when travel moves. Using spiral line to lift z can prevent stringing",
      "sidetext": "mm",
      "mode": "simple",
      "min": 0,
      "max": 5,
      "default": "0.4"
    },
    "filament_z_hop_types": {
      "type": "enum",
      "vector": true,
      "label": "Z Hop Type",
      "tooltip": "",
      "enumValues": [
        "Auto Lift",
        "Normal Lift",
        "Slope Lift",
        "Spiral Lift"
      ],
      "enumLabels": [
        "Auto",
        "Normal",
        "Slope",
        "Spiral"
      ],
      "mode": "advanced"
    },
    "filament_retraction_speed": {
      "type": "float",
      "vector": true,
      "label": "Retraction Speed",
      "tooltip": "Speed of retractions",
      "sidetext": "mm/s",
      "mode": "advanced",
      "default": "30"
    },
    "filament_deretraction_speed": {
      "type": "float",
      "vector": true,
      "label": "Deretraction Speed",
      "tooltip": "Speed for reloading filament into extruder. Zero means the same speed as retraction",
      "sidetext": "mm/s",
      "mode": "advanced",
      "default": "0"
    },
    "filament_retract_length_nc": {
      "type": "float",
      "vector": true,
      "label": "length when change hotend",
      "tooltip": "When this retraction value is modified, it will be used as the amount of filament retracted inside the hotend before changing hotends.",
      "sidetext": "mm",
      "mode": "develop",
      "min": 0,
      "max": 18,
      "default": "10"
    },
    "filament_retract_restart_extra": {
      "type": "float",
      "vector": true,
      "label": "Extra length on restart",
      "tooltip": "When the retraction is compensated after the travel move, the extruder will push this additional amount of filament. This setting is rarely needed.",
      "sidetext": "mm",
      "mode": "advanced",
      "default": "0"
    },
    "filament_retraction_minimum_travel": {
      "type": "float",
      "vector": true,
      "label": "Travel distance threshold",
      "tooltip": "Only trigger retraction when the travel distance is longer than this threshold",
      "sidetext": "mm",
      "mode": "advanced",
      "default": "2"
    },
    "filament_retract_when_changing_layer": {
      "type": "bool",
      "vector": true,
      "label": "Retract when change layer",
      "tooltip": "Force a retraction when changes layer",
      "mode": "advanced",
      "default": "0"
    },
    "filament_wipe": {
      "type": "bool",
      "vector": true,
      "label": "Wipe while retracting",
      "tooltip": "Move nozzle along the last extrusion path when retracting to clean leaked material on nozzle. This can minimize blob when printing new part after travel",
      "mode": "advanced",
      "default": "0"
    },
    "filament_wipe_distance": {
      "type": "float",
      "vector": true,
      "label": "Wipe Distance",
      "tooltip": "Describe how long the nozzle will move along the last path when retracting",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "2"
    },
    "filament_retract_before_wipe": {
      "type": "percent",
      "vector": true,
      "label": "Retract amount before wipe",
      "tooltip": "The length of fast retraction before wipe, relative to retraction length",
      "sidetext": "%",
      "mode": "advanced",
      "default": "100%"
    },
    "filament_long_retractions_when_cut": {
      "type": "bool",
      "vector": true,
      "label": "Long retraction when cut(experimental)",
      "tooltip": "Experimental feature.Retracting and cutting off the filament at a longer distance during changes to minimize purge.While this reduces flush significantly, it may also raise the risk of nozzle clogs or other printing problems.",
      "mode": "simple",
      "default": "0"
    },
    "filament_retraction_distances_when_cut": {
      "type": "float",
      "vector": true,
      "label": "Retraction distance when cut",
      "tooltip": "Experimental feature.Retraction length before cutting off during filament change",
      "mode": "simple",
      "min": 10,
      "max": 18,
      "default": "18"
    },
    "override_process_overhang_speed": {
      "type": "bool",
      "vector": true,
      "label": "Override overhang speed",
      "tooltip": "Override the overhang speed in process page",
      "mode": "advanced",
      "default": "0"
    },
    "filament_enable_overhang_speed": {
      "type": "bool",
      "vector": true,
      "label": "Slow down for overhang",
      "tooltip": "Enable this option to slow printing down for different overhang degree",
      "category": "Speed",
      "mode": "advanced",
      "default": "1"
    },
    "filament_overhang_1_4_speed": {
      "type": "float",
      "vector": true,
      "label": "10%",
      "tooltip": "",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_overhang_2_4_speed": {
      "type": "float",
      "vector": true,
      "label": "25%",
      "tooltip": "",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_overhang_3_4_speed": {
      "type": "float",
      "vector": true,
      "label": "50%",
      "tooltip": "",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_overhang_4_4_speed": {
      "type": "float",
      "vector": true,
      "label": "75%",
      "tooltip": "",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_overhang_totally_speed": {
      "type": "float",
      "vector": true,
      "label": "100%",
      "tooltip": "Speed of 100%% overhang wall which has 0 overlap with the lower layer.",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "filament_bridge_speed": {
      "type": "float",
      "vector": true,
      "label": "Bridge",
      "tooltip": "Speed of bridge and completely overhang wall",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "25"
    },
    "filament_start_gcode": {
      "type": "string",
      "vector": true,
      "label": "Start G-code",
      "tooltip": "Start G-code when start the printing of this filament",
      "mode": "advanced",
      "fullWidth": true,
      "height": 15,
      "isCode": true
    },
    "filament_end_gcode": {
      "type": "string",
      "vector": true,
      "label": "End G-code",
      "tooltip": "End G-code when finish the printing of this filament",
      "mode": "advanced",
      "fullWidth": true,
      "height": 15,
      "isCode": true
    },
    "filament_notes": {
      "type": "string",
      "label": "Filament notes",
      "tooltip": "You can put your notes regarding the filament here.",
      "mode": "advanced",
      "fullWidth": true,
      "height": 25,
      "default": ""
    },
    "filament_flush_temp": {
      "type": "int",
      "vector": true,
      "label": "Flush temperature",
      "tooltip": "temperature when flushing filament. 0 indicates the upper bound of the recommended nozzle temperature range",
      "sidetext": "°C",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_flush_temp_fast": {
      "type": "int",
      "vector": true,
      "label": "Flush temperature",
      "tooltip": "Flush temperature used in fast purge mode.",
      "sidetext": "°C",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "filament_flush_volumetric_speed": {
      "type": "float",
      "vector": true,
      "label": "Flush volumetric speed",
      "tooltip": "Volumetric speed when flushing filament. 0 indicates the max volumetric speed",
      "sidetext": "mm³/s",
      "mode": "advanced",
      "min": 0,
      "max": 200,
      "default": "0"
    },
    "long_retractions_when_ec": {
      "type": "bool",
      "vector": true,
      "label": "Long retraction when extruder change",
      "tooltip": "",
      "mode": "advanced",
      "default": "0"
    },
    "retraction_distances_when_ec": {
      "type": "float",
      "vector": true,
      "label": "Retraction distance when extruder change",
      "tooltip": "",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "max": 10,
      "default": "10"
    }
  }
}
