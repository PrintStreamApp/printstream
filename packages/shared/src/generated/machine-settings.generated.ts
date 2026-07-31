/**
 * GENERATED FILE - DO NOT EDIT.
 * Produced by scripts/dev/generate-machine-settings.mjs from the BambuStudio
 * source (Tab.cpp TabPrinter layout + PrintConfig.cpp metadata). Re-run the
 * generator to update. See packages/shared/src/process-settings.ts for the
 * consuming types (shared with the process and filament catalogs).
 */
import type { ProcessSettingsCatalog } from '../process-settings.js'

export const machineSettingsCatalog: ProcessSettingsCatalog = {
  "pages": [
    {
      "id": "basic-information",
      "title": "Basic information",
      "groups": [
        {
          "title": "Printable space",
          "lines": [
            {
              "keys": [
                "printable_height"
              ]
            },
            {
              "keys": [
                "best_object_pos"
              ]
            }
          ]
        },
        {
          "title": "Advanced",
          "lines": [
            {
              "keys": [
                "single_extruder_multi_material"
              ]
            },
            {
              "keys": [
                "silent_mode"
              ]
            },
            {
              "keys": [
                "printer_structure"
              ]
            },
            {
              "keys": [
                "gcode_flavor"
              ]
            },
            {
              "keys": [
                "scan_first_layer"
              ]
            },
            {
              "keys": [
                "print_in_clockwise"
              ]
            },
            {
              "keys": [
                "use_relative_e_distances"
              ]
            },
            {
              "keys": [
                "use_firmware_retraction"
              ]
            },
            {
              "keys": [
                "bed_temperature_formula"
              ]
            },
            {
              "keys": [
                "spaghetti_detector"
              ]
            },
            {
              "keys": [
                "machine_load_filament_time"
              ]
            },
            {
              "keys": [
                "machine_unload_filament_time"
              ]
            },
            {
              "keys": [
                "machine_switch_extruder_time"
              ]
            },
            {
              "keys": [
                "machine_hotend_change_time"
              ]
            }
          ]
        },
        {
          "title": "Extruder Clearance",
          "lines": [
            {
              "keys": [
                "extruder_clearance_max_radius"
              ]
            },
            {
              "keys": [
                "extruder_clearance_dist_to_rod"
              ]
            },
            {
              "keys": [
                "extruder_clearance_height_to_rod"
              ]
            },
            {
              "keys": [
                "extruder_clearance_height_to_lid"
              ]
            }
          ]
        },
        {
          "title": "Accessory",
          "lines": [
            {
              "keys": [
                "nozzle_type"
              ]
            },
            {
              "keys": [
                "auxiliary_fan"
              ]
            },
            {
              "keys": [
                "fan_direction"
              ]
            },
            {
              "keys": [
                "support_chamber_temp_control"
              ]
            },
            {
              "keys": [
                "support_air_filtration"
              ]
            },
            {
              "keys": [
                "cooling_filter_enabled"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "extruder",
      "title": "Extruder",
      "groups": [
        {
          "title": "Basic information",
          "lines": [
            {
              "keys": [
                "extruder_type"
              ]
            },
            {
              "keys": [
                "nozzle_diameter"
              ]
            },
            {
              "keys": [
                "default_nozzle_volume_type"
              ]
            },
            {
              "keys": [
                "nozzle_volume"
              ]
            },
            {
              "keys": [
                "extruder_printable_height"
              ]
            }
          ]
        },
        {
          "title": "Layer height limits",
          "lines": [
            {
              "keys": [
                "min_layer_height"
              ]
            },
            {
              "keys": [
                "max_layer_height"
              ]
            }
          ]
        },
        {
          "title": "Position",
          "lines": [
            {
              "keys": [
                "extruder_offset"
              ]
            }
          ]
        },
        {
          "title": "Retraction",
          "lines": [
            {
              "keys": [
                "retraction_length"
              ]
            },
            {
              "keys": [
                "z_hop"
              ]
            },
            {
              "keys": [
                "retract_lift_above"
              ]
            },
            {
              "keys": [
                "retract_lift_below"
              ]
            },
            {
              "keys": [
                "z_hop_types"
              ]
            },
            {
              "keys": [
                "retraction_speed"
              ]
            },
            {
              "keys": [
                "deretraction_speed"
              ]
            },
            {
              "keys": [
                "retract_restart_extra"
              ]
            },
            {
              "keys": [
                "retraction_minimum_travel"
              ]
            },
            {
              "keys": [
                "retract_when_changing_layer"
              ]
            },
            {
              "keys": [
                "wipe"
              ]
            },
            {
              "keys": [
                "wipe_distance"
              ]
            },
            {
              "keys": [
                "retract_before_wipe"
              ]
            }
          ]
        },
        {
          "title": "Retraction when switching material",
          "lines": [
            {
              "keys": [
                "retract_length_toolchange"
              ]
            },
            {
              "keys": [
                "retract_restart_extra_toolchange"
              ]
            },
            {
              "keys": [
                "long_retractions_when_cut"
              ]
            },
            {
              "keys": [
                "retraction_distances_when_cut"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "motion-ability",
      "title": "Motion ability",
      "groups": [
        {
          "title": "Speed limitation",
          "lines": [
            {
              "keys": [
                "machine_max_speed_x"
              ]
            },
            {
              "keys": [
                "machine_max_speed_y"
              ]
            },
            {
              "keys": [
                "machine_max_speed_z"
              ]
            },
            {
              "keys": [
                "machine_max_speed_e"
              ]
            }
          ]
        },
        {
          "title": "Acceleration limitation",
          "lines": [
            {
              "keys": [
                "machine_max_acceleration_x"
              ]
            },
            {
              "keys": [
                "machine_max_acceleration_y"
              ]
            },
            {
              "keys": [
                "machine_max_acceleration_z"
              ]
            },
            {
              "keys": [
                "machine_max_acceleration_e"
              ]
            },
            {
              "keys": [
                "machine_max_acceleration_extruding"
              ]
            },
            {
              "keys": [
                "machine_max_acceleration_retracting"
              ]
            },
            {
              "keys": [
                "machine_max_acceleration_travel"
              ]
            }
          ]
        },
        {
          "title": "Jerk limitation",
          "lines": [
            {
              "keys": [
                "machine_max_jerk_x"
              ]
            },
            {
              "keys": [
                "machine_max_jerk_y"
              ]
            },
            {
              "keys": [
                "machine_max_jerk_z"
              ]
            },
            {
              "keys": [
                "machine_max_jerk_e"
              ]
            }
          ]
        },
        {
          "title": "Minimum feedrates",
          "lines": [
            {
              "keys": [
                "machine_min_extruding_rate"
              ]
            },
            {
              "keys": [
                "machine_min_travel_rate"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "machine-gcode",
      "title": "Machine gcode",
      "groups": [
        {
          "title": "Machine start G-code",
          "lines": [
            {
              "keys": [
                "machine_start_gcode"
              ],
              "code": true,
              "height": 15
            }
          ]
        },
        {
          "title": "Machine end G-code",
          "lines": [
            {
              "keys": [
                "machine_end_gcode"
              ],
              "code": true,
              "height": 15
            }
          ]
        },
        {
          "title": "Before layer change G-code",
          "lines": [
            {
              "keys": [
                "before_layer_change_gcode"
              ],
              "code": true,
              "height": 5
            }
          ]
        },
        {
          "title": "Layer change G-code",
          "lines": [
            {
              "keys": [
                "layer_change_gcode"
              ],
              "code": true,
              "height": 5
            }
          ]
        },
        {
          "title": "Time lapse G-code",
          "lines": [
            {
              "keys": [
                "time_lapse_gcode"
              ],
              "code": true,
              "height": 5
            }
          ]
        },
        {
          "title": "Change filament G-code",
          "lines": [
            {
              "keys": [
                "change_filament_gcode"
              ],
              "code": true,
              "height": 5
            }
          ]
        },
        {
          "title": "Pause G-code",
          "lines": [
            {
              "keys": [
                "machine_pause_gcode"
              ],
              "code": true,
              "height": 5
            }
          ]
        },
        {
          "title": "Template Custom G-code",
          "lines": [
            {
              "keys": [
                "template_custom_gcode"
              ],
              "code": true,
              "height": 5
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
                "printer_notes"
              ],
              "code": true,
              "height": 25
            }
          ]
        }
      ]
    }
  ],
  "options": {
    "printable_height": {
      "type": "float",
      "label": "Printable height",
      "tooltip": "Maximum printable height which is limited by mechanism of printer",
      "sidetext": "mm",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "100"
    },
    "best_object_pos": {
      "type": "point",
      "label": "Best object position",
      "tooltip": "Best auto arranging position in range [0,1] w.r.t. bed shape.",
      "mode": "advanced",
      "default": "2"
    },
    "single_extruder_multi_material": {
      "type": "bool",
      "label": "",
      "tooltip": "",
      "mode": "develop",
      "default": "0"
    },
    "silent_mode": {
      "type": "bool",
      "label": "Supports silent mode",
      "tooltip": "Whether the machine supports silent mode in which machine use lower acceleration to print",
      "mode": "develop",
      "default": "0"
    },
    "printer_structure": {
      "type": "enum",
      "label": "Printer structure",
      "tooltip": "The physical arrangement and components of a printing device",
      "enumValues": [
        "undefine",
        "corexy",
        "i3",
        "hbot",
        "delta"
      ],
      "enumLabels": [
        "Undefine",
        "CoreXY",
        "I3",
        "Hbot",
        "Delta"
      ],
      "mode": "develop",
      "default": "undefine"
    },
    "gcode_flavor": {
      "type": "enum",
      "label": "G-code flavor",
      "tooltip": "What kind of gcode the printer is compatible with",
      "enumValues": [
        "marlin",
        "klipper"
      ],
      "enumLabels": [
        "Marlin(legacy)",
        "Klipper"
      ],
      "mode": "advanced",
      "default": "marlin"
    },
    "scan_first_layer": {
      "type": "bool",
      "label": "Scan first layer",
      "tooltip": "Enable this to enable the camera on printer to check the quality of first layer",
      "mode": "develop",
      "default": "0"
    },
    "print_in_clockwise": {
      "type": "bool",
      "label": "Print loops in clockwise",
      "tooltip": "Print in clockwise when enabled, or counterclockwise when not enabled, not work for spiral vase mode",
      "mode": "develop",
      "default": "0"
    },
    "use_relative_e_distances": {
      "type": "bool",
      "label": "Use relative E distances",
      "tooltip": "If your firmware requires relative E values, check this, otherwise leave it unchecked. Must use relative e distance for Bambu printer",
      "mode": "advanced",
      "default": "1"
    },
    "use_firmware_retraction": {
      "type": "bool",
      "label": "Use firmware retraction",
      "tooltip": "Convert the retraction moves to G10 and G11 gcode",
      "mode": "advanced",
      "default": "0"
    },
    "bed_temperature_formula": {
      "type": "enum",
      "label": "Bed temperature type",
      "tooltip": "This option determines how the bed temperature is set during slicing: based on the temperature of the first filament or the highest temperature of the printed filaments.",
      "enumValues": [
        "by_first_filament",
        "by_highest_temp"
      ],
      "enumLabels": [
        "By First filament",
        "By Highest Temp"
      ],
      "mode": "develop",
      "default": "by_first_filament"
    },
    "spaghetti_detector": {
      "type": "bool",
      "label": "",
      "tooltip": "",
      "mode": "simple"
    },
    "machine_load_filament_time": {
      "type": "float",
      "label": "Filament load time",
      "tooltip": "Time to load new filament when switch filament. For statistics only",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "machine_unload_filament_time": {
      "type": "float",
      "label": "Filament unload time",
      "tooltip": "Time to unload old filament when switch filament. For statistics only",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "machine_switch_extruder_time": {
      "type": "float",
      "label": "Extruder switch time",
      "tooltip": "Time to switch extruder. For statistics only",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "default": "5"
    },
    "machine_hotend_change_time": {
      "type": "float",
      "label": "Hotend change time",
      "tooltip": "Time to change hotend.",
      "sidetext": "s",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "extruder_clearance_max_radius": {
      "type": "float",
      "label": "Max Radius",
      "tooltip": "Max clearance radius around extruder. Used for collision avoidance in by-object printing.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "68"
    },
    "extruder_clearance_dist_to_rod": {
      "type": "float",
      "label": "Distance to rod",
      "tooltip": "Horizontal distance of the nozzle tip to the rod's farther edge. Used for collision avoidance in by-object printing.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "40"
    },
    "extruder_clearance_height_to_rod": {
      "type": "float",
      "label": "Height to rod",
      "tooltip": "Distance of the nozzle tip to the lower rod. Used for collision avoidance in by-object printing.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "40"
    },
    "extruder_clearance_height_to_lid": {
      "type": "float",
      "label": "Height to lid",
      "tooltip": "Distance of the nozzle tip to the lid. Used for collision avoidance in by-object printing.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "120"
    },
    "nozzle_type": {
      "type": "enum",
      "vector": true,
      "label": "Nozzle type",
      "tooltip": "The metallic material of nozzle. This determines the abrasive resistance of nozzle, and what kind of filament can be printed",
      "enumValues": [
        "undefine",
        "hardened_steel",
        "stainless_steel",
        "tungsten_carbide",
        "brass"
      ],
      "enumLabels": [
        "Undefine",
        "Hardened steel",
        "Stainless steel",
        "Tungsten carbide",
        "Brass"
      ],
      "mode": "develop"
    },
    "auxiliary_fan": {
      "type": "bool",
      "label": "Auxiliary part cooling fan",
      "tooltip": "Enable this option if machine has auxiliary part cooling fan",
      "mode": "develop",
      "default": "0"
    },
    "fan_direction": {
      "type": "enum",
      "label": "Fan direction",
      "tooltip": "Cooling fan direction of the printer",
      "enumValues": [
        "undefine",
        "left",
        "right",
        "both"
      ],
      "enumLabels": [
        "Undefine",
        "Left",
        "Right",
        "Both"
      ],
      "mode": "develop",
      "default": "undefine"
    },
    "support_chamber_temp_control": {
      "type": "bool",
      "label": "Support control chamber temperature",
      "tooltip": "This option is enabled if machine support controlling chamber temperature",
      "mode": "develop",
      "default": "0"
    },
    "support_air_filtration": {
      "type": "bool",
      "label": "Air filtration enhancement",
      "tooltip": "Enable this if printer support air filtration enhancement.",
      "mode": "advanced",
      "default": "0"
    },
    "cooling_filter_enabled": {
      "type": "bool",
      "label": "Use cooling filter",
      "tooltip": "Enable this if printer support cooling filter",
      "mode": "advanced",
      "default": "0"
    },
    "extruder_type": {
      "type": "enum",
      "vector": true,
      "label": "Type",
      "tooltip": "This setting is only used for initial value of manual calibration of pressure advance. Bowden extruder usually has larger pa value. This setting doesn't influence normal slicing",
      "enumValues": [
        "Direct Drive",
        "Bowden"
      ],
      "enumLabels": [
        "Direct Drive",
        "Bowden"
      ],
      "mode": "advanced",
      "default": "Direct Drive"
    },
    "nozzle_diameter": {
      "type": "float",
      "vector": true,
      "label": "Nozzle diameter",
      "tooltip": "Diameter of nozzle",
      "sidetext": "mm",
      "mode": "advanced",
      "max": 1,
      "default": "0.4"
    },
    "default_nozzle_volume_type": {
      "type": "enum",
      "vector": true,
      "label": "Default Nozzle Volume Type",
      "tooltip": "Default Nozzle volume type for extruders in this printer",
      "enumValues": [
        "Standard",
        "High Flow",
        "Hybrid",
        "TPU High Flow"
      ],
      "enumLabels": [
        "Standard",
        "High Flow",
        "Hybrid",
        "TPU High Flow"
      ],
      "mode": "develop",
      "default": "Standard"
    },
    "nozzle_volume": {
      "type": "float",
      "vector": true,
      "label": "Nozzle volume",
      "tooltip": "Volume of nozzle between the cutter and the end of nozzle",
      "sidetext": "mm³",
      "mode": "advanced",
      "default": "0"
    },
    "extruder_printable_height": {
      "type": "float",
      "vector": true,
      "label": "Extruder printable height",
      "tooltip": "Maximum printable height of this extruder which is limited by mechanism of printer",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "max": 1000,
      "default": "0"
    },
    "min_layer_height": {
      "type": "float",
      "vector": true,
      "label": "Min",
      "tooltip": "The lowest printable layer height for extruder. Used to limit the minimum layer height when enable adaptive layer height",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "0.07"
    },
    "max_layer_height": {
      "type": "float",
      "vector": true,
      "label": "Max",
      "tooltip": "The largest printable layer height for extruder. Used to limit the maximum layer height when enable adaptive layer height",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "extruder_offset": {
      "type": "point",
      "vector": true,
      "label": "Extruder offset",
      "tooltip": "",
      "sidetext": "mm",
      "mode": "advanced",
      "min": -5,
      "max": 5,
      "default": "2"
    },
    "retraction_length": {
      "type": "float",
      "vector": true,
      "label": "Length",
      "tooltip": "Some amount of material in extruder is pulled back to avoid ooze during long travel. Set zero to disable retraction",
      "sidetext": "mm",
      "mode": "simple",
      "default": "0.8"
    },
    "z_hop": {
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
    "retract_lift_above": {
      "type": "float",
      "vector": true,
      "label": "Z hop lower boundary",
      "tooltip": "Z hop will only come into effect when Z is above this value and is below the parameter: \"Z hop upper boundary\"",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "retract_lift_below": {
      "type": "float",
      "vector": true,
      "label": "Z hop upper boundary",
      "tooltip": "If this value is positive, Z hop will only come into effect when Z is above the parameter: \"Z hop lower boundary\" and is below this value",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "z_hop_types": {
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
    "retraction_speed": {
      "type": "float",
      "vector": true,
      "label": "Retraction Speed",
      "tooltip": "Speed of retractions",
      "sidetext": "mm/s",
      "mode": "advanced",
      "default": "30"
    },
    "deretraction_speed": {
      "type": "float",
      "vector": true,
      "label": "Deretraction Speed",
      "tooltip": "Speed for reloading filament into extruder. Zero means the same speed as retraction",
      "sidetext": "mm/s",
      "mode": "advanced",
      "default": "0"
    },
    "retract_restart_extra": {
      "type": "float",
      "vector": true,
      "label": "Extra length on restart",
      "tooltip": "When the retraction is compensated after the travel move, the extruder will push this additional amount of filament. This setting is rarely needed.",
      "sidetext": "mm",
      "mode": "develop",
      "default": "0"
    },
    "retraction_minimum_travel": {
      "type": "float",
      "vector": true,
      "label": "Travel distance threshold",
      "tooltip": "Only trigger retraction when the travel distance is longer than this threshold",
      "sidetext": "mm",
      "mode": "advanced",
      "default": "2"
    },
    "retract_when_changing_layer": {
      "type": "bool",
      "vector": true,
      "label": "Retract when change layer",
      "tooltip": "Force a retraction when changes layer",
      "mode": "advanced",
      "default": "0"
    },
    "wipe": {
      "type": "bool",
      "vector": true,
      "label": "Wipe while retracting",
      "tooltip": "Move nozzle along the last extrusion path when retracting to clean leaked material on nozzle. This can minimize blob when printing new part after travel",
      "mode": "advanced",
      "default": "0"
    },
    "wipe_distance": {
      "type": "float",
      "vector": true,
      "label": "Wipe Distance",
      "tooltip": "Describe how long the nozzle will move along the last path when retracting",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "2"
    },
    "retract_before_wipe": {
      "type": "percent",
      "vector": true,
      "label": "Retract amount before wipe",
      "tooltip": "The length of fast retraction before wipe, relative to retraction length",
      "sidetext": "%",
      "mode": "advanced",
      "default": "100%"
    },
    "retract_length_toolchange": {
      "type": "float",
      "vector": true,
      "label": "Length",
      "tooltip": "",
      "sidetext": "mm",
      "mode": "develop",
      "default": "10"
    },
    "retract_restart_extra_toolchange": {
      "type": "float",
      "vector": true,
      "label": "Extra length on restart",
      "tooltip": "When the retraction is compensated after changing tool, the extruder will push this additional amount of filament.",
      "sidetext": "mm",
      "mode": "develop",
      "default": "0"
    },
    "long_retractions_when_cut": {
      "type": "bool",
      "vector": true,
      "label": "Long retraction when cut(experimental)",
      "tooltip": "Experimental feature.Retracting and cutting off the filament at a longer distance during changes to minimize purge.While this reduces flush significantly, it may also raise the risk of nozzle clogs or other printing problems.",
      "mode": "develop",
      "default": "0"
    },
    "retraction_distances_when_cut": {
      "type": "float",
      "vector": true,
      "label": "Retraction distance when cut",
      "tooltip": "Experimental feature.Retraction length before cutting off during filament change",
      "mode": "develop",
      "min": 10,
      "max": 18,
      "default": "18"
    },
    "machine_max_speed_x": {
      "type": "float",
      "vector": true,
      "label": "Maximum speed X",
      "tooltip": "Maximum speed of X axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_speed_y": {
      "type": "float",
      "vector": true,
      "label": "Maximum speed Y",
      "tooltip": "Maximum speed of Y axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_speed_z": {
      "type": "float",
      "vector": true,
      "label": "Maximum speed Z",
      "tooltip": "Maximum speed of Z axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_speed_e": {
      "type": "float",
      "vector": true,
      "label": "Maximum speed E",
      "tooltip": "Maximum speed of E axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_acceleration_x": {
      "type": "float",
      "vector": true,
      "label": "Maximum acceleration X",
      "tooltip": "Maximum acceleration of X axis",
      "sidetext": "mm/s²",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_acceleration_y": {
      "type": "float",
      "vector": true,
      "label": "Maximum acceleration Y",
      "tooltip": "Maximum acceleration of Y axis",
      "sidetext": "mm/s²",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_acceleration_z": {
      "type": "float",
      "vector": true,
      "label": "Maximum acceleration Z",
      "tooltip": "Maximum acceleration of Z axis",
      "sidetext": "mm/s²",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_acceleration_e": {
      "type": "float",
      "vector": true,
      "label": "Maximum acceleration E",
      "tooltip": "Maximum acceleration of E axis",
      "sidetext": "mm/s²",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_acceleration_extruding": {
      "type": "float",
      "vector": true,
      "label": "",
      "tooltip": "Maximum acceleration for extruding (M204 P)",
      "sidetext": "mm/s²",
      "category": "Machine limits",
      "mode": "simple",
      "min": 0,
      "default": "1500"
    },
    "machine_max_acceleration_retracting": {
      "type": "float",
      "vector": true,
      "label": "",
      "tooltip": "Maximum acceleration for retracting (M204 R)",
      "sidetext": "mm/s²",
      "category": "Machine limits",
      "mode": "simple",
      "min": 0,
      "default": "1500"
    },
    "machine_max_acceleration_travel": {
      "type": "float",
      "vector": true,
      "label": "",
      "tooltip": "Maximum acceleration for travel (M204 T)",
      "sidetext": "mm/s²",
      "category": "Machine limits",
      "mode": "develop",
      "min": 0,
      "default": "1500"
    },
    "machine_max_jerk_x": {
      "type": "float",
      "vector": true,
      "label": "Maximum jerk X",
      "tooltip": "Maximum jerk of X axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_jerk_y": {
      "type": "float",
      "vector": true,
      "label": "Maximum jerk Y",
      "tooltip": "Maximum jerk of Y axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_jerk_z": {
      "type": "float",
      "vector": true,
      "label": "Maximum jerk Z",
      "tooltip": "Maximum jerk of Z axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_max_jerk_e": {
      "type": "float",
      "vector": true,
      "label": "Maximum jerk E",
      "tooltip": "Maximum jerk of E axis",
      "sidetext": "mm/s",
      "min": 0,
      "mode": "simple"
    },
    "machine_min_extruding_rate": {
      "type": "float",
      "vector": true,
      "label": "",
      "tooltip": "Minimum speed for extruding (M205 S)",
      "sidetext": "mm/s",
      "category": "Machine limits",
      "mode": "develop",
      "min": 0,
      "default": "0"
    },
    "machine_min_travel_rate": {
      "type": "float",
      "vector": true,
      "label": "",
      "tooltip": "Minimum travel speed (M205 T)",
      "sidetext": "mm/s",
      "category": "Machine limits",
      "mode": "develop",
      "min": 0,
      "default": "0"
    },
    "machine_start_gcode": {
      "type": "string",
      "label": "Start G-code",
      "tooltip": "Start G-code when start the whole printing",
      "mode": "advanced",
      "fullWidth": true,
      "height": 15,
      "default": "G28 ; home all axes\nG1 Z5 F5000 ; lift nozzle\n",
      "isCode": true
    },
    "machine_end_gcode": {
      "type": "string",
      "label": "End G-code",
      "tooltip": "End G-code when finish the whole printing",
      "mode": "advanced",
      "fullWidth": true,
      "height": 15,
      "default": "M104 S0 ; turn off temperature\nG28 X0  ; home X axis\nM84     ; disable motors\n",
      "isCode": true
    },
    "before_layer_change_gcode": {
      "type": "string",
      "label": "Before layer change G-code",
      "tooltip": "This G-code is inserted at every layer change before lifting z",
      "mode": "develop",
      "fullWidth": true,
      "height": 5,
      "default": "",
      "isCode": true
    },
    "layer_change_gcode": {
      "type": "string",
      "label": "Layer change G-code",
      "tooltip": "This gcode part is inserted at every layer change after lift z",
      "mode": "advanced",
      "fullWidth": true,
      "height": 5,
      "default": "",
      "isCode": true
    },
    "time_lapse_gcode": {
      "type": "string",
      "label": "Time lapse G-code",
      "tooltip": "",
      "mode": "advanced",
      "fullWidth": true,
      "height": 5,
      "default": "",
      "isCode": true
    },
    "change_filament_gcode": {
      "type": "string",
      "label": "Change filament G-code",
      "tooltip": "This gcode is inserted when change filament, including T command to trigger tool change",
      "mode": "advanced",
      "fullWidth": true,
      "height": 5,
      "default": "",
      "isCode": true
    },
    "machine_pause_gcode": {
      "type": "string",
      "label": "Pause G-code",
      "tooltip": "This G-code will be used as a code for the pause print. User can insert pause G-code in gcode viewer",
      "mode": "advanced",
      "fullWidth": true,
      "height": 5,
      "default": "",
      "isCode": true
    },
    "template_custom_gcode": {
      "type": "string",
      "label": "Custom G-code",
      "tooltip": "This G-code will be used as a custom code",
      "mode": "advanced",
      "fullWidth": true,
      "height": 5,
      "default": "",
      "isCode": true
    },
    "printer_notes": {
      "type": "string",
      "label": "Printer notes",
      "tooltip": "You can put your notes regarding the printer here.",
      "mode": "advanced",
      "fullWidth": true,
      "height": 25,
      "default": "",
      "isCode": true
    }
  }
}
