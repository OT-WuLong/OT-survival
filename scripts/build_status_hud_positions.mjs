import { readFileSync, writeFileSync } from "node:fs";
import { HUD_SLIDERS } from "../pack/ot_survival_status/ot_survival_behavior/scripts/hud_positions.js";

const files = [
  "pack/ot_survival_status/ot_survival_resource/ui/hud_screen.json",
  "pack/ot_survival_status_compat/ot_survival_resource_compat/ui/hud_screen.json"
];
const sliderFor = (token) => HUD_SLIDERS.find((slider) => slider.token === token);
const unclipped = { clips_children: false, allow_clipping: false };
const anchored = { anchor_from: "bottom_middle", anchor_to: "bottom_middle" };
const centered = { anchor_from: "center", anchor_to: "center" };

function spacers(token, horizontal, negative) {
  const slider = sliderFor(token);
  return Array.from({ length: Math.ceil(Math.log2(slider.limit + 1)) }, (_, bit) => {
    const signAbsent = `((#preserved_text - '!${token}.-|') = #preserved_text)`;
    return { [`padding_${token}_${negative ? "negative" : "positive"}_${bit}`]: {
      type: "panel", ...unclipped,
      size: horizontal ? [2 * 2 ** bit, 1] : [1, 2 * 2 ** bit],
      bindings: [{
        binding_type: "view", source_control_name: "ot_position_data",
        source_property_name: `((not ((#preserved_text - '!${token}.${bit}|') = #preserved_text)) and ${negative ? `(not ${signAbsent})` : signAbsent})`,
        target_property_name: "#visible"
      }]
    } };
  });
}

function positions(indicator, x, y, xToken, yToken) {
  const gaugeAnchor = {
    type: "panel", size: [1, 1], ...unclipped,
    controls: [{ [`indicator@hud.${indicator}`]: {} }]
  };
  // Zero collapses to a 1x1 anchor at the base; there is no bias to cancel.
  // Centered stacks translate by (before - after) / 2. Double each bit's size
  // so a saved UI unit is exactly one unit, with one copy of each display.
  // The actual touch/Pocket HUD can differ from the static UI-profile variable.
  // Add only an empty 20px spacer: centered layout makes that a 10px translation.
  const mobilePadding = { mobile_padding: {
    type: "panel", size: [20, 1], ...unclipped,
    bindings: [
      { binding_type: "global", binding_name: "#hud_visible_not_centered" },
      { binding_type: "global", binding_name: "#hud_visible_centered_touch" },
      { binding_type: "view", source_property_name: "(#hud_visible_not_centered or #hud_visible_centered_touch)",
        target_property_name: "#visible" }
    ]
  } };
  const horizontal = xToken ? {
    type: "stack_panel", orientation: "horizontal", size: ["100%c", 1],
    ...centered, ...unclipped,
    controls: [
      ...spacers(xToken, true, false),
      ...(x > 0 ? [mobilePadding] : []),
      { gauge_anchor: gaugeAnchor },
      ...(x < 0 ? [mobilePadding] : []),
      ...spacers(xToken, true, true)
    ]
  } : null;
  // Use the same outer vertical stack as the working temperature/thirst controls.
  // A fixed-size plain panel isolates X sizing from Y sizing; never put the
  // variable-height Y stack in a fixed-height horizontal stack again.
  const layout = {
    type: "stack_panel", orientation: "vertical", size: [1, "100%c"],
    ...centered, ...unclipped,
    controls: [
      ...spacers(yToken, false, false),
      { display_anchor: horizontal ? {
        type: "panel", size: [1, 1], ...unclipped,
        controls: [{ horizontal }]
      } : gaugeAnchor },
      ...spacers(yToken, false, true)
    ]
  };
  layout.offset = [0, 0];
  return {
    type: "panel", size: [1, 1], offset: "$ot_base_offset",
    "$ot_base_offset|default": [x, y],
    ...anchored, ...unclipped,
    controls: [{ layout }]
  };
}

for (const file of files) {
  const path = new URL(`../${file}`, import.meta.url);
  const ui = JSON.parse(readFileSync(path, "utf8"));
  // All four displays and their spacers read this one retained title message.
  ui.ot_position_data = {
    type: "panel", size: [0, 0], bindings: [
      { binding_name: "#hud_title_text_string", binding_type: "global" },
      { binding_name: "#hud_title_text_string", binding_name_override: "#preserved_text",
        binding_type: "global", binding_condition: "visibility_changed" },
      { binding_type: "view",
        source_property_name: "(not (#hud_title_text_string = #preserved_text) and not ((#hud_title_text_string - 'OT_STATUS') = #hud_title_text_string))",
        target_property_name: "#visible" }
    ]
  };
  ui.ot_stamina_position = positions("ot_stamina_probe", -95, -1, "A", "B");
  ui.ot_sanity_position = positions("ot_sanity_probe", 95, -1, "C", "D");
  ui.ot_thermal_position = positions("ot_thermal_probe", 0, -32, null, "E");
  ui.ot_thirst_position = positions("ot_thirst_probe", 0, -32, null, "F");
  ui.root_panel.modifications[0].value = [
    { "ot_position_data@hud.ot_position_data": {} },
    { "ot_stamina_position@hud.ot_stamina_position": {} },
    { "ot_thirst_position@hud.ot_thirst_position": {} },
    { "ot_thermal_position@hud.ot_thermal_position": {} },
    { "ot_sanity_position@hud.ot_sanity_position": {} }
  ];
  writeFileSync(path, `${JSON.stringify(ui, null, 2)}\n`);
}
