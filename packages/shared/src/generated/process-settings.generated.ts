/**
 * GENERATED FILE - DO NOT EDIT.
 * Produced by scripts/dev/generate-process-settings.mjs from the BambuStudio
 * source (Tab.cpp layout + PrintConfig.cpp metadata). Re-run the generator to
 * update. See packages/shared/src/process-settings.ts for the consuming types.
 */
import type { ProcessSettingsCatalog } from '../process-settings.js'

export const processSettingsCatalog: ProcessSettingsCatalog = {
  "pages": [
    {
      "id": "quality",
      "title": "Quality",
      "groups": [
        {
          "title": "Layer height",
          "lines": [
            {
              "keys": [
                "layer_height"
              ]
            },
            {
              "keys": [
                "initial_layer_print_height"
              ]
            },
            {
              "keys": [
                "enable_mixed_color_sublayer"
              ]
            }
          ]
        },
        {
          "title": "Line width",
          "lines": [
            {
              "keys": [
                "line_width"
              ]
            },
            {
              "keys": [
                "initial_layer_line_width"
              ]
            },
            {
              "keys": [
                "outer_wall_line_width"
              ]
            },
            {
              "keys": [
                "inner_wall_line_width"
              ]
            },
            {
              "keys": [
                "top_surface_line_width"
              ]
            },
            {
              "keys": [
                "sparse_infill_line_width"
              ]
            },
            {
              "keys": [
                "internal_solid_infill_line_width"
              ]
            },
            {
              "keys": [
                "support_line_width"
              ]
            }
          ]
        },
        {
          "title": "Seam",
          "lines": [
            {
              "keys": [
                "seam_position"
              ]
            },
            {
              "keys": [
                "seam_placement_away_from_overhangs"
              ]
            },
            {
              "keys": [
                "seam_gap"
              ]
            },
            {
              "keys": [
                "seam_slope_conditional"
              ]
            },
            {
              "keys": [
                "scarf_angle_threshold"
              ]
            },
            {
              "keys": [
                "seam_slope_entire_loop"
              ]
            },
            {
              "keys": [
                "seam_slope_steps"
              ]
            },
            {
              "keys": [
                "seam_slope_inner_walls"
              ]
            },
            {
              "keys": [
                "override_filament_scarf_seam_setting"
              ]
            },
            {
              "keys": [
                "seam_slope_type"
              ]
            },
            {
              "keys": [
                "seam_slope_start_height"
              ]
            },
            {
              "keys": [
                "seam_slope_gap"
              ]
            },
            {
              "keys": [
                "seam_slope_min_length"
              ]
            },
            {
              "keys": [
                "wipe_speed"
              ]
            },
            {
              "keys": [
                "role_base_wipe_speed"
              ]
            }
          ]
        },
        {
          "title": "Precision",
          "lines": [
            {
              "keys": [
                "slice_closing_radius"
              ]
            },
            {
              "keys": [
                "resolution"
              ]
            },
            {
              "keys": [
                "enable_arc_fitting"
              ]
            },
            {
              "keys": [
                "xy_hole_compensation"
              ]
            },
            {
              "keys": [
                "xy_contour_compensation"
              ]
            },
            {
              "keys": [
                "enable_circle_compensation"
              ]
            },
            {
              "keys": [
                "circle_compensation_manual_offset"
              ]
            },
            {
              "keys": [
                "elefant_foot_compensation"
              ]
            },
            {
              "keys": [
                "precise_outer_wall"
              ]
            },
            {
              "keys": [
                "precise_z_height"
              ]
            }
          ]
        },
        {
          "title": "Ironing",
          "lines": [
            {
              "keys": [
                "ironing_type"
              ]
            },
            {
              "keys": [
                "ironing_pattern"
              ]
            },
            {
              "keys": [
                "ironing_speed"
              ]
            },
            {
              "keys": [
                "ironing_flow"
              ]
            },
            {
              "keys": [
                "ironing_spacing"
              ]
            },
            {
              "keys": [
                "ironing_inset"
              ]
            },
            {
              "keys": [
                "ironing_direction"
              ]
            }
          ]
        },
        {
          "title": "Wall generator",
          "lines": [
            {
              "keys": [
                "wall_generator"
              ]
            },
            {
              "keys": [
                "wall_transition_angle"
              ]
            },
            {
              "keys": [
                "wall_transition_filter_deviation"
              ]
            },
            {
              "keys": [
                "wall_transition_length"
              ]
            },
            {
              "keys": [
                "wall_distribution_count"
              ]
            },
            {
              "keys": [
                "min_bead_width"
              ]
            },
            {
              "keys": [
                "min_feature_size"
              ]
            }
          ]
        },
        {
          "title": "Advanced",
          "lines": [
            {
              "keys": [
                "wall_sequence"
              ]
            },
            {
              "keys": [
                "is_infill_first"
              ]
            },
            {
              "keys": [
                "bridge_flow"
              ]
            },
            {
              "keys": [
                "thick_bridges"
              ]
            },
            {
              "keys": [
                "print_flow_ratio"
              ]
            },
            {
              "keys": [
                "top_solid_infill_flow_ratio"
              ]
            },
            {
              "keys": [
                "initial_layer_flow_ratio"
              ]
            },
            {
              "keys": [
                "top_one_wall_type"
              ]
            },
            {
              "keys": [
                "top_area_threshold"
              ]
            },
            {
              "keys": [
                "only_one_wall_first_layer"
              ]
            },
            {
              "keys": [
                "detect_overhang_wall"
              ]
            },
            {
              "keys": [
                "smooth_speed_discontinuity_area"
              ]
            },
            {
              "keys": [
                "smooth_coefficient"
              ]
            },
            {
              "keys": [
                "reduce_crossing_wall"
              ]
            },
            {
              "keys": [
                "max_travel_detour_distance"
              ]
            },
            {
              "keys": [
                "avoid_crossing_wall_includes_support"
              ]
            },
            {
              "keys": [
                "z_direction_outwall_speed_continuous"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "strength",
      "title": "Strength",
      "groups": [
        {
          "title": "Walls",
          "lines": [
            {
              "keys": [
                "wall_loops"
              ]
            },
            {
              "keys": [
                "alternate_extra_wall"
              ]
            },
            {
              "keys": [
                "embedding_wall_into_infill"
              ]
            },
            {
              "keys": [
                "detect_thin_wall"
              ]
            }
          ]
        },
        {
          "title": "Top/bottom shells",
          "lines": [
            {
              "keys": [
                "interface_shells"
              ]
            },
            {
              "keys": [
                "top_surface_pattern"
              ]
            },
            {
              "keys": [
                "top_surface_density"
              ]
            },
            {
              "keys": [
                "top_shell_layers"
              ]
            },
            {
              "keys": [
                "top_shell_thickness"
              ]
            },
            {
              "keys": [
                "top_color_penetration_layers"
              ]
            },
            {
              "keys": [
                "bottom_surface_pattern"
              ]
            },
            {
              "keys": [
                "bottom_surface_density"
              ]
            },
            {
              "keys": [
                "bottom_shell_layers"
              ]
            },
            {
              "keys": [
                "bottom_shell_thickness"
              ]
            },
            {
              "keys": [
                "bottom_color_penetration_layers"
              ]
            },
            {
              "keys": [
                "infill_instead_top_bottom_surfaces"
              ]
            },
            {
              "keys": [
                "internal_solid_infill_pattern"
              ]
            }
          ]
        },
        {
          "title": "Sparse infill",
          "lines": [
            {
              "keys": [
                "sparse_infill_density"
              ]
            },
            {
              "keys": [
                "fill_multiline"
              ]
            },
            {
              "keys": [
                "sparse_infill_pattern"
              ]
            },
            {
              "keys": [
                "locked_skin_infill_pattern"
              ]
            },
            {
              "keys": [
                "skin_infill_density"
              ]
            },
            {
              "keys": [
                "locked_skeleton_infill_pattern"
              ]
            },
            {
              "keys": [
                "skeleton_infill_density"
              ]
            },
            {
              "keys": [
                "infill_lock_depth"
              ]
            },
            {
              "keys": [
                "skin_infill_depth"
              ]
            },
            {
              "keys": [
                "skin_infill_line_width"
              ]
            },
            {
              "keys": [
                "skeleton_infill_line_width"
              ]
            },
            {
              "keys": [
                "symmetric_infill_y_axis"
              ]
            },
            {
              "keys": [
                "infill_shift_step"
              ]
            },
            {
              "keys": [
                "sparse_infill_lattice_angle_1"
              ]
            },
            {
              "keys": [
                "sparse_infill_lattice_angle_2"
              ]
            },
            {
              "keys": [
                "infill_rotate_step"
              ]
            },
            {
              "keys": [
                "sparse_infill_anchor"
              ]
            },
            {
              "keys": [
                "sparse_infill_anchor_max"
              ]
            },
            {
              "keys": [
                "filter_out_gap_fill"
              ]
            }
          ]
        },
        {
          "title": "Advanced",
          "lines": [
            {
              "keys": [
                "infill_wall_overlap"
              ]
            },
            {
              "keys": [
                "monotonic_travel_into_wall"
              ]
            },
            {
              "keys": [
                "infill_direction"
              ]
            },
            {
              "keys": [
                "bridge_angle"
              ]
            },
            {
              "keys": [
                "minimum_sparse_infill_area"
              ]
            },
            {
              "keys": [
                "infill_combination"
              ]
            },
            {
              "keys": [
                "detect_narrow_internal_solid_infill"
              ]
            },
            {
              "keys": [
                "ensure_vertical_shell_thickness"
              ]
            },
            {
              "keys": [
                "detect_floating_vertical_shell"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "speed",
      "title": "Speed",
      "groups": [
        {
          "title": "Initial layer speed",
          "lines": [
            {
              "keys": [
                "initial_layer_speed"
              ]
            },
            {
              "keys": [
                "initial_layer_infill_speed"
              ]
            }
          ]
        },
        {
          "title": "Other layers speed",
          "lines": [
            {
              "keys": [
                "outer_wall_speed"
              ]
            },
            {
              "keys": [
                "inner_wall_speed"
              ]
            },
            {
              "keys": [
                "small_perimeter_speed"
              ]
            },
            {
              "keys": [
                "small_perimeter_threshold"
              ]
            },
            {
              "keys": [
                "sparse_infill_speed"
              ]
            },
            {
              "keys": [
                "internal_solid_infill_speed"
              ]
            },
            {
              "keys": [
                "vertical_shell_speed"
              ]
            },
            {
              "keys": [
                "top_surface_speed"
              ]
            },
            {
              "keys": [
                "enable_overhang_speed"
              ]
            },
            {
              "label": "Overhang speed",
              "keys": [
                "overhang_1_4_speed",
                "overhang_2_4_speed",
                "overhang_3_4_speed",
                "overhang_4_4_speed",
                "overhang_totally_speed"
              ]
            },
            {
              "keys": [
                "enable_height_slowdown"
              ]
            },
            {
              "keys": [
                "slowdown_start_height"
              ]
            },
            {
              "keys": [
                "slowdown_start_speed"
              ]
            },
            {
              "keys": [
                "slowdown_start_acc"
              ]
            },
            {
              "keys": [
                "slowdown_end_height"
              ]
            },
            {
              "keys": [
                "slowdown_end_speed"
              ]
            },
            {
              "keys": [
                "slowdown_end_acc"
              ]
            },
            {
              "keys": [
                "bridge_speed"
              ]
            },
            {
              "keys": [
                "gap_infill_speed"
              ]
            },
            {
              "keys": [
                "support_speed"
              ]
            },
            {
              "keys": [
                "support_interface_speed"
              ]
            }
          ]
        },
        {
          "title": "Travel speed",
          "lines": [
            {
              "keys": [
                "travel_speed"
              ]
            }
          ]
        },
        {
          "title": "Acceleration",
          "lines": [
            {
              "keys": [
                "default_acceleration"
              ]
            },
            {
              "keys": [
                "travel_acceleration"
              ]
            },
            {
              "keys": [
                "travel_short_distance_acceleration"
              ]
            },
            {
              "keys": [
                "initial_layer_travel_acceleration"
              ]
            },
            {
              "keys": [
                "initial_layer_acceleration"
              ]
            },
            {
              "keys": [
                "outer_wall_acceleration"
              ]
            },
            {
              "keys": [
                "inner_wall_acceleration"
              ]
            },
            {
              "keys": [
                "top_surface_acceleration"
              ]
            },
            {
              "keys": [
                "sparse_infill_acceleration"
              ]
            },
            {
              "keys": [
                "accel_to_decel_enable"
              ]
            },
            {
              "keys": [
                "accel_to_decel_factor"
              ]
            }
          ]
        },
        {
          "title": "Jerk(XY)",
          "lines": [
            {
              "keys": [
                "default_jerk"
              ]
            },
            {
              "keys": [
                "outer_wall_jerk"
              ]
            },
            {
              "keys": [
                "inner_wall_jerk"
              ]
            },
            {
              "keys": [
                "infill_jerk"
              ]
            },
            {
              "keys": [
                "top_surface_jerk"
              ]
            },
            {
              "keys": [
                "initial_layer_jerk"
              ]
            },
            {
              "keys": [
                "travel_jerk"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "support",
      "title": "Support",
      "groups": [
        {
          "title": "Support",
          "lines": [
            {
              "keys": [
                "enable_support"
              ]
            },
            {
              "keys": [
                "support_type"
              ]
            },
            {
              "keys": [
                "support_style"
              ]
            },
            {
              "keys": [
                "support_threshold_angle"
              ]
            },
            {
              "keys": [
                "support_on_build_plate_only"
              ]
            },
            {
              "keys": [
                "support_critical_regions_only"
              ]
            },
            {
              "keys": [
                "support_remove_small_overhang"
              ]
            }
          ]
        },
        {
          "title": "Raft",
          "lines": [
            {
              "keys": [
                "raft_layers"
              ]
            },
            {
              "keys": [
                "raft_contact_distance"
              ]
            }
          ]
        },
        {
          "title": "Support filament",
          "lines": [
            {
              "keys": [
                "support_filament"
              ]
            },
            {
              "keys": [
                "support_interface_filament"
              ]
            },
            {
              "keys": [
                "support_interface_not_for_body"
              ]
            }
          ]
        },
        {
          "title": "Support ironing",
          "lines": [
            {
              "keys": [
                "enable_support_ironing"
              ]
            },
            {
              "keys": [
                "support_ironing_pattern"
              ]
            },
            {
              "keys": [
                "support_ironing_speed"
              ]
            },
            {
              "keys": [
                "support_ironing_flow"
              ]
            },
            {
              "keys": [
                "support_ironing_spacing"
              ]
            },
            {
              "keys": [
                "support_ironing_inset"
              ]
            },
            {
              "keys": [
                "support_ironing_direction"
              ]
            }
          ]
        },
        {
          "title": "Advanced",
          "lines": [
            {
              "keys": [
                "raft_first_layer_density"
              ]
            },
            {
              "keys": [
                "raft_first_layer_expansion"
              ]
            },
            {
              "keys": [
                "tree_support_wall_count"
              ]
            },
            {
              "keys": [
                "support_top_z_distance"
              ]
            },
            {
              "keys": [
                "support_bottom_z_distance"
              ]
            },
            {
              "keys": [
                "support_base_pattern"
              ]
            },
            {
              "keys": [
                "support_base_pattern_spacing"
              ]
            },
            {
              "keys": [
                "support_angle"
              ]
            },
            {
              "keys": [
                "support_interface_top_layers"
              ]
            },
            {
              "keys": [
                "support_interface_bottom_layers"
              ]
            },
            {
              "keys": [
                "support_interface_pattern"
              ]
            },
            {
              "keys": [
                "support_interface_spacing"
              ]
            },
            {
              "keys": [
                "support_bottom_interface_spacing"
              ]
            },
            {
              "keys": [
                "support_expansion"
              ]
            },
            {
              "keys": [
                "support_object_xy_distance"
              ]
            },
            {
              "keys": [
                "top_z_overrides_xy_distance"
              ]
            },
            {
              "keys": [
                "support_object_first_layer_gap"
              ]
            },
            {
              "keys": [
                "bridge_no_support"
              ]
            },
            {
              "keys": [
                "max_bridge_length"
              ]
            },
            {
              "keys": [
                "independent_support_layer_height"
              ]
            }
          ]
        },
        {
          "title": "Tree Support",
          "lines": [
            {
              "keys": [
                "tree_support_branch_distance"
              ]
            },
            {
              "keys": [
                "tree_support_branch_diameter"
              ]
            },
            {
              "keys": [
                "tree_support_branch_angle"
              ]
            },
            {
              "keys": [
                "tree_support_branch_diameter_angle"
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "others",
      "title": "Others",
      "groups": [
        {
          "title": "Bed adhension",
          "lines": [
            {
              "keys": [
                "skirt_loops"
              ]
            },
            {
              "keys": [
                "skirt_height"
              ]
            },
            {
              "keys": [
                "skirt_distance"
              ]
            },
            {
              "keys": [
                "brim_type"
              ]
            },
            {
              "keys": [
                "brim_width"
              ]
            },
            {
              "keys": [
                "brim_object_gap"
              ]
            }
          ]
        },
        {
          "title": "Prime tower",
          "lines": [
            {
              "keys": [
                "enable_prime_tower"
              ]
            },
            {
              "keys": [
                "prime_tower_skip_points"
              ]
            },
            {
              "keys": [
                "prime_tower_enable_framework"
              ]
            },
            {
              "keys": [
                "prime_tower_width"
              ]
            },
            {
              "keys": [
                "prime_tower_max_speed"
              ]
            },
            {
              "keys": [
                "prime_tower_brim_width"
              ]
            },
            {
              "keys": [
                "prime_tower_infill_gap"
              ]
            },
            {
              "keys": [
                "prime_tower_rib_wall"
              ]
            },
            {
              "keys": [
                "prime_tower_extra_rib_length"
              ]
            },
            {
              "keys": [
                "prime_tower_rib_width"
              ]
            },
            {
              "keys": [
                "prime_tower_fillet_wall"
              ]
            },
            {
              "keys": [
                "enable_tower_interface_features"
              ]
            }
          ]
        },
        {
          "title": "Flush options",
          "lines": [
            {
              "keys": [
                "flush_into_infill"
              ]
            },
            {
              "keys": [
                "flush_into_objects"
              ]
            },
            {
              "keys": [
                "flush_into_support"
              ]
            }
          ]
        },
        {
          "title": "Special mode",
          "lines": [
            {
              "keys": [
                "slicing_mode"
              ]
            },
            {
              "keys": [
                "print_sequence"
              ]
            },
            {
              "keys": [
                "spiral_mode"
              ]
            },
            {
              "keys": [
                "spiral_mode_smooth"
              ]
            },
            {
              "keys": [
                "spiral_mode_max_xy_smoothing"
              ]
            },
            {
              "keys": [
                "timelapse_type"
              ]
            },
            {
              "keys": [
                "fuzzy_skin"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_mode"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_noise_type"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_point_distance"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_thickness"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_scale"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_octaves"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_persistence"
              ]
            },
            {
              "keys": [
                "fuzzy_skin_first_layer"
              ]
            }
          ]
        },
        {
          "title": "Advanced",
          "lines": [
            {
              "keys": [
                "enable_wrapping_detection"
              ]
            },
            {
              "keys": [
                "enable_order_independent_overlap_carving"
              ]
            },
            {
              "keys": [
                "interlocking_beam"
              ]
            },
            {
              "keys": [
                "mmu_segmented_region_interlocking_depth"
              ]
            },
            {
              "keys": [
                "interlocking_beam_width"
              ]
            },
            {
              "keys": [
                "interlocking_orientation"
              ]
            },
            {
              "keys": [
                "interlocking_beam_layer_count"
              ]
            },
            {
              "keys": [
                "interlocking_depth"
              ]
            },
            {
              "keys": [
                "interlocking_boundary_avoidance"
              ]
            },
            {
              "keys": [
                "sparse_infill_filament"
              ]
            },
            {
              "keys": [
                "solid_infill_filament"
              ]
            },
            {
              "keys": [
                "wall_filament"
              ]
            }
          ]
        },
        {
          "title": "G-code output",
          "lines": [
            {
              "keys": [
                "reduce_infill_retraction_mode"
              ]
            },
            {
              "keys": [
                "gcode_add_line_number"
              ]
            },
            {
              "keys": [
                "exclude_object"
              ]
            },
            {
              "keys": [
                "filename_format"
              ],
              "fullWidth": true
            }
          ]
        },
        {
          "title": "Post-processing scripts",
          "lines": [
            {
              "keys": [
                "post_process"
              ],
              "fullWidth": true,
              "code": true,
              "height": 15
            }
          ]
        },
        {
          "title": "Notes",
          "lines": [
            {
              "keys": [
                "process_notes"
              ],
              "fullWidth": true,
              "height": 25
            }
          ]
        }
      ]
    }
  ],
  "options": {
    "layer_height": {
      "type": "float",
      "label": "Layer height",
      "tooltip": "Slicing height for each layer. Smaller layer height means more accurate and more printing time",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "simple",
      "min": 0,
      "default": "0.2"
    },
    "initial_layer_print_height": {
      "type": "float",
      "label": "Initial layer height",
      "tooltip": "Height of initial layer. Making initial layer height thick slightly can improve build plate adhension",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "simple",
      "min": 0,
      "default": "0.2"
    },
    "enable_mixed_color_sublayer": {
      "type": "bool",
      "label": "Mixed color sublayer",
      "tooltip": "Enable mixed color sublayer splitting. When enabled, layers containing mixed color filaments will be split into sub-layers to achieve color mixing effects.",
      "category": "Quality",
      "mode": "simple",
      "default": "0"
    },
    "line_width": {
      "type": "float",
      "label": "Default",
      "tooltip": "Default line width if some line width is set to be zero",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "max": 10,
      "default": "0.4"
    },
    "initial_layer_line_width": {
      "type": "float",
      "label": "Initial layer",
      "tooltip": "Line width of initial layer",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "outer_wall_line_width": {
      "type": "float",
      "label": "Outer wall",
      "tooltip": "Line width of outer wall",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "inner_wall_line_width": {
      "type": "float",
      "label": "Inner wall",
      "tooltip": "Line width of inner wall",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "top_surface_line_width": {
      "type": "float",
      "label": "Top surface",
      "tooltip": "Line width for top surfaces",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "sparse_infill_line_width": {
      "type": "float",
      "label": "Sparse infill",
      "tooltip": "Line width of internal sparse infill",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "internal_solid_infill_line_width": {
      "type": "float",
      "label": "Internal solid infill",
      "tooltip": "Line width of internal solid infill",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "support_line_width": {
      "type": "float",
      "label": "Support",
      "tooltip": "Line width of support",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "seam_position": {
      "type": "enum",
      "label": "Seam position",
      "tooltip": "The start position to print each part of outer wall",
      "category": "Quality",
      "enumValues": [
        "nearest",
        "aligned",
        "back",
        "random"
      ],
      "enumLabels": [
        "Nearest",
        "Aligned",
        "Back",
        "Random"
      ],
      "mode": "simple",
      "default": "aligned"
    },
    "seam_placement_away_from_overhangs": {
      "type": "bool",
      "label": "Seam placement away from overhangs(experimental)",
      "tooltip": "Ensure seam placement away from overhangs for alignment and backing modes.",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "seam_gap": {
      "type": "percent",
      "label": "Seam gap",
      "tooltip": "In order to reduce the visibility of the seam in a closed loop extrusion, the loop is interrupted and shortened by a specified amount.\nThis amount as a percentage of the current extruder diameter. The default value for this parameter is 15",
      "sidetext": "%",
      "category": "Quality",
      "mode": "develop",
      "min": 0,
      "default": "15%"
    },
    "seam_slope_conditional": {
      "type": "bool",
      "label": "Smart scarf seam application",
      "tooltip": "Apply scarf joints only to smooth perimeters where traditional seams do not conceal the seams at sharp corners effectively.",
      "category": "Quality",
      "mode": "advanced",
      "default": "1"
    },
    "scarf_angle_threshold": {
      "type": "int",
      "label": "Scarf application angle threshold",
      "tooltip": "This option sets the threshold angle for applying a conditional scarf joint seam.\nIf the seam angle within the perimeter loop exceeds this value (indicating the absence of sharp corners), a scarf joint seam will be used. The default value is 155°.",
      "sidetext": "°",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "max": 180,
      "default": "155"
    },
    "seam_slope_entire_loop": {
      "type": "bool",
      "label": "Scarf around entire wall",
      "tooltip": "The scarf extends to the entire length of the wall.",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "seam_slope_steps": {
      "type": "int",
      "label": "Scarf steps",
      "tooltip": "Minimum number of segments of each scarf.",
      "category": "Quality",
      "mode": "advanced",
      "min": 1,
      "default": "10"
    },
    "seam_slope_inner_walls": {
      "type": "bool",
      "label": "Scarf joint for inner walls",
      "tooltip": "Use scarf joint for inner walls as well.",
      "category": "Quality",
      "mode": "advanced",
      "default": "1"
    },
    "override_filament_scarf_seam_setting": {
      "type": "bool",
      "label": "Override filament scarf seam setting",
      "tooltip": "Overrider filament scarf seam setting and could control settings by modifier.",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "seam_slope_type": {
      "type": "enum",
      "label": "Scarf seam type",
      "tooltip": "Set scarf seam type for this filament. This setting could minimize seam visibiliy.",
      "category": "Quality",
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
      "mode": "advanced",
      "default": "none"
    },
    "seam_slope_start_height": {
      "type": "floatOrPercent",
      "label": "Scarf start height",
      "tooltip": "This amount can be specified in millimeters or as a percentage of the current layer height.",
      "sidetext": "mm/%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "seam_slope_gap": {
      "type": "floatOrPercent",
      "label": "Scarf slope gap",
      "tooltip": "In order to reduce the visiblity of the seam in closed loop, the inner wall and outer wall are shortened by a specified amount.",
      "sidetext": "mm/%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "seam_slope_min_length": {
      "type": "float",
      "label": "Scarf length",
      "tooltip": "Length of the scarf. Setting this parameter to zero effectively disables the scarf.",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "wipe_speed": {
      "type": "percent",
      "label": "Wipe speed",
      "tooltip": "The wipe speed is determined by the speed setting specified in this configuration.If the value is expressed as a percentage (e.g. 80%), it will be calculated based on the travel speed setting above.The default value for this parameter is 80%",
      "sidetext": "%",
      "category": "Quality",
      "mode": "develop",
      "min": 0.01,
      "default": "80%"
    },
    "role_base_wipe_speed": {
      "type": "bool",
      "label": "Role-based wipe speed",
      "tooltip": "The wipe speed is determined by speed of current extrusion role. e.g if a wipe action is executed immediately following an outer wall extrusion, the speed of the outer wall extrusion will be utilized for the wipe action.",
      "category": "Quality",
      "mode": "advanced",
      "default": "1"
    },
    "slice_closing_radius": {
      "type": "float",
      "label": "Slice gap closing radius",
      "tooltip": "Cracks smaller than 2x gap closing radius are being filled during the triangle mesh slicing. The gap closing operation may reduce the final print resolution, therefore it is advisable to keep the value reasonably low.",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0.049"
    },
    "resolution": {
      "type": "float",
      "label": "Resolution",
      "tooltip": "G-code path is generated after simplifying the contour of model to avoid too many points and gcode lines in the gcode file. Smaller value means higher resolution and more time to slice",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "default": "0.01"
    },
    "enable_arc_fitting": {
      "type": "bool",
      "label": "Arc fitting",
      "tooltip": "Enable this to get a G-code file which has G2 and G3 moves. And the fitting tolerance is the same as resolution",
      "mode": "advanced",
      "default": "0"
    },
    "xy_hole_compensation": {
      "type": "float",
      "label": "X-Y hole compensation",
      "tooltip": "Holes of object will be grown or shrunk in XY plane by the configured value. Positive value makes holes bigger. Negative value makes holes smaller. This function is used to adjust size slightly when the object has assembling issue",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "xy_contour_compensation": {
      "type": "float",
      "label": "X-Y contour compensation",
      "tooltip": "Contour of object will be grown or shrunk in XY plane by the configured value. Positive value makes contour bigger. Negative value makes contour smaller. This function is used to adjust size slightly when the object has assembling issue",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "enable_circle_compensation": {
      "type": "bool",
      "label": "Auto circle contour-hole compensation",
      "tooltip": "Expirment feature to compensate the circle holes and circle contour. This feature is used to improve the accuracy of the circle holes and contour within the diameter below 50mm. Only support PLA Basic, PLA CF, PET CF, PETG CF and PETG HF.",
      "mode": "advanced",
      "default": "0"
    },
    "circle_compensation_manual_offset": {
      "type": "float",
      "label": "User Customized Offset",
      "tooltip": "If you want to have tighter or looser assemble, you can set this value. When it is positive, it indicates tightening, otherwise, it indicates loosening",
      "sidetext": "mm",
      "mode": "advanced",
      "default": "0"
    },
    "elefant_foot_compensation": {
      "type": "float",
      "label": "Elephant foot compensation",
      "tooltip": "Shrink the initial layer on build plate to compensate for elephant foot effect",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "precise_outer_wall": {
      "type": "bool",
      "label": "Precise wall",
      "tooltip": "Improve shell precision by adjusting outer wall spacing. This also improves layer consistency.",
      "category": "Quality",
      "mode": "develop",
      "default": "0"
    },
    "precise_z_height": {
      "type": "bool",
      "label": "Precise Z height",
      "tooltip": "Enable this to get precise z height of object after slicing. It will get the precise object height by fine-tuning the layer heights of the last few layers. Note that this is an experimental parameter.",
      "mode": "advanced",
      "default": "0"
    },
    "ironing_type": {
      "type": "enum",
      "label": "Ironing Type",
      "tooltip": "Ironing is using small flow to print on same height of surface again to make flat surface more smooth. This setting controls which layer being ironed",
      "category": "Quality",
      "enumValues": [
        "no ironing",
        "top",
        "topmost",
        "solid"
      ],
      "enumLabels": [
        "No ironing",
        "Top surfaces",
        "Topmost surface",
        "All solid layer"
      ],
      "mode": "advanced",
      "default": "no ironing"
    },
    "ironing_pattern": {
      "type": "enum",
      "label": "Ironing Pattern",
      "tooltip": "",
      "category": "Quality",
      "enumValues": [
        "concentric",
        "zig-zag"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear"
      ],
      "mode": "advanced",
      "default": "zig-zag"
    },
    "ironing_speed": {
      "type": "float",
      "label": "Ironing speed",
      "tooltip": "Print speed of ironing lines",
      "sidetext": "mm/s",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "20"
    },
    "ironing_flow": {
      "type": "percent",
      "label": "Ironing flow",
      "tooltip": "The amount of material to extrude during ironing. Relative to flow of normal layer height. Too high value results in overextrusion on the surface",
      "sidetext": "%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "10%"
    },
    "ironing_spacing": {
      "type": "float",
      "label": "Ironing line spacing",
      "tooltip": "The distance between the lines of ironing",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "max": 1,
      "default": "0.1"
    },
    "ironing_inset": {
      "type": "float",
      "label": "Ironing inset",
      "tooltip": "The distance to keep the from the edges of ironing line. 0 means not apply.",
      "sidetext": "mm",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "ironing_direction": {
      "type": "float",
      "label": "ironing direction",
      "tooltip": "Angle for ironing, which controls the relative angle between the top surface and ironing",
      "sidetext": "°",
      "category": "Quality",
      "mode": "develop",
      "min": 0,
      "max": 360,
      "default": "45"
    },
    "wall_generator": {
      "type": "enum",
      "label": "Wall generator",
      "tooltip": "Classic wall generator produces walls with constant extrusion width and for very thin areas is used gap-fill. Arachne engine produces walls with variable extrusion width",
      "category": "Quality",
      "enumValues": [
        "classic",
        "arachne"
      ],
      "enumLabels": [
        "Classic",
        "Arachne"
      ],
      "mode": "advanced",
      "default": "arachne"
    },
    "wall_transition_angle": {
      "type": "float",
      "label": "Wall transitioning threshold angle",
      "tooltip": "When to create transitions between even and odd numbers of walls. A wedge shape with an angle greater than this setting will not have transitions and no walls will be printed in the center to fill the remaining space. Reducing this setting reduces the number and length of these center walls, but may leave gaps or overextrude",
      "sidetext": "°",
      "category": "Quality",
      "mode": "advanced",
      "min": 1,
      "max": 59,
      "default": "10"
    },
    "wall_transition_filter_deviation": {
      "type": "percent",
      "label": "Wall transitioning filter margin",
      "tooltip": "Prevent transitioning back and forth between one extra wall and one less. This margin extends the range of extrusion widths which follow to [Minimum wall width - margin, 2 * Minimum wall width + margin]. Increasing this margin reduces the number of transitions, which reduces the number of extrusion starts/stops and travel time. However, large extrusion width variation can lead to under- or overextrusion problems. It's expressed as a percentage over nozzle diameter",
      "sidetext": "%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "25%"
    },
    "wall_transition_length": {
      "type": "percent",
      "label": "Wall transition length",
      "tooltip": "When transitioning between different numbers of walls as the part becomes thinner, a certain amount of space is allotted to split or join the wall segments. It's expressed as a percentage over nozzle diameter",
      "sidetext": "%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "100%"
    },
    "wall_distribution_count": {
      "type": "int",
      "label": "Wall distribution count",
      "tooltip": "The number of walls, counted from the center, over which the variation needs to be spread. Lower values mean that the outer walls don't change in width",
      "category": "Quality",
      "mode": "advanced",
      "min": 1,
      "default": "1"
    },
    "min_bead_width": {
      "type": "percent",
      "label": "Minimum wall width",
      "tooltip": "Width of the wall that will replace thin features (according to the Minimum feature size) of the model. If the Minimum wall width is thinner than the thickness of the feature, the wall will become as thick as the feature itself. It's expressed as a percentage over nozzle diameter",
      "sidetext": "%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "85%"
    },
    "min_feature_size": {
      "type": "percent",
      "label": "Minimum feature size",
      "tooltip": "Minimum thickness of thin features. Model features that are thinner than this value will not be printed, while features thicker than the Minimum feature size will be widened to the Minimum wall width. It's expressed as a percentage over nozzle diameter",
      "sidetext": "%",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "25%"
    },
    "wall_sequence": {
      "type": "enum",
      "label": "Order of walls",
      "tooltip": "Print sequence of inner wall and outer wall. ",
      "category": "Quality",
      "enumValues": [
        "inner wall/outer wall",
        "outer wall/inner wall",
        "inner-outer-inner wall"
      ],
      "enumLabels": [
        "inner/outer",
        "outer/inner",
        "inner wall/outer wall/inner wall"
      ],
      "mode": "advanced",
      "default": "inner wall/outer wall"
    },
    "is_infill_first": {
      "type": "bool",
      "label": "Print infill first",
      "tooltip": "Order of wall/infill. false means print wall first. ",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "bridge_flow": {
      "type": "float",
      "label": "Bridge flow",
      "tooltip": "Decrease this value slightly(for example 0.9) to reduce the amount of material for bridge, to improve sag",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "max": 2,
      "default": "1"
    },
    "thick_bridges": {
      "type": "bool",
      "label": "Thick bridges",
      "tooltip": "If enabled, bridges are more reliable, can bridge longer distances, but may look worse. If disabled, bridges look better but are reliable just for shorter bridged distances.",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "print_flow_ratio": {
      "type": "float",
      "label": "Object flow ratio",
      "tooltip": "The flow ratio set by object, the meaning is the same as flow ratio.",
      "category": "Quality",
      "mode": "develop",
      "min": 0.01,
      "max": 2,
      "default": "1"
    },
    "top_solid_infill_flow_ratio": {
      "type": "float",
      "vector": true,
      "label": "Top surface flow ratio",
      "tooltip": "This factor affects the amount of material for top solid infill. You can decrease it slightly to have smooth surface finish",
      "category": "Quality",
      "mode": "develop",
      "min": 0,
      "max": 2,
      "default": "1",
      "guiType": "multi_variant"
    },
    "initial_layer_flow_ratio": {
      "type": "float",
      "label": "Initial layer flow ratio",
      "tooltip": "This factor affects the amount of material for the initial layer",
      "category": "Quality",
      "mode": "develop",
      "min": 0,
      "max": 2,
      "default": "1"
    },
    "top_one_wall_type": {
      "type": "enum",
      "label": "Only one wall on top surfaces",
      "tooltip": "Use only one wall on flat top surface, to give more space to the top infill pattern. Could be applied on topmost surface or all top surface.",
      "category": "Quality",
      "enumValues": [
        "not apply",
        "all top",
        "topmost"
      ],
      "enumLabels": [
        "Not apply",
        "Top surfaces",
        "Topmost surface"
      ],
      "mode": "simple",
      "default": "all top"
    },
    "top_area_threshold": {
      "type": "percent",
      "label": "Top area threshold",
      "tooltip": "The min width of top areas in percentage of perimeter line width.",
      "sidetext": "%",
      "mode": "develop",
      "min": 0,
      "max": 500,
      "default": "200%"
    },
    "only_one_wall_first_layer": {
      "type": "bool",
      "label": "Only one wall on first layer",
      "tooltip": "Use only one wall on the first layer of model",
      "category": "Quality",
      "mode": "simple",
      "default": "0"
    },
    "detect_overhang_wall": {
      "type": "bool",
      "label": "Detect overhang wall",
      "tooltip": "Detect the overhang percentage relative to line width and use different speed to print. For 100 percent overhang, bridge speed is used.",
      "category": "Quality",
      "mode": "develop",
      "default": "1"
    },
    "smooth_speed_discontinuity_area": {
      "type": "bool",
      "label": "Smooth speed discontinuity area",
      "tooltip": "Add the speed transition between discontinuity area.",
      "category": "Quality",
      "mode": "advanced",
      "default": "1"
    },
    "smooth_coefficient": {
      "type": "float",
      "label": "Smooth coefficient",
      "tooltip": "The smaller the number, the longer the speed transition path. 0 means not apply.",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "80"
    },
    "reduce_crossing_wall": {
      "type": "bool",
      "label": "Avoid crossing wall",
      "tooltip": "Detour and avoid traveling across wall which may cause blob on surface (when travel length greater than Travel distance threshold)",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "max_travel_detour_distance": {
      "type": "floatOrPercent",
      "label": "Avoid crossing wall - Max detour length",
      "tooltip": "Maximum detour distance for avoiding crossing wall. Don't detour if the detour distance is larger than this value. Detour length could be specified either as an absolute value or as percentage (for example 50%) of a direct travel path. Zero to disable",
      "sidetext": "mm or %",
      "category": "Quality",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "avoid_crossing_wall_includes_support": {
      "type": "bool",
      "label": "Avoid crossing wall - Includes support",
      "tooltip": "Including support while avoiding crossing wall.",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "z_direction_outwall_speed_continuous": {
      "type": "bool",
      "label": "Smoothing wall speed along Z(experimental)",
      "tooltip": "Smoothing outwall speed in z direction to get better surface quality. Print time will increases. This does not work on spiral vase mode.",
      "category": "Quality",
      "mode": "advanced",
      "default": "0"
    },
    "wall_loops": {
      "type": "int",
      "label": "Wall loops",
      "tooltip": "Number of walls of every layer",
      "category": "Strength",
      "mode": "simple",
      "min": 0,
      "max": 1000,
      "default": "2"
    },
    "alternate_extra_wall": {
      "type": "bool",
      "label": "Alternate extra wall",
      "tooltip": "Add an extra wall on alternating layers to improve layer bonding and part strength without the full cost of a permanent extra wall.",
      "category": "Strength",
      "mode": "simple",
      "default": "0"
    },
    "embedding_wall_into_infill": {
      "type": "bool",
      "label": "Embedding the wall into the infill",
      "tooltip": "Embedding the wall into parts where the wall loops are absent ensures that the wall connects seamlessly to the infill.",
      "category": "Strength",
      "mode": "simple",
      "default": "0"
    },
    "detect_thin_wall": {
      "type": "bool",
      "label": "Detect thin wall",
      "tooltip": "Detect thin wall which can't contain two line width. And use single line to print. Maybe printed not very well, because it's not closed loop",
      "category": "Strength",
      "mode": "advanced",
      "default": "0"
    },
    "interface_shells": {
      "type": "bool",
      "label": "Interface shells",
      "tooltip": "Force the generation of solid shells between adjacent materials/volumes. Useful for multi-extruder prints with translucent materials or manual soluble support material",
      "category": "Quality",
      "mode": "develop",
      "default": "0"
    },
    "top_surface_pattern": {
      "type": "enum",
      "label": "Top surface pattern",
      "tooltip": "Line pattern of top surface infill",
      "category": "Strength",
      "enumValues": [
        "concentric",
        "zig-zag",
        "monotonic",
        "monotonicline",
        "alignedrectilinear",
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear",
        "Monotonic",
        "Monotonic line",
        "Aligned Rectilinear",
        "Hilbert Curve",
        "Archimedean Chords",
        "Octagram Spiral"
      ],
      "mode": "simple",
      "default": "zig-zag"
    },
    "top_surface_density": {
      "type": "percent",
      "label": "Top surface density",
      "tooltip": "Density of top surface infill, 100% means a fully solid filled top layer.Lower values create a textured top surface, at 0%, only the walls are created on the top layer.Intended for aesthetic or functional purposes, not to fix issues such as over-extrusion.",
      "sidetext": "%",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "100%"
    },
    "top_shell_layers": {
      "type": "int",
      "label": "Top shell layers",
      "tooltip": "This is the number of solid layers of top shell, including the top surface layer. When the thickness calculated by this value is thinner than top shell thickness, the top shell layers will be increased",
      "category": "Strength",
      "mode": "simple",
      "min": 0,
      "default": "4"
    },
    "top_shell_thickness": {
      "type": "float",
      "label": "Top shell thickness",
      "tooltip": "The number of top solid layers is increased when slicing if the thickness calculated by top shell layers is thinner than this value. This can avoid having too thin shell when layer height is small. 0 means that this setting is disabled and thickness of top shell is absolutely determained by top shell layers",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "simple",
      "min": 0,
      "default": "0.6"
    },
    "top_color_penetration_layers": {
      "type": "int",
      "label": "Top paint penetration layers",
      "tooltip": "This is  the number of layers of top paint penetration.",
      "category": "Strength",
      "mode": "simple",
      "min": 1,
      "default": "4"
    },
    "bottom_surface_pattern": {
      "type": "enum",
      "label": "Bottom surface pattern",
      "tooltip": "Line pattern of bottom surface infill, not bridge infill",
      "category": "Strength",
      "enumValues": [
        "concentric",
        "zig-zag",
        "monotonic",
        "monotonicline",
        "alignedrectilinear",
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear",
        "Monotonic",
        "Monotonic line",
        "Aligned Rectilinear",
        "Hilbert Curve",
        "Archimedean Chords",
        "Octagram Spiral"
      ],
      "mode": "simple",
      "default": "zig-zag"
    },
    "bottom_surface_density": {
      "type": "percent",
      "label": "Bottom surface density",
      "tooltip": "Density of bottom surface infill, 100% means a fully solid filled top layer.Lower values create a textured bottom surface, Intended for aesthetic or functional purposes, not to fix issues such as over-extrusion.WARNING: Lowering this value may negatively affect bed adhesion.",
      "sidetext": "%",
      "category": "Strength",
      "mode": "advanced",
      "min": 10,
      "max": 100,
      "default": "100%"
    },
    "bottom_shell_layers": {
      "type": "int",
      "label": "Bottom shell layers",
      "tooltip": "This is the number of solid layers of bottom shell, including the bottom surface layer. When the thickness calculated by this value is thinner than bottom shell thickness, the bottom shell layers will be increased",
      "category": "Strength",
      "mode": "simple",
      "min": 0,
      "default": "3"
    },
    "bottom_shell_thickness": {
      "type": "float",
      "label": "Bottom shell thickness",
      "tooltip": "The number of bottom solid layers is increased when slicing if the thickness calculated by bottom shells layers is thinner than this value. This can avoid having too thin shell when layer height is small. 0 means that this setting is disabled and thickness of bottom shell is absolutely determained by bottom shell layers",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "simple",
      "min": 0,
      "default": "0"
    },
    "bottom_color_penetration_layers": {
      "type": "int",
      "label": "Bottom paint penetration layers",
      "tooltip": "This is the number of layers of bottom paint penetration.",
      "category": "Strength",
      "mode": "simple",
      "min": 1,
      "default": "3"
    },
    "infill_instead_top_bottom_surfaces": {
      "type": "bool",
      "label": "Use infill instead of top and bottom surfaces",
      "tooltip": "Using infill instead of top and bottom surfaces.",
      "category": "Strength",
      "mode": "simple",
      "default": "0"
    },
    "internal_solid_infill_pattern": {
      "type": "enum",
      "label": "Internal solid infill pattern",
      "tooltip": "Line pattern of internal solid infill. if the detect narrow internal solid infill be enabled, the concentric pattern will be used for the small area.",
      "category": "Strength",
      "enumValues": [
        "concentric",
        "zig-zag",
        "monotonic",
        "monotonicline",
        "alignedrectilinear",
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear",
        "Monotonic",
        "Monotonic line",
        "Aligned Rectilinear",
        "Hilbert Curve",
        "Archimedean Chords",
        "Octagram Spiral"
      ],
      "mode": "simple",
      "default": "zig-zag"
    },
    "sparse_infill_density": {
      "type": "percent",
      "label": "Sparse infill density",
      "tooltip": "Density of internal sparse infill, 100% means solid throughout",
      "sidetext": "%",
      "category": "Strength",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "20%"
    },
    "fill_multiline": {
      "type": "int",
      "label": "Fill multiline",
      "tooltip": "Using multiple lines for the infill pattern, if supported by infill pattern.",
      "category": "Strength",
      "mode": "simple",
      "min": 1,
      "max": 5,
      "default": "1"
    },
    "sparse_infill_pattern": {
      "type": "enum",
      "label": "Sparse infill pattern",
      "tooltip": "Line pattern for internal sparse infill",
      "category": "Strength",
      "enumValues": [
        "concentric",
        "zig-zag",
        "grid",
        "line",
        "cubic",
        "triangles",
        "tri-hexagon",
        "gyroid",
        "honeycomb",
        "adaptivecubic",
        "alignedrectilinear",
        "3dhoneycomb",
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral",
        "supportcubic",
        "lightning",
        "crosshatch",
        "zigzag",
        "crosszag",
        "lockedzag",
        "2dlattice"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear",
        "Grid",
        "Line",
        "Cubic",
        "Triangles",
        "Tri-hexagon",
        "Gyroid",
        "Honeycomb",
        "Adaptive Cubic",
        "Aligned Rectilinear",
        "3D Honeycomb",
        "Hilbert Curve",
        "Archimedean Chords",
        "Octagram Spiral",
        "Support Cubic",
        "Lightning",
        "Cross Hatch",
        "Zig Zag",
        "Cross Zag",
        "Locked Zag",
        "2D Lattice"
      ],
      "mode": "simple",
      "default": "cubic"
    },
    "locked_skin_infill_pattern": {
      "type": "enum",
      "label": "Skin infill pattern",
      "tooltip": "Line pattern for skin",
      "category": "Strength",
      "enumValues": [
        "concentric",
        "zig-zag",
        "grid",
        "line",
        "cubic",
        "triangles",
        "tri-hexagon",
        "gyroid",
        "honeycomb",
        "alignedrectilinear",
        "3dhoneycomb",
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral",
        "crosshatch",
        "zigzag",
        "crosszag"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear",
        "Grid",
        "Line",
        "Cubic",
        "Triangles",
        "Tri-hexagon",
        "Gyroid",
        "Honeycomb",
        "Aligned Rectilinear",
        "3D Honeycomb",
        "Hilbert Curve",
        "Archimedean Chords",
        "Octagram Spiral",
        "Cross Hatch",
        "Zig Zag",
        "Cross Zag"
      ],
      "mode": "simple",
      "default": "crosszag"
    },
    "skin_infill_density": {
      "type": "percent",
      "label": "Skin infill density",
      "tooltip": "The portion of the model's outer surface within a certain depth range is called the skin. This parameter is used to adjust the density of this section.When two regions have the same sparse infill settings but different skin densities, This area will not be split into two separate regions.default is as same as infill density.",
      "sidetext": "%",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "15%"
    },
    "locked_skeleton_infill_pattern": {
      "type": "enum",
      "label": "Skeleton infill pattern",
      "tooltip": "Line pattern for skeleton",
      "category": "Strength",
      "enumValues": [
        "concentric",
        "zig-zag",
        "grid",
        "line",
        "cubic",
        "triangles",
        "tri-hexagon",
        "gyroid",
        "honeycomb",
        "alignedrectilinear",
        "3dhoneycomb",
        "hilbertcurve",
        "archimedeanchords",
        "octagramspiral",
        "crosshatch",
        "zigzag",
        "crosszag"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear",
        "Grid",
        "Line",
        "Cubic",
        "Triangles",
        "Tri-hexagon",
        "Gyroid",
        "Honeycomb",
        "Aligned Rectilinear",
        "3D Honeycomb",
        "Hilbert Curve",
        "Archimedean Chords",
        "Octagram Spiral",
        "Cross Hatch",
        "Zig Zag",
        "Cross Zag"
      ],
      "mode": "simple",
      "default": "zigzag"
    },
    "skeleton_infill_density": {
      "type": "percent",
      "label": "Skeleton infill density",
      "tooltip": "The remaining part of the model contour after removing a certain depth from the surface is called the skeleton. This parameter is used to adjust the density of this section.When two regions have the same sparse infill settings but different skeleton densities, their skeleton areas will develop overlapping sections.default is as same as infill density.",
      "sidetext": "%",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "15%"
    },
    "infill_lock_depth": {
      "type": "float",
      "label": "Infill lock depth",
      "tooltip": "The parameter sets the overlapping depth between the interior and skin.",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "1"
    },
    "skin_infill_depth": {
      "type": "float",
      "label": "Skin infill depth",
      "tooltip": "The parameter sets the depth of skin.",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "2"
    },
    "skin_infill_line_width": {
      "type": "float",
      "label": "Skin line width",
      "tooltip": "Adjust the line width of the selected skin paths.",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "skeleton_infill_line_width": {
      "type": "float",
      "label": "Skeleton line width",
      "tooltip": "Adjust the line width of the selected skeleton paths.",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "default": "0.4"
    },
    "symmetric_infill_y_axis": {
      "type": "bool",
      "label": "Symmetric infill y axis",
      "tooltip": "If the model has two parts that are symmetric about the y-axis, and you want these parts to have symmetric textures, please click this option on one of the parts.",
      "category": "Strength",
      "mode": "advanced",
      "default": "0"
    },
    "infill_shift_step": {
      "type": "float",
      "label": "Infill shift step",
      "tooltip": "This parameter adds a slight displacement to each layer of infill to create a cross texture.",
      "sidetext": "mm",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 10,
      "default": "0.4"
    },
    "sparse_infill_lattice_angle_1": {
      "type": "float",
      "label": "Lattice angle 1",
      "tooltip": "The angle of the first set of 2D lattice elements in the Z direction. Zero is vertical.",
      "sidetext": "°",
      "category": "Strength",
      "mode": "advanced",
      "min": -75,
      "max": 75,
      "default": "-45"
    },
    "sparse_infill_lattice_angle_2": {
      "type": "float",
      "label": "Lattice angle 2",
      "tooltip": "The angle of the second set of 2D lattice elements in the Z direction. Zero is vertical.",
      "sidetext": "°",
      "category": "Strength",
      "mode": "advanced",
      "min": -75,
      "max": 75,
      "default": "45"
    },
    "infill_rotate_step": {
      "type": "float",
      "label": "Infill rotate step",
      "tooltip": "This parameter adds a slight rotation to each layer of infill to create a cross texture.",
      "sidetext": "°",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 360,
      "default": "0"
    },
    "sparse_infill_anchor": {
      "type": "floatOrPercent",
      "label": "Length of sparse infill anchor",
      "tooltip": "Connect a sparse infill line to an internal perimeter with a short segment of an additional perimeter. If expressed as percentage (example: 15%) it is calculated over sparse infill line width. Slicer tries to connect two close infill lines to a short perimeter segment. If no such perimeter segment shorter than infill_anchor_max is found, the infill line is connected to a perimeter segment at just one side and the length of the perimeter segment taken is limited to this parameter, but no longer than anchor_length_max. Set this parameter to zero to disable anchoring perimeters connected to a single infill line.",
      "sidetext": "mm or %",
      "category": "Strength",
      "enumValues": [
        "0",
        "1",
        "2",
        "5",
        "10",
        "1000"
      ],
      "enumLabels": [
        "0 (no open anchors)",
        "1 mm",
        "2 mm",
        "5 mm",
        "10 mm",
        "1000 (unlimited)"
      ],
      "mode": "advanced",
      "default": "400%",
      "guiType": "f_enum_open"
    },
    "sparse_infill_anchor_max": {
      "type": "floatOrPercent",
      "label": "Maximum length of sparse infill anchor",
      "tooltip": "Connect a sparse infill line to an internal perimeter with a short segment of an additional perimeter. If expressed as percentage (example: 15%) it is calculated over sparse infill line width. Slicer tries to connect two close infill lines to a short perimeter segment. If no such perimeter segment shorter than this parameter is found, the infill line is connected to a perimeter segment at just one side and the length of the perimeter segment taken is limited to infill_anchor, but no longer than this parameter. Set this parameter to zero to disable anchoring.",
      "enumValues": [
        "0",
        "1",
        "2",
        "5",
        "10",
        "1000"
      ],
      "enumLabels": [
        "0 (not anchored)",
        "1 mm",
        "2 mm",
        "5 mm",
        "10 mm",
        "1000 (unlimited)"
      ],
      "mode": "simple",
      "default": "20"
    },
    "filter_out_gap_fill": {
      "type": "float",
      "label": "Filter out tiny gaps",
      "tooltip": "Filter out gaps smaller than the threshold specified. Gaps smaller than this threshold will be ignored",
      "sidetext": "mm",
      "mode": "develop",
      "default": "0"
    },
    "infill_wall_overlap": {
      "type": "percent",
      "label": "Infill/Wall overlap",
      "tooltip": "Infill area is enlarged slightly to overlap with wall for better bonding. The percentage value is relative to line width of sparse infill",
      "sidetext": "%",
      "category": "Strength",
      "mode": "advanced",
      "default": "15%"
    },
    "monotonic_travel_into_wall": {
      "type": "percent",
      "label": "Monotonic line travel extend",
      "tooltip": "Enable this option to extend the travel distance between lines, improving the adhesion between the monotonic line infill and the walls.(percent to line width)",
      "sidetext": "%",
      "category": "Strength",
      "mode": "develop",
      "min": 0,
      "max": 200,
      "default": "0%"
    },
    "infill_direction": {
      "type": "float",
      "label": "Infill direction",
      "tooltip": "Angle for sparse infill pattern, which controls the start or main direction of line",
      "sidetext": "°",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "max": 360,
      "default": "45"
    },
    "bridge_angle": {
      "type": "float",
      "label": "Bridge direction",
      "tooltip": "Bridging angle override. If left to zero, the bridging angle will be calculated automatically. Otherwise the provided angle will be used for external bridges. Use 180°for zero angle.",
      "sidetext": "°",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "minimum_sparse_infill_area": {
      "type": "float",
      "label": "Minimum sparse infill threshold",
      "tooltip": "Sparse infill area which is smaller than threshold value is replaced by internal solid infill",
      "sidetext": "mm²",
      "category": "Strength",
      "mode": "advanced",
      "min": 0,
      "default": "15"
    },
    "infill_combination": {
      "type": "bool",
      "label": "Infill combination",
      "tooltip": "Automatically Combine sparse infill of several layers to print together to reduce time. Wall is still printed with original layer height.",
      "category": "Strength",
      "mode": "advanced",
      "default": "0"
    },
    "detect_narrow_internal_solid_infill": {
      "type": "bool",
      "label": "Detect narrow internal solid infill",
      "tooltip": "This option will auto detect narrow internal solid infill area. If enabled, concentric pattern will be used for the area to speed printing up. Otherwise, rectilinear pattern is used defaultly.",
      "category": "Strength",
      "mode": "advanced",
      "default": "1"
    },
    "ensure_vertical_shell_thickness": {
      "type": "enum",
      "label": "Ensure vertical shell thickness",
      "tooltip": "Add solid infill near sloping surfaces to guarantee the vertical shell thickness (top+bottom solid layers)",
      "category": "Strength",
      "enumValues": [
        "disabled",
        "partial",
        "enabled"
      ],
      "enumLabels": [
        "Disabled",
        "Partial",
        "Enabled"
      ],
      "mode": "advanced",
      "default": "enabled"
    },
    "detect_floating_vertical_shell": {
      "type": "bool",
      "label": "Detect floating vertical shells",
      "tooltip": "Detect overhang paths in vertical shells and slow them by bridge speed.",
      "mode": "advanced",
      "default": "1"
    },
    "initial_layer_speed": {
      "type": "float",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Speed of initial layer except the solid infill part",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "30"
    },
    "initial_layer_infill_speed": {
      "type": "float",
      "vector": true,
      "label": "Initial layer infill",
      "tooltip": "Speed of solid infill part of initial layer",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 1,
      "default": "60"
    },
    "outer_wall_speed": {
      "type": "float",
      "vector": true,
      "label": "Outer wall",
      "tooltip": "Speed of outer wall which is outermost and visible. It's used to be slower than inner wall speed to get better quality.",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "60"
    },
    "inner_wall_speed": {
      "type": "float",
      "vector": true,
      "label": "Inner wall",
      "tooltip": "Speed of inner wall",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "60"
    },
    "small_perimeter_speed": {
      "type": "string",
      "vector": true,
      "label": "Small perimeters",
      "tooltip": "This setting will affect the speed of perimeters having radius <= small perimeter threshold(usually holes). If expressed as percentage (for example: 80%) it will be calculated onthe outer wall speed setting above. Set to zero for auto.",
      "sidetext": "mm/s or %",
      "category": "Speed",
      "mode": "advanced",
      "min": 0
    },
    "small_perimeter_threshold": {
      "type": "float",
      "vector": true,
      "label": "Small perimeter threshold",
      "tooltip": "This sets the threshold for small perimeter length. Default threshold is 0mm",
      "sidetext": "mm",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "sparse_infill_speed": {
      "type": "float",
      "vector": true,
      "label": "Sparse infill",
      "tooltip": "Speed of internal sparse infill",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "100"
    },
    "internal_solid_infill_speed": {
      "type": "float",
      "vector": true,
      "label": "Internal solid infill",
      "tooltip": "Speed of internal solid infill, not the top and bottom surface",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "100"
    },
    "vertical_shell_speed": {
      "type": "string",
      "vector": true,
      "label": "Vertical shell speed",
      "tooltip": "Speed for vertical shells with overhang regions. If expressed as percentage (for example: 80%) it will be calculated onthe internal solid infill speed above",
      "sidetext": "mm/s or %",
      "category": "Speed",
      "mode": "advanced",
      "min": 0
    },
    "top_surface_speed": {
      "type": "float",
      "vector": true,
      "label": "Top surface",
      "tooltip": "Speed of top surface infill which is solid",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "100"
    },
    "enable_overhang_speed": {
      "type": "bool",
      "vector": true,
      "label": "Slow down for overhang",
      "tooltip": "Enable this option to slow printing down for different overhang degree",
      "category": "Speed",
      "mode": "advanced",
      "default": "1"
    },
    "overhang_1_4_speed": {
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
    "overhang_2_4_speed": {
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
    "overhang_3_4_speed": {
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
    "overhang_4_4_speed": {
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
    "overhang_totally_speed": {
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
    "enable_height_slowdown": {
      "type": "bool",
      "vector": true,
      "label": "Slow down by height",
      "tooltip": "Enable this option to slow printing down by height",
      "category": "Speed",
      "mode": "advanced",
      "default": "0"
    },
    "slowdown_start_height": {
      "type": "float",
      "vector": true,
      "label": "Starting height",
      "tooltip": "The height starts to slow down",
      "sidetext": "mm",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "slowdown_start_speed": {
      "type": "float",
      "vector": true,
      "label": "Speed at starting height",
      "tooltip": "",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "1000"
    },
    "slowdown_start_acc": {
      "type": "float",
      "vector": true,
      "label": "Acceleration at starting height",
      "tooltip": "",
      "sidetext": "mm/s²",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "100000"
    },
    "slowdown_end_height": {
      "type": "float",
      "vector": true,
      "label": "Ending height",
      "tooltip": "The height finishes slowing down, Ending height should be larger than Starting height, or the slowing down will not work!",
      "sidetext": "mm",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "400"
    },
    "slowdown_end_speed": {
      "type": "float",
      "vector": true,
      "label": "Speed at ending height",
      "tooltip": "",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "1000"
    },
    "slowdown_end_acc": {
      "type": "float",
      "vector": true,
      "label": "Acceleration at ending height",
      "tooltip": "",
      "sidetext": "mm/s²",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "100000"
    },
    "bridge_speed": {
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
    "gap_infill_speed": {
      "type": "float",
      "vector": true,
      "label": "Gap infill",
      "tooltip": "Speed of gap infill. Gap usually has irregular line width and should be printed more slowly",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "30"
    },
    "support_speed": {
      "type": "float",
      "vector": true,
      "label": "Support",
      "tooltip": "Speed of support",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 0,
      "default": "80"
    },
    "support_interface_speed": {
      "type": "float",
      "vector": true,
      "label": "Support interface",
      "tooltip": "Speed of support interface",
      "sidetext": "mm/s",
      "category": "Speed",
      "mode": "advanced",
      "min": 1,
      "default": "80"
    },
    "travel_speed": {
      "type": "float",
      "vector": true,
      "label": "Travel",
      "tooltip": "Speed of travel which is faster and without extrusion",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 1,
      "default": "120"
    },
    "default_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Normal printing",
      "tooltip": "The default acceleration of both normal printing and travel except initial layer",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "500"
    },
    "travel_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Travel",
      "tooltip": "The acceleration of travel except initial layer",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "500"
    },
    "travel_short_distance_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Short travel",
      "tooltip": "Acceleration used for short travel moves near external perimeters. Short travels are moves shorter than the 'Retraction minimum travel' distance.\n\nLower values (e.g., 250-500 mm/s²) reduce ringing artifacts on sharp corners without significantly impacting print time.\n\nSet to 0 to disable (uses normal travel acceleration).",
      "sidetext": "mm/s²",
      "mode": "develop",
      "min": 0,
      "default": "250"
    },
    "initial_layer_travel_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Initial layer travel",
      "tooltip": "The acceleration of travel of initial layer",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "500"
    },
    "initial_layer_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Initial layer",
      "tooltip": "Acceleration of initial layer. Using a lower value can improve build plate adhensive",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "300"
    },
    "outer_wall_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Outer wall",
      "tooltip": "Acceleration of outer wall. Using a lower value can improve quality",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "500"
    },
    "inner_wall_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Inner wall",
      "tooltip": "Acceleration of inner walls. 0 means using normal printing acceleration",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "top_surface_acceleration": {
      "type": "float",
      "vector": true,
      "label": "Top surface",
      "tooltip": "Acceleration of top surface infill. Using a lower value may improve top surface quality",
      "sidetext": "mm/s²",
      "mode": "advanced",
      "min": 0,
      "default": "500"
    },
    "sparse_infill_acceleration": {
      "type": "string",
      "vector": true,
      "label": "Sparse infill",
      "tooltip": "Acceleration of sparse infill. If the value is expressed as a percentage (e.g. 100%), it will be calculated based on the default acceleration.",
      "sidetext": "mm/s² or %",
      "mode": "advanced",
      "min": 0
    },
    "accel_to_decel_enable": {
      "type": "bool",
      "label": "Enable accel_to_decel",
      "tooltip": "Klipper's max_accel_to_decel will be adjusted automatically",
      "mode": "advanced",
      "default": "0"
    },
    "accel_to_decel_factor": {
      "type": "percent",
      "label": "accel_to_decel",
      "tooltip": "Klipper's max_accel_to_decel will be adjusted to this percent of acceleration",
      "sidetext": "%",
      "mode": "advanced",
      "min": 1,
      "max": 100,
      "default": "50%"
    },
    "default_jerk": {
      "type": "float",
      "label": "Default",
      "tooltip": "Default jerk",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "outer_wall_jerk": {
      "type": "float",
      "label": "Outer wall",
      "tooltip": "Jerk of outer walls",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "9"
    },
    "inner_wall_jerk": {
      "type": "float",
      "label": "Inner wall",
      "tooltip": "Jerk of inner walls",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "9"
    },
    "infill_jerk": {
      "type": "float",
      "label": "Infill",
      "tooltip": "Jerk of infill",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "9"
    },
    "top_surface_jerk": {
      "type": "float",
      "label": "Top surface",
      "tooltip": "Jerk of top surface",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "9"
    },
    "initial_layer_jerk": {
      "type": "float",
      "label": "First layer",
      "tooltip": "Jerk of first layer",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "9"
    },
    "travel_jerk": {
      "type": "float",
      "label": "Travel",
      "tooltip": "Jerk of travel",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 0,
      "default": "9"
    },
    "enable_support": {
      "type": "bool",
      "label": "Enable support",
      "tooltip": "Enable support generation.",
      "category": "Support",
      "mode": "simple",
      "default": "0"
    },
    "support_type": {
      "type": "enum",
      "label": "Type",
      "tooltip": "normal(auto) and tree(auto) is used to generate support automatically. If normal(manual) or tree(manual) is selected, only support enforcers are generated",
      "category": "Support",
      "enumValues": [
        "normal(auto)",
        "tree(auto)",
        "normal(manual)",
        "tree(manual)"
      ],
      "enumLabels": [
        "normal(auto)",
        "tree(auto)",
        "normal(manual)",
        "tree(manual)"
      ],
      "mode": "simple",
      "default": "normal(auto)"
    },
    "support_style": {
      "type": "enum",
      "label": "Style",
      "tooltip": "Style and shape of the support. For normal support, projecting the supports into a regular grid will create more stable supports (default), while snug support towers will save material and reduce object scarring.\nFor tree support, slim style will merge branches more aggressively and save a lot of material, strong style will make larger and stronger support structure and use more materials, while hybrid style is the combination of slim tree and normal support with normal nodes under large flat overhangs. Organic style will produce more organic shaped tree structure and less interfaces which makes it easer to be removed. The default style is organic tree for most cases, and hybrid tree if adaptive layer height or soluble interface is enabled.",
      "category": "Support",
      "enumValues": [
        "default",
        "grid",
        "snug",
        "tree_slim",
        "tree_strong",
        "tree_hybrid",
        "tree_organic"
      ],
      "enumLabels": [
        "Default",
        "Grid",
        "Snug",
        "Tree Slim",
        "Tree Strong",
        "Tree Hybrid",
        "Tree Organic"
      ],
      "mode": "advanced",
      "default": "default"
    },
    "support_threshold_angle": {
      "type": "int",
      "label": "Threshold angle",
      "tooltip": "Support will be generated for overhangs whose slope angle is below the threshold.",
      "sidetext": "°",
      "category": "Support",
      "mode": "simple",
      "min": 1,
      "max": 90,
      "default": "30"
    },
    "support_on_build_plate_only": {
      "type": "bool",
      "label": "On build plate only",
      "tooltip": "Don't create support on model surface, only on build plate",
      "category": "Support",
      "mode": "simple",
      "default": "0"
    },
    "support_critical_regions_only": {
      "type": "bool",
      "label": "Support critical regions only",
      "tooltip": "Only create support for critical regions including sharp tail, cantilever, etc.",
      "category": "Support",
      "mode": "advanced",
      "default": "0"
    },
    "support_remove_small_overhang": {
      "type": "bool",
      "label": "Remove small overhangs",
      "tooltip": "Remove small overhangs that possibly need no supports.",
      "category": "Support",
      "mode": "advanced",
      "default": "1"
    },
    "raft_layers": {
      "type": "int",
      "label": "Raft layers",
      "tooltip": "Object will be raised by this number of support layers. Use this function to avoid warping when print ABS",
      "sidetext": "layers",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "raft_contact_distance": {
      "type": "float",
      "label": "Raft contact Z distance",
      "tooltip": "Z gap between object and raft. Ignored for soluble interface",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "default": "0.1"
    },
    "support_filament": {
      "type": "int",
      "label": "Support/raft base",
      "tooltip": "Filament to print support base and raft. \"Default\" means no specific filament for support and current filament is used",
      "category": "Support",
      "mode": "simple",
      "min": 0,
      "default": "0",
      "guiType": "i_enum_open"
    },
    "support_interface_filament": {
      "type": "int",
      "label": "Support/raft interface",
      "tooltip": "Filament to print support interface. \"Default\" means no specific filament for support interface and current filament is used",
      "category": "Support",
      "mode": "simple",
      "min": 0,
      "default": "0",
      "guiType": "i_enum_open"
    },
    "support_interface_not_for_body": {
      "type": "bool",
      "label": "Avoid interface filament for base",
      "tooltip": "Avoid using support interface filament to print support base if possible.",
      "category": "Support",
      "mode": "simple",
      "default": "1"
    },
    "enable_support_ironing": {
      "type": "bool",
      "label": "Enable ironing support interface",
      "tooltip": "Ironing is using small flow to print on same height of surface again to make flat surface more smooth. This setting controls whether support interface or raft interface will be ironned.Support ironing could only works on solid interface,that is, support_interface_spacing was zero and support_interface_pattern was't grid",
      "category": "Support",
      "mode": "develop",
      "default": "0"
    },
    "support_ironing_pattern": {
      "type": "enum",
      "label": "Support ironing pattern",
      "tooltip": "",
      "category": "Support",
      "enumValues": [
        "concentric",
        "zig-zag"
      ],
      "enumLabels": [
        "Concentric",
        "Rectilinear"
      ],
      "mode": "develop",
      "default": "zig-zag"
    },
    "support_ironing_speed": {
      "type": "float",
      "label": "Support ironing speed",
      "tooltip": "Print speed of ironing lines",
      "sidetext": "mm/s",
      "category": "Support",
      "mode": "develop",
      "min": 0,
      "default": "20"
    },
    "support_ironing_flow": {
      "type": "percent",
      "label": "Support ironing flow",
      "tooltip": "The amount of material to extrude during ironing. Relative to flow of normal layer height. Too high value results in overextrusion on the surface",
      "sidetext": "%",
      "category": "Support",
      "mode": "develop",
      "min": 0,
      "max": 100,
      "default": "10%"
    },
    "support_ironing_spacing": {
      "type": "float",
      "label": "Support ironing line spacing",
      "tooltip": "The distance between the lines of ironing",
      "sidetext": "mm",
      "category": "Support",
      "mode": "develop",
      "min": 0,
      "max": 1,
      "default": "0.1"
    },
    "support_ironing_inset": {
      "type": "float",
      "label": "Support ironing inset",
      "tooltip": "The distance to keep the from the edges of ironing line. 0 means not apply.",
      "sidetext": "mm",
      "category": "Support",
      "mode": "develop",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "support_ironing_direction": {
      "type": "float",
      "label": "Support ironing direction",
      "tooltip": "Angle for ironing, which controls the relative angle between the top surface and ironing",
      "sidetext": "°",
      "category": "Support",
      "mode": "develop",
      "min": 0,
      "max": 360,
      "default": "0"
    },
    "raft_first_layer_density": {
      "type": "percent",
      "label": "Initial layer density",
      "tooltip": "Density of the first raft or support layer",
      "sidetext": "%",
      "category": "Support",
      "mode": "advanced",
      "min": 10,
      "max": 100,
      "default": "90%"
    },
    "raft_first_layer_expansion": {
      "type": "float",
      "label": "Initial layer expansion",
      "tooltip": "Expand the first raft or support layer to improve bed plate adhesion, -1 means auto",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": -1,
      "default": "-1"
    },
    "tree_support_wall_count": {
      "type": "int",
      "label": "Support wall loops",
      "tooltip": "This setting specifies the count of support walls in the range of [-1,2]. -1 means auto, and 0 means allowing infill-only mode where support is thick enough.",
      "category": "Support",
      "mode": "advanced",
      "min": -1,
      "max": 2,
      "default": "-1"
    },
    "support_top_z_distance": {
      "type": "float",
      "label": "Top Z distance",
      "tooltip": "The z gap between the top support interface and object",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "default": "0.2"
    },
    "support_bottom_z_distance": {
      "type": "float",
      "label": "Bottom Z distance",
      "tooltip": "The z gap between the bottom support interface and object",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "default": "0.2"
    },
    "support_base_pattern": {
      "type": "enum",
      "label": "Base pattern",
      "tooltip": "Line pattern of support",
      "category": "Support",
      "enumValues": [
        "default",
        "rectilinear",
        "rectilinear-grid",
        "honeycomb",
        "lightning",
        "hollow"
      ],
      "enumLabels": [
        "Default",
        "Rectilinear",
        "Rectilinear grid",
        "Honeycomb",
        "Lightning",
        "Hollow"
      ],
      "mode": "advanced",
      "default": "default"
    },
    "support_base_pattern_spacing": {
      "type": "float",
      "label": "Base pattern spacing",
      "tooltip": "Spacing between support lines",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "default": "2.5"
    },
    "support_angle": {
      "type": "float",
      "label": "Pattern angle",
      "tooltip": "Use this setting to rotate the support pattern on the horizontal plane.",
      "sidetext": "°",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 359,
      "default": "0"
    },
    "support_interface_top_layers": {
      "type": "int",
      "label": "Top interface layers",
      "tooltip": "Number of top interface layers",
      "sidetext": "layers",
      "category": "Support",
      "enumValues": [
        "0",
        "1",
        "2",
        "3"
      ],
      "enumLabels": [
        "0",
        "1",
        "2",
        "3"
      ],
      "mode": "advanced",
      "min": 0,
      "default": "3",
      "guiType": "i_enum_open"
    },
    "support_interface_bottom_layers": {
      "type": "int",
      "label": "Bottom interface layers",
      "tooltip": "Number of bottom interface layers",
      "sidetext": "layers",
      "category": "Support",
      "enumValues": [
        "-1"
      ],
      "enumLabels": [
        "Same as top"
      ],
      "mode": "advanced",
      "min": -1,
      "default": "0",
      "guiType": "i_enum_open"
    },
    "support_interface_pattern": {
      "type": "enum",
      "label": "Interface pattern",
      "tooltip": "Line pattern of support interface. Default pattern for support interface is Rectilinear Interlaced",
      "category": "Support",
      "enumValues": [
        "auto",
        "rectilinear",
        "concentric",
        "rectilinear_interlaced",
        "grid"
      ],
      "enumLabels": [
        "Default",
        "Rectilinear",
        "Concentric",
        "Rectilinear Interlaced",
        "Grid"
      ],
      "mode": "advanced",
      "default": "auto"
    },
    "support_interface_spacing": {
      "type": "float",
      "label": "Top interface spacing",
      "tooltip": "Spacing of interface lines. Zero means solid interface.And zero spacing is required to access the enable_support_ironing option",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "default": "0.5"
    },
    "support_bottom_interface_spacing": {
      "type": "float",
      "label": "Bottom interface spacing",
      "tooltip": "Spacing of bottom interface lines. Zero means solid interface",
      "sidetext": "mm",
      "category": "Support",
      "mode": "develop",
      "min": 0,
      "default": "0.5"
    },
    "support_expansion": {
      "type": "float",
      "label": "Normal Support expansion",
      "tooltip": "Expand (+) or shrink (-) the horizontal span of normal support",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "default": "0"
    },
    "support_object_xy_distance": {
      "type": "float",
      "label": "Support/object xy distance",
      "tooltip": "XY separation between an object and its support",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 10,
      "default": "0.35"
    },
    "top_z_overrides_xy_distance": {
      "type": "bool",
      "label": "Z overrides X/Y",
      "tooltip": "When top z distance overrides support/object xy distance, give priority to ensuring that supports are generated beneath overhangs, and a gap of the same size as top z distance is leaved with the model. Whereas in the opposite case, the gap between supports and the model follows support/object xy distance all the time. Only recommended to enable when using HybridTree.",
      "category": "Support",
      "mode": "advanced",
      "default": "0"
    },
    "support_object_first_layer_gap": {
      "type": "float",
      "label": "Support/object first layer gap",
      "tooltip": "XY separation between an object and its support at the first layer.",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 10,
      "default": "0.2"
    },
    "bridge_no_support": {
      "type": "bool",
      "label": "Don't support bridges",
      "tooltip": "Don't support the whole bridge area which makes support very large. Bridge usually can be printing directly without support if not very long",
      "category": "Support",
      "mode": "advanced",
      "default": "0"
    },
    "max_bridge_length": {
      "type": "float",
      "label": "Max bridge length",
      "tooltip": "Max length of bridges that don't need support. Set it to 0 if you want all bridges to be supported, and set it to a very large value if you don't want any bridges to be supported.",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "default": "10"
    },
    "independent_support_layer_height": {
      "type": "bool",
      "label": "Independent support layer height",
      "tooltip": "Support layer uses layer height independent with object layer. This is to support customizing z-gap and save print time.This option will be invalid when the prime tower is enabled.",
      "category": "Support",
      "mode": "advanced",
      "default": "1"
    },
    "tree_support_branch_distance": {
      "type": "float",
      "label": "Branch distance",
      "tooltip": "This setting determines the distance between neighboring tree support nodes.",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 1,
      "max": 10,
      "default": "5"
    },
    "tree_support_branch_diameter": {
      "type": "float",
      "label": "Branch diameter",
      "tooltip": "This setting determines the initial diameter of support nodes.",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 1,
      "max": 10,
      "default": "5"
    },
    "tree_support_branch_angle": {
      "type": "float",
      "label": "Branch angle",
      "tooltip": "This setting determines the maximum overhang angle that t he branches of tree support allowed to make.If the angle is increased, the branches can be printed more horizontally, allowing them to reach farther.",
      "sidetext": "°",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 60,
      "default": "40"
    },
    "tree_support_branch_diameter_angle": {
      "type": "float",
      "label": "Branch diameter angle",
      "tooltip": "The angle of the branches' diameter as they gradually become thicker towards the bottom. An angle of 0 will cause the branches to have uniform thickness over their length. A bit of an angle can increase stability of the tree support.",
      "sidetext": "°",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 15,
      "default": "5"
    },
    "skirt_loops": {
      "type": "int",
      "label": "Skirt loops",
      "tooltip": "Number of loops for the skirt. Zero means disabling skirt",
      "mode": "simple",
      "min": 0,
      "max": 10,
      "default": "1"
    },
    "skirt_height": {
      "type": "int",
      "label": "Skirt height",
      "tooltip": "How many layers of skirt. Usually only one layer",
      "sidetext": "layers",
      "mode": "simple",
      "max": 10000,
      "default": "1"
    },
    "skirt_distance": {
      "type": "float",
      "label": "Skirt distance",
      "tooltip": "Distance from skirt to brim or object",
      "sidetext": "mm",
      "mode": "develop",
      "min": 0,
      "max": 55,
      "default": "2"
    },
    "brim_type": {
      "type": "enum",
      "label": "Brim type",
      "tooltip": "This controls the generation of the brim at outer and/or inner side of models. Auto means the brim width is analysed and calculated automatically.",
      "category": "Support",
      "enumValues": [
        "auto_brim",
        "brim_ears",
        "outer_only",
        "inner_only",
        "outer_and_inner",
        "no_brim"
      ],
      "enumLabels": [
        "Auto",
        "Painted",
        "Outer brim only",
        "Inner brim only",
        "Outer and inner brim",
        "No-brim"
      ],
      "mode": "simple",
      "default": "auto_brim"
    },
    "brim_width": {
      "type": "float",
      "label": "Brim width",
      "tooltip": "Distance from model to the outermost brim line",
      "sidetext": "mm",
      "category": "Support",
      "mode": "simple",
      "min": 0,
      "max": 100,
      "default": "0"
    },
    "brim_object_gap": {
      "type": "float",
      "label": "Brim-object gap",
      "tooltip": "A gap between innermost brim line and object can make brim be removed more easily",
      "sidetext": "mm",
      "category": "Support",
      "mode": "advanced",
      "min": 0,
      "max": 2,
      "default": "0"
    },
    "enable_prime_tower": {
      "type": "bool",
      "label": "Enable",
      "tooltip": "The wiping tower can be used to clean up the residue on the nozzle and stabilize the chamber pressure inside the nozzle, in order to avoid appearance defects when printing objects.",
      "mode": "simple",
      "default": "0"
    },
    "prime_tower_skip_points": {
      "type": "bool",
      "label": "Skip points",
      "tooltip": "The wall of prime tower will skip the start points of wipe path",
      "mode": "advanced",
      "default": "1"
    },
    "prime_tower_enable_framework": {
      "type": "bool",
      "label": "Internal ribs",
      "tooltip": "Enable internal ribs to increase the stability of the prime tower.",
      "mode": "advanced",
      "default": "0"
    },
    "prime_tower_width": {
      "type": "float",
      "label": "Width",
      "tooltip": "Width of prime tower",
      "sidetext": "mm",
      "mode": "simple",
      "min": 2,
      "default": "35"
    },
    "prime_tower_max_speed": {
      "type": "float",
      "label": "Max speed",
      "tooltip": "The maximum printing speed on the prime tower excluding ramming.",
      "sidetext": "mm/s",
      "mode": "advanced",
      "min": 10,
      "default": "90"
    },
    "prime_tower_brim_width": {
      "type": "float",
      "label": "Brim width",
      "tooltip": "Brim width of prime tower, negative number means auto calculated width based on the height of prime tower.",
      "sidetext": "mm",
      "enumValues": [
        "-1"
      ],
      "enumLabels": [
        "Auto"
      ],
      "mode": "advanced",
      "min": -1,
      "default": "3",
      "guiType": "f_enum_open"
    },
    "prime_tower_infill_gap": {
      "type": "percent",
      "label": "Infill gap",
      "tooltip": "Infill gap",
      "sidetext": "%",
      "mode": "advanced",
      "min": 100,
      "default": "150%"
    },
    "prime_tower_rib_wall": {
      "type": "bool",
      "label": "Rib wall",
      "tooltip": "The wall of prime tower will add four ribs and make its cross-section as close to a square as possible, so the width will be fixed.",
      "mode": "simple",
      "default": "1"
    },
    "prime_tower_extra_rib_length": {
      "type": "float",
      "label": "Extra rib length",
      "tooltip": "Positive values can increase the size of the rib wall, while negative values can reduce the size.However, the size of the rib wall can not be smaller than that determined by the cleaning volume.",
      "sidetext": "mm",
      "mode": "advanced",
      "max": 300,
      "default": "0"
    },
    "prime_tower_rib_width": {
      "type": "float",
      "label": "Rib width",
      "tooltip": "Rib width is always less than half the prime tower side length.",
      "sidetext": "mm",
      "mode": "advanced",
      "min": 0,
      "max": 300,
      "default": "8"
    },
    "prime_tower_fillet_wall": {
      "type": "bool",
      "label": "Fillet wall",
      "tooltip": "The wall of prime tower will fillet",
      "mode": "advanced",
      "default": "1"
    },
    "enable_tower_interface_features": {
      "type": "bool",
      "label": "Enable tower interface features",
      "tooltip": "When enabled, use dedicated temperature, pre-extrusion and purge settings for prime tower interface layers (where different materials meet), to improve multi-material tool change quality.",
      "mode": "develop",
      "default": "0"
    },
    "flush_into_infill": {
      "type": "bool",
      "label": "Flush into objects' infill",
      "tooltip": "Purging after filament change will be done inside objects' infills. This may lower the amount of waste and decrease the print time. If the walls are printed with transparent filament, the mixed color infill will be seen outside. It will not take effect, unless the prime tower is enabled.",
      "category": "Flush options",
      "mode": "simple",
      "default": "0"
    },
    "flush_into_objects": {
      "type": "bool",
      "label": "Flush into this object",
      "tooltip": "This object will be used to purge the nozzle after a filament change to save filament and decrease the print time. Colours of the objects will be mixed as a result. It will not take effect, unless the prime tower is enabled.",
      "category": "Flush options",
      "mode": "simple",
      "default": "0"
    },
    "flush_into_support": {
      "type": "bool",
      "label": "Flush into objects' support",
      "tooltip": "Purging after filament change will be done inside objects' support. This may lower the amount of waste and decrease the print time. It will not take effect, unless the prime tower is enabled.",
      "category": "Flush options",
      "mode": "simple",
      "default": "1"
    },
    "slicing_mode": {
      "type": "enum",
      "label": "Slicing Mode",
      "tooltip": "Use \"Even-odd\" for 3DLabPrint airplane models. Use \"Close holes\" to close all holes in the model.",
      "category": "Other",
      "enumValues": [
        "regular",
        "even_odd",
        "close_holes"
      ],
      "enumLabels": [
        "Regular",
        "Even-odd",
        "Close holes"
      ],
      "mode": "advanced",
      "default": "regular"
    },
    "print_sequence": {
      "type": "enum",
      "label": "Print sequence",
      "tooltip": "Print sequence, layer by layer or object by object",
      "enumValues": [
        "by layer",
        "by object"
      ],
      "enumLabels": [
        "By layer",
        "By object"
      ],
      "mode": "simple",
      "default": "by layer"
    },
    "spiral_mode": {
      "type": "bool",
      "label": "Spiral vase",
      "tooltip": "Spiralize smooths out the z moves of the outer contour. And turns a solid model into a single walled print with solid bottom layers. The final generated model has no seam",
      "mode": "simple",
      "default": "0"
    },
    "spiral_mode_smooth": {
      "type": "bool",
      "label": "Smooth Spiral",
      "tooltip": "Smooth Spiral smoothes out X and Y moves as wellresulting in no visible seam at all, even in the XY directions on walls that are not vertical",
      "mode": "simple",
      "default": "0"
    },
    "spiral_mode_max_xy_smoothing": {
      "type": "floatOrPercent",
      "label": "Max XY Smoothing",
      "tooltip": "Maximum distance to move points in XY to try to achieve a smooth spiralIf expressed as a %, it will be computed over nozzle diameter",
      "sidetext": "mm or %",
      "mode": "advanced",
      "min": 0,
      "max": 1000,
      "default": "200%"
    },
    "timelapse_type": {
      "type": "enum",
      "label": "Timelapse",
      "tooltip": "If smooth or traditional mode is selected, a timelapse video will be generated for each print. After each layer is printed, a snapshot is taken with the chamber camera. All of these snapshots are composed into a timelapse video when printing completes. If smooth mode is selected, the toolhead will move to the excess chute after each layer is printed and then take a snapshot. Since the melt filament may leak from the nozzle during the process of taking a snapshot, prime tower is required for smooth mode to wipe nozzle.",
      "enumValues": [
        "0",
        "1"
      ],
      "enumLabels": [
        "Traditional",
        "Smooth"
      ],
      "mode": "simple",
      "default": "0"
    },
    "fuzzy_skin": {
      "type": "enum",
      "label": "Fuzzy Skin",
      "tooltip": "Randomly jitter while printing the wall, so that the surface has a rough look. This setting controls the fuzzy position",
      "category": "Others",
      "enumValues": [
        "none",
        "external",
        "all",
        "allwalls",
        "disabled_fuzzy"
      ],
      "enumLabels": [
        "None(allow paint)",
        "Contour",
        "Contour and hole",
        "All walls",
        "Disabled"
      ],
      "mode": "simple",
      "default": "none"
    },
    "fuzzy_skin_mode": {
      "type": "enum",
      "label": "Fuzzy skin generator mode",
      "tooltip": "Displacement: Pattern is formed by shifting the nozzle sideways from the original path.\nExtrusion: Pattern is formed by varying the amount of extruded plastic (nozzle path stays straight).\nCombined: Displacement + Extrusion. Similar look to Displacement but fills gaps between perimeters.\nNote: Extrusion and Combined only work when fuzzy skin thickness is not greater than the printed line width.",
      "category": "Others",
      "enumValues": [
        "displacement",
        "extrusion",
        "combined"
      ],
      "enumLabels": [
        "Displacement",
        "Extrusion",
        "Combined"
      ],
      "mode": "simple",
      "default": "displacement"
    },
    "fuzzy_skin_noise_type": {
      "type": "enum",
      "label": "Fuzzy skin noise type",
      "tooltip": "Noise type to use for fuzzy skin generation:\nClassic: Classic uniform random noise.\nPerlin: Perlin noise, which gives a more consistent texture.\nBillow: Similar to perlin noise, but clumpier.\nRidged Multifractal: Ridged noise with sharp, jagged features. Creates marble-like textures.\nVoronoi: Divides the surface into voronoi cells, and displaces each one by a random amount. Creates a patchwork texture.",
      "category": "Others",
      "enumValues": [
        "classic",
        "perlin",
        "billow",
        "ridgedmulti",
        "voronoi"
      ],
      "enumLabels": [
        "Classic",
        "Perlin",
        "Billow",
        "Ridged Multifractal",
        "Voronoi"
      ],
      "mode": "simple",
      "default": "classic"
    },
    "fuzzy_skin_point_distance": {
      "type": "float",
      "label": "Fuzzy skin point distance",
      "tooltip": "The average distance between the random points introduced on each line segment",
      "sidetext": "mm",
      "category": "Others",
      "mode": "simple",
      "min": 0,
      "max": 5,
      "default": "0.8"
    },
    "fuzzy_skin_thickness": {
      "type": "float",
      "label": "Fuzzy skin thickness",
      "tooltip": "The width within which to jitter. It's adversed to be below outer wall line width",
      "sidetext": "mm",
      "category": "Others",
      "mode": "simple",
      "min": 0,
      "max": 1,
      "default": "0.3"
    },
    "fuzzy_skin_scale": {
      "type": "float",
      "label": "Fuzzy skin feature size",
      "tooltip": "The base size of the coherent noise features, in mm. Higher values will result in larger features.",
      "sidetext": "mm",
      "category": "Others",
      "mode": "advanced",
      "min": 0.1,
      "max": 500,
      "default": "1"
    },
    "fuzzy_skin_octaves": {
      "type": "int",
      "label": "Fuzzy skin noise octaves",
      "tooltip": "The number of octaves of coherent noise to use. Higher values increase the detail of the noise, but also increase computation time.",
      "category": "Others",
      "mode": "advanced",
      "min": 1,
      "max": 10,
      "default": "4"
    },
    "fuzzy_skin_persistence": {
      "type": "float",
      "label": "Fuzzy skin noise persistence",
      "tooltip": "The decay rate for higher octaves of the coherent noise. Lower values will result in smoother noise.",
      "category": "Others",
      "mode": "advanced",
      "min": 0.01,
      "max": 1,
      "default": "0.5"
    },
    "fuzzy_skin_first_layer": {
      "type": "bool",
      "label": "Apply fuzzy skin to first layer",
      "tooltip": "Whether to apply fuzzy skin on the first layer.",
      "category": "Others",
      "mode": "simple",
      "default": "0"
    },
    "enable_wrapping_detection": {
      "type": "bool",
      "label": "Enable clumping detection",
      "tooltip": "Enable clumping detection",
      "mode": "advanced",
      "default": "0"
    },
    "enable_order_independent_overlap_carving": {
      "type": "bool",
      "label": "Order-independent overlap carving",
      "tooltip": "When enabled, overlapping model parts are carved by bounding-box size so smaller embedded parts are not removed by larger parts due to volume order.",
      "mode": "develop",
      "default": "0"
    },
    "interlocking_beam": {
      "type": "bool",
      "label": "Use beam interlocking",
      "tooltip": "Generate interlocking beam structure at the locations where different filaments touch. This improves the adhesion between filaments, especially models printed in different materials.",
      "category": "Advanced",
      "mode": "advanced",
      "default": "0"
    },
    "mmu_segmented_region_interlocking_depth": {
      "type": "float",
      "label": "Interlocking depth of a segmented region",
      "tooltip": "Interlocking depth of a segmented region. Zero disables this feature.",
      "sidetext": "mm",
      "category": "Advanced",
      "mode": "advanced",
      "min": 0,
      "default": "0"
    },
    "interlocking_beam_width": {
      "type": "float",
      "label": "Interlocking beam width",
      "tooltip": "The width of the interlocking structure beams.",
      "sidetext": "mm",
      "category": "Advanced",
      "mode": "advanced",
      "min": 0.01,
      "default": "0.8"
    },
    "interlocking_orientation": {
      "type": "float",
      "label": "Interlocking direction",
      "tooltip": "Orientation of interlock beams.",
      "sidetext": "°",
      "category": "Advanced",
      "mode": "advanced",
      "min": 0,
      "max": 360,
      "default": "22.5"
    },
    "interlocking_beam_layer_count": {
      "type": "int",
      "label": "Interlocking beam layers",
      "tooltip": "The height of the beams of the interlocking structure, measured in number of layers. Less layers is stronger, but more prone to defects.",
      "category": "Advanced",
      "mode": "advanced",
      "min": 1,
      "default": "2"
    },
    "interlocking_depth": {
      "type": "int",
      "label": "Interlocking depth",
      "tooltip": "The distance from the boundary between filaments to generate interlocking structure, measured in cells. Too few cells will result in poor adhesion.",
      "category": "Advanced",
      "mode": "advanced",
      "min": 1,
      "default": "2"
    },
    "interlocking_boundary_avoidance": {
      "type": "int",
      "label": "Interlocking boundary avoidance",
      "tooltip": "The distance from the outside of a model where interlocking structures will not be generated, measured in cells.",
      "category": "Advanced",
      "mode": "advanced",
      "min": 0,
      "default": "2"
    },
    "sparse_infill_filament": {
      "type": "int",
      "label": "Sparse infill filament",
      "tooltip": "Filament to print internal sparse infill.",
      "category": "Extruders",
      "mode": "develop",
      "min": 0,
      "default": "0",
      "guiType": "i_enum_open"
    },
    "solid_infill_filament": {
      "type": "int",
      "label": "Solid infill filament",
      "tooltip": "Filament to print solid infill",
      "category": "Extruders",
      "mode": "develop",
      "min": 0,
      "default": "0",
      "guiType": "i_enum_open"
    },
    "wall_filament": {
      "type": "int",
      "label": "Walls filament",
      "tooltip": "Filament to print walls",
      "category": "Extruders",
      "mode": "develop",
      "min": 0,
      "default": "0",
      "guiType": "i_enum_open"
    },
    "reduce_infill_retraction_mode": {
      "type": "enum",
      "label": "Reduce infill retraction",
      "tooltip": "Controls whether retraction is skipped when traveling within the infill area. \"Auto\" enables this optimization for filaments with low metal stickiness (e.g. PLA) and disables it for medium/high metal stickiness filaments (e.g. PETG) to avoid oozing artifacts. \"Enabled\" always skips retraction in infill areas regardless of filament type. \"Disabled\" always retracts normally.",
      "enumValues": [
        "Disabled",
        "Auto",
        "Enabled"
      ],
      "enumLabels": [
        "Disabled",
        "Auto",
        "Enabled"
      ],
      "mode": "advanced",
      "default": "Auto"
    },
    "gcode_add_line_number": {
      "type": "bool",
      "label": "Add line number",
      "tooltip": "Enable this to add line number(Nx) at the beginning of each G-Code line",
      "mode": "develop",
      "default": "0"
    },
    "exclude_object": {
      "type": "bool",
      "label": "Exclude objects",
      "tooltip": "Enable this option to add EXCLUDE OBJECT command in g-code for klipper firmware printer",
      "mode": "advanced",
      "default": "1"
    },
    "filename_format": {
      "type": "string",
      "label": "Filename format",
      "tooltip": "User can self-define the project file name when export",
      "mode": "develop",
      "fullWidth": true,
      "default": "[input_filename_base].gcode"
    },
    "post_process": {
      "type": "string",
      "vector": true,
      "label": "Post-processing Scripts",
      "tooltip": "If you want to process the output G-code through custom scripts, just list their absolute paths here. Separate multiple scripts with a semicolon. Scripts will be passed the absolute path to the G-code file as the first argument, and variables of settings also can be read",
      "mode": "advanced",
      "fullWidth": true,
      "height": 15,
      "isCode": true
    },
    "process_notes": {
      "type": "string",
      "label": "Process notes",
      "tooltip": "You can put your notes regarding the process here.",
      "mode": "advanced",
      "fullWidth": true,
      "height": 25,
      "default": ""
    }
  }
}
