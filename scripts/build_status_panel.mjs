import { writeFileSync } from "node:fs";

// Keep vanilla collections and callbacks; only this exact modal uses a fixed footer.
const positionTitle = "状态条位置（仅自己）";
const visibleFor = (position) => [
  { binding_name: "#title_text" },
  { binding_type: "view", source_property_name: position
    ? `(#title_text = '${positionTitle}')` : `(not (#title_text = '${positionTitle}'))`,
  target_property_name: "#visible" }
];
const form = {
  namespace: "server_form",
  "custom_form@common_dialogs.main_panel_no_buttons": {
    "$child_control": "server_form.ot_survival_custom_form_router"
  },
  ot_survival_custom_form_router: {
    type: "panel", size: ["100%", "100%"],
    controls: [
      { "ordinary@server_form.custom_form_panel": { bindings: visibleFor(false) } },
      { "positions@server_form.ot_survival_positions": { bindings: visibleFor(true) } }
    ]
  },
  ot_survival_positions: {
    type: "panel", size: ["100%", "100%"],
    controls: [
      { "sliders@common.scrolling_panel": {
        anchor_from: "top_left", anchor_to: "top_left",
        size: ["100%", "100% - 76px"],
        "$show_background": false,
        "$scrolling_content": "server_form.ot_survival_position_sliders",
        "$scroll_size": [5, "100% - 4px"],
        "$scrolling_pane_size": ["100% - 4px", "100% - 2px"],
        "$scrolling_pane_offset": [2, 0],
        "$scroll_bar_right_padding_size": [0, 0]
      } },
      { "footer@server_form.ot_survival_position_footer": {} }
    ]
  },
  ot_survival_position_sliders: {
    type: "stack_panel", orientation: "vertical",
    size: ["100% - 4px", "100%c"], offset: [2, 0],
    anchor_from: "top_left", anchor_to: "top_left",
    collection_name: "custom_form",
    controls: Array.from({ length: 6 }, (_, index) => ({
      [`slider_${index}@server_form.custom_slider`]: { collection_index: index }
    }))
  },
  ot_survival_position_footer: {
    type: "stack_panel", orientation: "vertical",
    size: ["100% - 8px", 72],
    anchor_from: "bottom_middle", anchor_to: "bottom_middle",
    collection_name: "custom_form",
    controls: [
      { "reset@server_form.custom_toggle": { collection_index: 6, size: ["100%", 32] } },
      { gap: { type: "panel", size: ["100%", 4] } },
      { "save@common_buttons.light_text_button": {
        "$pressed_button_name": "button.submit_custom_form",
        size: ["100%", 32],
        "$button_text": "#submit_text",
        "$button_text_binding_type": "global",
        "$button_binding_condition": "once",
        "$button_image_color": [0.46, 0.85, 0.38],
        "$default_text_color": [1, 1, 1],
        "$hover_text_color": [1, 1, 1],
        "$pressed_text_color": [1, 1, 1],
        bindings: [{ binding_name: "#submit_button_visible", binding_name_override: "#visible" }]
      } }
    ]
  }
};
for (const file of [
  "pack/ot_survival_status/ot_survival_resource/ui/server_form.json",
  "pack/ot_survival_status_compat/ot_survival_resource_compat/ui/server_form.json"
]) writeFileSync(new URL(`../${file}`, import.meta.url), `${JSON.stringify(form, null, 2)}\n`);
